import { create } from 'zustand'
import { dirName, resolvePath, type FsEntry, type NanovmFS } from './fs.js'
import { GIT_VERSION, runGit } from './git.js'
import { NODE_VERSION, runNode } from './nodeRuntime.js'
import { nanoVMConfig } from './config.js'
import type {
  ToolchainCategory,
  ToolchainHost,
  ToolchainId,
  ToolchainIO,
  ToolchainState,
} from './types.js'
import type { RuntimeModule } from './runtimes/types.js'

/**
 * 按需工具链注册表。
 *
 * busybox 自带的那套命令不依赖任何运行时；这里的运行时只在用户或模型真正用到
 * 的时候才加载：
 *
 * - python 从 CDN 下载 Pyodide（约 12MB）；
 * - lua / sqlite / esbuild 分别从 CDN 加载 wasmoon、sql.js、esbuild-wasm；
 * - node / git / make 是纯浏览器实现，安装只是「启用」而已。
 *
 * 新增运行时只需要两步：在 META 里登记，在 RUNTIMES 里挂上动态 import。
 * 安装状态只存 localStorage（`chat-demo:nanovm-packages`），文件仍然都在虚拟文件
 * 系统里；Pyodide 的产物额外放一份到 Cache Storage，下次安装能少下载一点。
 */

const STORAGE_KEY = 'chat-demo:nanovm-packages'
const PYODIDE_VERSION = '0.26.4'

/** Pyodide 官方 CDN：运行时按需从这下载 */
export const PYODIDE_BASE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/'

/** Pyodide 的 ES 模块入口，用动态 import 加载，rspack 不会把它打进 bundle */
export const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.mjs'

/** 工具链展示顺序：控制台与 `vm list` 都按这个顺序排版 */
export const TOOLCHAIN_IDS: ToolchainId[] = [
  'python',
  'node',
  'lua',
  'sqlite',
  'esbuild',
  'make',
  'git',
]

/** 不需要下载、默认启用的运行时（可以 `vm uninstall` 关掉） */
const BUNDLED: ToolchainId[] = ['node', 'git', 'make']

/** 单次同步进 Pyodide / Worker 的内容上限，避免把整块磁盘搬来搬去 */
const SYNC_LIMIT_BYTES = 16 * 1024 * 1024

/** Pyodide 大文件，下载后放进 Cache Storage */
const PYODIDE_WASM_FILE = 'pyodide.asm.wasm'
const PYODIDE_STDLIB_FILE = 'python_stdlib.zip'
const CACHE_NAME = 'nanovm-pyodide-cache'

type Meta = {
  label: string
  summary: string
  sizeMB: number
  version: string
  category: ToolchainCategory
  /** 装好之后给用户的第一条示例命令 */
  hint: string
}

const META: Record<ToolchainId, Meta> = {
  python: {
    label: 'Python 3',
    summary: 'Pyodide 版 CPython，首次使用按需下载',
    sizeMB: 12,
    version: '',
    category: 'runtime',
    hint: 'python3 script.py',
  },
  node: {
    label: 'Node.js',
    summary: '浏览器内置的 JS 运行时，无需下载',
    sizeMB: 0,
    version: `v${NODE_VERSION}`,
    category: 'runtime',
    hint: 'node script.js',
  },
  lua: {
    label: 'Lua 5.4',
    summary: 'wasmoon 版 Lua，脚本与 REPL 都能跑，按需下载',
    sizeMB: 0.4,
    version: '5.4',
    category: 'runtime',
    hint: 'lua script.lua',
  },
  sqlite: {
    label: 'SQLite 3',
    summary: 'sql.js 版 SQLite，直接读写虚拟机里的 .db 文件',
    sizeMB: 1.3,
    version: '3.x',
    category: 'runtime',
    hint: 'sqlite3 app.db "create table t(id integer);"',
  },
  esbuild: {
    label: 'esbuild',
    summary: '浏览器里的 esbuild-wasm，打包 / 转译 TS 与 JS',
    sizeMB: 12,
    version: '0.25',
    category: 'build',
    hint: 'esbuild main.ts --bundle --outfile=bundle.js',
  },
  make: {
    label: 'GNU make',
    summary: '内置 Makefile 构建器，无需下载',
    sizeMB: 0,
    version: '4.x 兼容',
    category: 'build',
    hint: 'make',
  },
  git: {
    label: 'Git',
    summary: '内置 git 实现（对象格式与真 git 一致），无需下载',
    sizeMB: 0,
    version: GIT_VERSION,
    category: 'tool',
    hint: 'git status',
  },
}

const TOOLCHAIN_SET = new Set<string>(TOOLCHAIN_IDS)

export const isToolchainId = (value: string): value is ToolchainId => TOOLCHAIN_SET.has(value)

/** 控制台分组顺序 */
export const TOOLCHAIN_CATEGORIES: ToolchainCategory[] = ['runtime', 'build', 'tool']

/** 某分组下的工具链，按 TOOLCHAIN_IDS 的顺序 */
export const toolchainIdsByCategory = (category: ToolchainCategory): ToolchainId[] =>
  TOOLCHAIN_IDS.filter((id) => META[id].category === category)

/** 工具链一句话说明（控制台卡片用） */
export const toolchainSummary = (id: ToolchainId): string => META[id].summary

/** 装好之后给用户的第一条示例命令 */
export const toolchainHint = (id: ToolchainId): string => META[id].hint

// ---------- 运行时模块（动态 import：没装过就不进首屏包） ----------

/**
 * 用 RuntimeModule 接口实现的工具链。python / node / git 有自己的历史实现，
 * 不走这张表；新增运行时在 META 登记之后在这里挂上动态 import 即可。
 */
const RUNTIMES: Partial<Record<ToolchainId, () => Promise<RuntimeModule>>> = {
  lua: () => import('./runtimes/lua.js').then((module) => module.luaRuntime),
  sqlite: () => import('./runtimes/sqlite.js').then((module) => module.sqliteRuntime),
  esbuild: () => import('./runtimes/esbuild.js').then((module) => module.esbuildRuntime),
}

const runtimeCache = new Map<ToolchainId, Promise<RuntimeModule>>()

/** 取运行时模块；没有对应模块（内置运行时）返回 null */
const runtimeOf = async (id: ToolchainId): Promise<RuntimeModule | null> => {
  const loader = RUNTIMES[id]
  if (!loader) {
    return null
  }
  const cached = runtimeCache.get(id)
  if (cached) {
    return cached
  }
  const pending = loader()
  runtimeCache.set(id, pending)
  try {
    return await pending
  } catch (error) {
    runtimeCache.delete(id)
    throw error
  }
}

// ---------- 安装状态 ----------

type StoredEntry = {
  /** 已安装时的版本号 */
  version?: string
  installedAt?: number
  /** 用户主动卸载过（内置运行时靠它避免下次启动又被启用） */
  removed?: boolean
}

type StoredPackages = Partial<Record<ToolchainId, StoredEntry>>

export type PackagesStore = {
  states: Record<ToolchainId, ToolchainState>
  /** 正在安装的工具链 */
  busy: ToolchainId | null
  /** 是否已从存储里恢复安装状态（同步恢复，恒为 true） */
  ready: boolean
}

const emptyState = (id: ToolchainId): ToolchainState => ({
  id,
  label: META[id].label,
  summary: META[id].summary,
  installed: false,
  sizeMB: META[id].sizeMB,
  category: META[id].category,
})

const readStored = (): StoredPackages => {
  try {
    if (typeof localStorage === 'undefined') {
      return {}
    }
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    const source = parsed as Record<string, unknown>
    const out: StoredPackages = {}
    for (const id of TOOLCHAIN_IDS) {
      const entry = source[id]
      if (typeof entry !== 'object' || entry === null) {
        continue
      }
      const record = entry as StoredEntry
      out[id] = {
        version: typeof record.version === 'string' ? record.version : undefined,
        installedAt: typeof record.installedAt === 'number' ? record.installedAt : undefined,
        removed: record.removed === true,
      }
    }
    return out
  } catch {
    return {}
  }
}

const writeStored = (states: Record<ToolchainId, ToolchainState>) => {
  const out: StoredPackages = {}
  for (const id of TOOLCHAIN_IDS) {
    const state = states[id]
    if (state.installed) {
      out[id] = { version: state.version, installedAt: Date.now() }
    } else if (BUNDLED.includes(id)) {
      // 内置运行时被卸载过：记下来，下次启动不要自动启用
      out[id] = { removed: true }
    }
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out))
    }
  } catch {
    // 隐私模式写不进去也不影响本次会话
  }
}

/** 由存储 + 内置默认值算出初始状态 */
const initialState = (id: ToolchainId, stored: StoredPackages): ToolchainState => {
  const state = emptyState(id)
  const entry = stored[id]
  if (entry?.version && entry.removed !== true) {
    return { ...state, installed: true, version: entry.version }
  }
  if (BUNDLED.includes(id) && entry?.removed !== true) {
    return { ...state, installed: true, version: META[id].version }
  }
  return state
}

const initialStates = (): Record<ToolchainId, ToolchainState> => {
  const stored = readStored()
  const out = {} as Record<ToolchainId, ToolchainState>
  for (const id of TOOLCHAIN_IDS) {
    out[id] = initialState(id, stored)
  }
  return out
}

export const usePackages = create<PackagesStore>(() => ({
  states: initialStates(),
  busy: null,
  ready: true,
}))

const patchState = (id: ToolchainId, patch: Partial<ToolchainState>) => {
  usePackages.setState((state) => ({
    states: { ...state.states, [id]: { ...state.states[id], ...patch } },
  }))
}

/** 恢复安装状态：初始化时已经同步读过存储，这里主要是给 UI 一个 await 的入口 */
export const hydratePackages = async (): Promise<void> => {
  const stored = readStored()
  const states = usePackages.getState().states
  for (const id of TOOLCHAIN_IDS) {
    if (states[id].installed) {
      continue
    }
    const next = initialState(id, stored)
    if (next.installed) {
      patchState(id, { installed: true, version: next.version })
    }
  }
  usePackages.setState({ ready: true })
}

const stateOf = (id: ToolchainId): ToolchainState => usePackages.getState().states[id]

export const toolchainSizeMB = (id: ToolchainId): number => META[id].sizeMB

// ---------- Python（Pyodide） ----------

/** Pyodide 的 FS 子集，够我们同步文件就行 */
type PyodideFs = {
  mkdirTree?: (path: string) => void
  writeFile: (path: string, data: Uint8Array) => void
  readFile: (path: string) => Uint8Array
  readdir: (path: string) => string[]
  stat: (path: string) => { mode: number }
  isDir?: (mode: number) => boolean
}

type PyodideLike = {
  version?: string
  FS: PyodideFs
  globals: { get: (name: string) => unknown }
  runPython: (code: string) => unknown
  setStdout: (options: { batched?: (text: string) => void }) => void
  setStderr: (options: { batched?: (text: string) => void }) => void
  setStdin?: (options: { stdin: () => string | null }) => void
}

type PyodideModule = {
  loadPyodide: (options: { indexURL: string }) => Promise<PyodideLike>
}

type PythonRuntime = {
  pyodide: PyodideLike
  version: string
}

let pythonRuntime: PythonRuntime | null = null
let pythonLoading: Promise<PythonRuntime> | null = null

let pyodideBase = PYODIDE_BASE_URL
let pyodideModuleUrl = PYODIDE_URL

/**
 * 允许把 Pyodide 换到自建镜像 / 本地目录（离线部署、内网环境用）。
 * 传 null 恢复官方 CDN。
 */
export const setPyodideMirror = (base: string | null) => {
  pyodideBase = base ? (base.endsWith('/') ? base : `${base}/`) : PYODIDE_BASE_URL
  pyodideModuleUrl = `${pyodideBase}pyodide.mjs`
  pythonRuntime = null
  pythonLoading = null
}

/** 当前使用的 Pyodide indexURL */
export const pyodideIndexURL = (): string => pyodideBase

/**
 * 远程 ESM 只能靠原生 import 加载：`new Function` 里的 import 不会被 rspack 打包，
 * 所以 Pyodide 主模块永远不进入 bundle。
 */
const importRemote = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const cacheStorage = (): CacheStorage | null => {
  try {
    return typeof caches === 'undefined' ? null : caches
  } catch {
    return null
  }
}

const readCachedBytes = async (url: string): Promise<Uint8Array | null> => {
  const storage = cacheStorage()
  if (!storage) {
    return null
  }
  try {
    const cache = await storage.open(CACHE_NAME)
    const response = await cache.match(url)
    return response ? new Uint8Array(await response.arrayBuffer()) : null
  } catch {
    return null
  }
}

const writeCachedBytes = async (url: string, bytes: Uint8Array): Promise<void> => {
  const storage = cacheStorage()
  if (!storage) {
    return
  }
  try {
    const cache = await storage.open(CACHE_NAME)
    await cache.put(url, new Response(toArrayBuffer(bytes)))
  } catch {
    // 缓存失败不影响安装
  }
}

/** 带进度的下载：拿不到 content-length 时只报「还在下载」 */
const downloadWithProgress = async (
  url: string,
  onProgress: (fraction: number) => void
): Promise<Uint8Array | null> => {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      return null
    }
    const total = Number(response.headers.get('content-length') ?? 0)
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      onProgress(1)
      return bytes
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      chunks.push(chunk.value)
      received += chunk.value.byteLength
      if (total > 0) {
        onProgress(Math.min(0.99, received / total))
      }
    }
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    onProgress(1)
    return bytes
  } catch {
    return null
  }
}

/**
 * 安装 Pyodide 期间把已经下好的大文件就地喂给 loadPyodide，
 * 避免「预下载一遍 + 再下载一遍」。只拦截我们自己缓存的 URL，其余请求原样放行。
 */
const serveCachedFetch = (entries: Map<string, Uint8Array>): (() => void) => {
  const original = globalThis.fetch
  if (entries.size === 0) {
    return () => undefined
  }
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const bytes = entries.get(url)
    if (!bytes) {
      return original(input, init)
    }
    return new Response(toArrayBuffer(bytes), {
      status: 200,
      headers: {
        'content-type': url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
      },
    })
  }
  globalThis.fetch = patched as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

const detectPythonVersion = (pyodide: PyodideLike): string => {
  try {
    const version = pyodide.runPython('import sys\nsys.version.split()[0]')
    return typeof version === 'string' && version ? version : META.python.label
  } catch {
    return META.python.label
  }
}

const loadPythonRuntime = async (
  onProgress: (fraction: number) => void
): Promise<PythonRuntime> => {
  if (pythonRuntime) {
    onProgress(1)
    return pythonRuntime
  }
  if (pythonLoading) {
    return pythonLoading
  }
  const pending = (async (): Promise<PythonRuntime> => {
    const wasmUrl = `${pyodideBase}${PYODIDE_WASM_FILE}`
    const stdlibUrl = `${pyodideBase}${PYODIDE_STDLIB_FILE}`
    const cached = new Map<string, Uint8Array>()

    onProgress(0.02)
    let wasm = await readCachedBytes(wasmUrl)
    if (wasm) {
      cached.set(wasmUrl, wasm)
      onProgress(0.55)
    } else {
      wasm = await downloadWithProgress(wasmUrl, (fraction) => onProgress(0.03 + fraction * 0.55))
      if (wasm) {
        cached.set(wasmUrl, wasm)
        await writeCachedBytes(wasmUrl, wasm)
      }
    }

    let stdlib = await readCachedBytes(stdlibUrl)
    if (stdlib) {
      cached.set(stdlibUrl, stdlib)
      onProgress(0.72)
    } else {
      stdlib = await downloadWithProgress(stdlibUrl, (fraction) =>
        onProgress(0.6 + fraction * 0.15)
      )
      if (stdlib) {
        cached.set(stdlibUrl, stdlib)
        await writeCachedBytes(stdlibUrl, stdlib)
      }
    }
    onProgress(0.8)

    const restoreFetch = serveCachedFetch(cached)
    try {
      const module = (await importRemote(pyodideModuleUrl)) as PyodideModule
      onProgress(0.86)
      const pyodide = await module.loadPyodide({ indexURL: pyodideBase })
      onProgress(0.96)
      const version = detectPythonVersion(pyodide)
      const runtime: PythonRuntime = { pyodide, version }
      pythonRuntime = runtime
      onProgress(1)
      return runtime
    } finally {
      restoreFetch()
    }
  })()
  pythonLoading = pending
  try {
    return await pending
  } finally {
    pythonLoading = null
  }
}

const pythonVersionLabel = (): string => {
  const version = stateOf('python').version
  return version || `3.x（Pyodide ${PYODIDE_VERSION}）`
}

/** 需要同步进 Pyodide 的 VFS 目录 */
const pythonRoots = (io: ToolchainIO, script: string | null): string[] => {
  const roots = new Set<string>(['/home/user', '/tmp'])
  if (io.cwd && io.cwd !== '/') {
    roots.add(io.cwd)
  }
  if (script) {
    roots.add(dirName(script))
  }
  return [...roots]
}

const collectFiles = (
  fs: NanovmFS,
  roots: string[],
  limit: number
): { files: Map<string, Uint8Array>; skipped: number } => {
  const files = new Map<string, Uint8Array>()
  let skipped = 0
  let total = 0
  for (const root of roots) {
    const stat = fs.stat(root)
    if (!stat) {
      continue
    }
    const entries: FsEntry[] = stat.kind === 'dir' ? fs.walk(root) : [stat]
    for (const entry of entries) {
      if (entry.kind !== 'file' || files.has(entry.path)) {
        continue
      }
      if (total + entry.size > limit) {
        skipped += 1
        continue
      }
      let bytes: Uint8Array | null = null
      try {
        bytes = fs.read(entry.path)
      } catch {
        bytes = null
      }
      if (!bytes) {
        continue
      }
      files.set(entry.path, bytes)
      total += bytes.byteLength
    }
  }
  return { files, skipped }
}

const isPythonDir = (fs: PyodideFs, path: string): boolean => {
  try {
    const stat = fs.stat(path)
    if (typeof fs.isDir === 'function') {
      return fs.isDir(stat.mode)
    }
    return (stat.mode & 0o170000) === 0o040000
  } catch {
    return false
  }
}

/** 列出 Pyodide FS 里某个目录下的所有文件 */
const readPyodideTree = (fs: PyodideFs, roots: string[]): Map<string, Uint8Array> => {
  const files = new Map<string, Uint8Array>()
  const visit = (path: string) => {
    let names: string[] = []
    try {
      names = fs.readdir(path)
    } catch {
      return
    }
    for (const name of names) {
      if (name === '.' || name === '..') {
        continue
      }
      const child = path === '/' ? `/${name}` : `${path}/${name}`
      if (isPythonDir(fs, child)) {
        visit(child)
        continue
      }
      try {
        files.set(child, new Uint8Array(fs.readFile(child)))
      } catch {
        // 单个文件读不出来就跳过
      }
    }
  }
  for (const root of roots) {
    if (isPythonDir(fs, root)) {
      visit(root)
    }
  }
  return files
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) {
    return false
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }
  return true
}

const syncIntoPyodide = (fs: PyodideFs, files: Map<string, Uint8Array>) => {
  for (const [path, bytes] of files) {
    const parent = dirName(path)
    try {
      fs.mkdirTree?.(parent)
    } catch {
      // 目录已存在
    }
    try {
      fs.writeFile(path, bytes)
    } catch {
      // 写不进去（只读目录等）时跳过
    }
  }
}

/** 把 Pyodide FS 里改动过的文件写回 VFS */
const syncBackFromPyodide = (
  fs: NanovmFS,
  before: Map<string, Uint8Array>,
  roots: string[],
  pyodideFs: PyodideFs
) => {
  const after = readPyodideTree(pyodideFs, roots)
  for (const [path, bytes] of after) {
    const previous = before.get(path)
    if (previous && equalBytes(previous, bytes)) {
      continue
    }
    try {
      fs.mkdir(dirName(path), true)
      fs.write(path, bytes)
    } catch {
      // 容量不足 / 路径冲突时跳过，不打断 Python 的返回值
    }
  }
  for (const path of before.keys()) {
    if (after.has(path)) {
      continue
    }
    try {
      fs.remove(path)
    } catch {
      // 已经被别处删掉了
    }
  }
}

type PythonMode = 'script' | 'code' | 'stdin' | 'version' | 'help' | 'module'

type PythonInvocation = {
  mode: PythonMode
  script?: string
  code?: string
  args: string[]
  unknown?: string
}

const parsePythonArgs = (argv: string[]): PythonInvocation => {
  const args = [...argv]
  const rest: string[] = []
  while (args.length > 0) {
    const arg = args[0]
    if (arg === '-c') {
      return { mode: 'code', code: args[1] ?? '', args: args.slice(2) }
    }
    if (arg === '-V' || arg === '--version') {
      return { mode: 'version', args: [] }
    }
    if (arg === '-h' || arg === '--help') {
      return { mode: 'help', args: [] }
    }
    if (arg === '-m') {
      return { mode: 'module', args: args.slice(1) }
    }
    if (['-u', '-B', '-O', '-OO', '-s', '-E', '-q', '-i', '-b', '-d'].includes(arg)) {
      args.shift()
      continue
    }
    if (arg === '-') {
      return { mode: 'stdin', args: args.slice(1) }
    }
    if (arg === '--') {
      args.shift()
      const script = args.shift()
      return script ? { mode: 'script', script, args } : { mode: 'stdin', args: [] }
    }
    if (arg.startsWith('-')) {
      return { mode: 'help', args: [], unknown: arg }
    }
    return { mode: 'script', script: arg, args: args.slice(1) }
  }
  return { mode: 'stdin', args: rest }
}

const PYTHON_USAGE = [
  '用法：python3 [-c "代码"] [脚本.py] [参数...]',
  '',
  'Pyodide 版 CPython（WASM），标准库齐全，第三方包（pip）不支持。',
  '脚本所在的目录、/home/user 与 /tmp 会同步进 Python 的文件系统，',
  '脚本写出的文件会自动回到虚拟文件系统里。',
  '',
].join('\n')

const buildPythonRunner = (
  mode: 'script' | 'code' | 'stdin',
  options: { script: string | null; code: string; argv: string[] }
): string => {
  const lines: string[] = ['import sys', `sys.argv = ${JSON.stringify(options.argv)}`]
  if (options.script) {
    lines.push(`sys.path.insert(0, ${JSON.stringify(dirName(options.script))})`)
  }
  const fileLiteral = options.script ? JSON.stringify(options.script) : "'<string>'"
  lines.push(
    '__nanovm_exit_code = 0',
    `__nanovm_globals = {'__name__': '__main__', '__file__': ${fileLiteral}, ` +
      "'__builtins__': __builtins__, '__package__': None, '__spec__': None, " +
      "'__loader__': None, '__cached__': None, '__doc__': None}",
    'try:'
  )
  if (mode === 'script' && options.script) {
    const script = JSON.stringify(options.script)
    lines.push(
      `    with open(${script}, 'r', encoding='utf-8', errors='replace') as __nanovm_handle:`,
      '        __nanovm_source = __nanovm_handle.read()',
      `    exec(compile(__nanovm_source, ${script}, 'exec'), __nanovm_globals)`
    )
  } else {
    const source = mode === 'stdin' ? 'sys.stdin.read()' : JSON.stringify(options.code)
    const filename = mode === 'stdin' ? "'<stdin>'" : "'<string>'"
    lines.push(`    exec(compile(${source}, ${filename}, 'exec'), __nanovm_globals)`)
  }
  lines.push(
    'except SystemExit as __nanovm_signal:',
    '    __nanovm_status = __nanovm_signal.code',
    '    if __nanovm_status is None:',
    '        __nanovm_exit_code = 0',
    '    elif isinstance(__nanovm_status, int):',
    '        __nanovm_exit_code = __nanovm_status',
    '    else:',
    "        sys.stderr.write(str(__nanovm_status) + '\\n')",
    '        __nanovm_exit_code = 1',
    'except KeyboardInterrupt:',
    "    sys.stderr.write('KeyboardInterrupt\\n')",
    '    __nanovm_exit_code = 130',
    'except BaseException:',
    '    import traceback',
    '    traceback.print_exc()',
    '    __nanovm_exit_code = 1'
  )
  return `${lines.join('\n')}\n`
}

const runPython = async (io: ToolchainIO, argv: string[]): Promise<{ code: number }> => {
  const invocation = parsePythonArgs(argv)
  if (invocation.mode === 'version') {
    io.stdout(`Python ${pythonVersionLabel()}\n`)
    return { code: 0 }
  }
  if (invocation.mode === 'help') {
    if (invocation.unknown) {
      io.stderr(`python3: 未知参数 '${invocation.unknown}'\n`)
      return { code: 2 }
    }
    io.stdout(PYTHON_USAGE)
    return { code: 0 }
  }
  if (invocation.mode === 'module') {
    io.stderr(`python3: 不支持 -m（没有安装第三方包）。NanoVM Slim 只内置 Python 标准库。\n`)
    return { code: 1 }
  }

  let script: string | null = null
  let code = ''
  let mode: 'script' | 'code' | 'stdin' = 'code'
  let scriptArgs: string[] = invocation.args
  if (invocation.mode === 'script' && invocation.script) {
    script = resolvePath(io.cwd, invocation.script)
    const source = io.fs.readText(script)
    if (source === null) {
      io.stderr(
        `python3: can't open file '${invocation.script}': [Errno 2] No such file or directory\n`
      )
      return { code: 2 }
    }
    mode = 'script'
    code = source
  } else if (invocation.mode === 'stdin') {
    if (!io.stdin.trim()) {
      io.stderr('python3: 交互式 REPL 不支持，请用 python3 script.py 或 python3 -c "代码"\n')
      return { code: 1 }
    }
    mode = 'stdin'
    code = io.stdin
    scriptArgs = []
  } else {
    code = invocation.code ?? ''
  }

  let runtime: PythonRuntime
  try {
    runtime = await loadPythonRuntime(() => undefined)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    io.stderr(
      `python3: Python 运行时加载失败，需要联网（首次安装约 12MB）：${detail}\n` +
        '提示：连上网后执行 vm install python，装好之后本页内可离线复用。\n'
    )
    return { code: 1 }
  }

  const roots = pythonRoots(io, script)
  const { files, skipped } = collectFiles(io.fs, roots, SYNC_LIMIT_BYTES)
  if (skipped > 0) {
    io.stderr(`python3: 有 ${skipped} 个文件超过同步上限（16MB），Python 里读不到它们\n`)
  }
  const pyodide = runtime.pyodide
  try {
    pyodide.setStdout({ batched: (text) => io.stdout(`${text}\n`) })
    pyodide.setStderr({ batched: (text) => io.stderr(`${text}\n`) })
    if (io.stdin) {
      try {
        pyodide.setStdin?.({ stdin: () => io.stdin })
      } catch {
        // 老版本 Pyodide 没有 setStdin，input() 会 EOFError
      }
    }
  } catch {
    // setStdout / setStderr 不可用时只能拿到 runPython 的返回值
  }
  syncIntoPyodide(pyodide.FS, files)

  const runnerArgv = [
    mode === 'script' ? (invocation.script ?? script ?? '') : mode === 'code' ? '-c' : '-',
    ...scriptArgs,
  ]
  const runner = buildPythonRunner(mode, { script, code, argv: runnerArgv })
  let exitCode = 0
  try {
    pyodide.runPython(runner)
    const value = pyodide.globals.get('__nanovm_exit_code')
    if (typeof value === 'number' && Number.isFinite(value)) {
      exitCode = value
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`python3: ${message}\n`)
    exitCode = 1
  } finally {
    syncBackFromPyodide(io.fs, files, roots, pyodide.FS)
  }
  if (io.signal?.aborted) {
    io.stderr('python3: 已被中断（Python 执行期间无法立刻打断，已跳过剩余代码）\n')
    return { code: 130 }
  }
  return { code: exitCode }
}

// ---------- Node.js ----------

const NODE_USAGE = [
  '用法：node [-v] [-e "代码"] [脚本.js] [参数...]',
  '',
  '浏览器内置的 JS 运行时（Web Worker 沙箱），支持 console / process /',
  "require('fs'|'path'|'os'|'util'|'events') / Buffer / module.exports。",
  '不支持 npm 包、ESM 的 import 语句与原生模块；fs 的异步 API 也不支持。',
  '',
].join('\n')

/** Node 沙箱能看到的目录：cwd、脚本目录与 /tmp */
const nodeRoots = (io: ToolchainIO, script: string | null): string[] => {
  const roots = new Set<string>(['/tmp'])
  if (io.cwd && io.cwd !== '/') {
    roots.add(io.cwd)
  }
  if (script && script.startsWith('/')) {
    roots.add(dirName(script))
  }
  return [...roots]
}

const applyNodeChanges = (fs: NanovmFS, files: Record<string, Uint8Array>, removed: string[]) => {
  for (const [path, bytes] of Object.entries(files)) {
    try {
      fs.mkdir(dirName(path), true)
      fs.write(path, bytes)
    } catch {
      // 容量不足时不打断命令本身的退出码
    }
  }
  for (const path of removed) {
    try {
      fs.remove(path)
    } catch {
      // 已经被删掉了
    }
  }
}

const runNodeCli = async (io: ToolchainIO, argv: string[]): Promise<{ code: number }> => {
  let code = ''
  let scriptPath = ''
  let scriptArgs: string[] = []
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === '-v' || arg === '--version') {
      io.stdout(`v${NODE_VERSION}\n`)
      return { code: 0 }
    }
    if (arg === '-h' || arg === '--help') {
      io.stdout(NODE_USAGE)
      return { code: 0 }
    }
    if (arg === '-e' || arg === '--eval') {
      code = argv[index + 1] ?? ''
      scriptPath = '<eval>'
      scriptArgs = argv.slice(index + 2)
      break
    }
    if (arg === '-' || arg === '--') {
      code = io.stdin
      scriptPath = '<stdin>'
      scriptArgs = argv.slice(index + 1)
      break
    }
    if (arg.startsWith('-')) {
      io.stderr(`node: 不支持的参数 '${arg}'\n${NODE_USAGE}`)
      return { code: 9 }
    }
    scriptPath = resolvePath(io.cwd, arg)
    scriptArgs = argv.slice(index + 1)
    break
  }
  if (!scriptPath) {
    if (io.stdin.trim()) {
      code = io.stdin
      scriptPath = '<stdin>'
    } else {
      io.stderr(`node: 交互式 REPL 不支持，请用 node script.js 或 node -e "代码"\n`)
      return { code: 9 }
    }
  }
  if (!code) {
    if (!scriptPath.startsWith('<')) {
      const source = io.fs.readText(scriptPath)
      if (source === null) {
        io.stderr(`node: 找不到模块 '${scriptPath}'\n`)
        return { code: 1 }
      }
      // 真实 Node 的加载器会剥掉 hashbang；沙箱里的 new Function 不会，这里补一次
      code = source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source
    } else {
      code = io.stdin
    }
  }
  const { files, skipped } = collectFiles(io.fs, nodeRoots(io, scriptPath), SYNC_LIMIT_BYTES)
  if (skipped > 0) {
    io.stderr(`node: 有 ${skipped} 个文件超过同步上限（16MB），脚本里读不到它们\n`)
  }
  const result = await runNode({
    code,
    scriptPath,
    argv: scriptArgs,
    env: io.env,
    cwd: io.cwd,
    files: Object.fromEntries(files),
    timeoutMs: nanoVMConfig().timeoutMs,
    signal: io.signal,
    onStdout: io.stdout,
    onStderr: io.stderr,
  })
  applyNodeChanges(io.fs, result.files, result.removed)
  return { code: result.code }
}

// ---------- Git ----------

const runGitCli = async (io: ToolchainIO, argv: string[]): Promise<{ code: number }> => {
  const code = await runGit(argv, {
    fs: io.fs,
    cwd: io.cwd,
    env: io.env,
    stdout: io.stdout,
    stderr: io.stderr,
    stdin: io.stdin,
  })
  return { code }
}

// ---------- 安装 / 卸载 ----------

/**
 * 安装（或启用）一个工具链。
 * onProgress 回调 0–1，UI 可以直接拿来画进度条；也可以订阅 usePackages 里的 progress。
 */
export const installToolchain = async (
  id: ToolchainId,
  onProgress?: (progress: number) => void
): Promise<{ ok: boolean; error?: string }> => {
  const current = stateOf(id)
  if (current.installed) {
    onProgress?.(1)
    return { ok: true }
  }
  if (usePackages.getState().busy) {
    return { ok: false, error: '另一个工具链正在安装，请稍后再试' }
  }
  usePackages.setState({ busy: id })
  patchState(id, { progress: 0, error: undefined })
  const report = (progress: number) => {
    patchState(id, { progress })
    onProgress?.(progress)
  }
  try {
    if (id === 'python') {
      const runtime = await loadPythonRuntime(report)
      patchState(id, {
        installed: true,
        version: runtime.version,
        progress: 1,
        error: undefined,
        sizeMB: META.python.sizeMB,
      })
    } else {
      const runtime = await runtimeOf(id)
      if (runtime) {
        // 需要下载的运行时：下载完成才算装好，进度由运行时的 load 上报
        const loaded = await runtime.load(report)
        patchState(id, {
          installed: true,
          version: loaded.version || META[id].version,
          progress: 1,
          error: undefined,
        })
      } else {
        // 内置运行时：安装只是「启用」
        report(0.5)
        patchState(id, {
          installed: true,
          version: META[id].version,
          progress: 1,
          error: undefined,
        })
        report(1)
      }
    }
    writeStored(usePackages.getState().states)
    return { ok: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const message =
      id === 'python'
        ? `下载 Python 运行时失败，需要联网（首次安装约 12MB）。${detail ? `原因：${detail}` : ''}`
        : RUNTIMES[id]
          ? `下载 ${META[id].label} 运行时失败，需要联网（约 ${META[id].sizeMB}MB）。${detail ? `原因：${detail}` : ''}`
          : `启用 ${META[id].label} 失败：${detail}`
    patchState(id, { progress: undefined, error: message })
    return { ok: false, error: message }
  } finally {
    usePackages.setState({ busy: null })
  }
}

/** 卸载：释放内存里的运行时，并记住「用户主动卸载过」 */
export const uninstallToolchain = async (id: ToolchainId): Promise<void> => {
  if (id === 'python') {
    pythonRuntime = null
    pythonLoading = null
  }
  const runtime = await runtimeOf(id).catch(() => null)
  await runtime?.dispose?.()
  runtimeCache.delete(id)
  patchState(id, {
    installed: false,
    version: undefined,
    progress: undefined,
    error: undefined,
  })
  writeStored(usePackages.getState().states)
}

// ---------- 给 shell / 应用集用的门面 ----------

/** 执行工具链命令：argv 不含命令名，输出直接写 io */
export const createToolchainHost = (): ToolchainHost => ({
  installed: (id) => stateOf(id).installed,
  install: (id, onProgress) => installToolchain(id, onProgress),
  run: async (id, argv, io) => {
    const state = stateOf(id)
    if (!state.installed) {
      return {
        code: 127,
        error: `${state.label} 未安装，执行 vm install ${id} 可以按需安装`,
      }
    }
    try {
      if (id === 'python') {
        return await runPython(io, argv)
      }
      if (id === 'node') {
        return await runNodeCli(io, argv)
      }
      if (id === 'git') {
        return await runGitCli(io, argv)
      }
      const runtime = await runtimeOf(id)
      if (!runtime) {
        return { code: 127, error: `${state.label} 没有可执行入口，请用 vm list 查看可用工具链` }
      }
      return await runtime.run(argv, io)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      io.stderr(`${id}: ${message}\n`)
      return { code: 1, error: message }
    }
  },
})
