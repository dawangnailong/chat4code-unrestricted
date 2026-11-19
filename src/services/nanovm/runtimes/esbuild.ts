import { baseName, dirName, resolvePath } from '../fs.js'
import type { RuntimeIO, RuntimeModule, RuntimeProgress } from './types.js'

/**
 * esbuild 运行时（esbuild-wasm）。
 *
 * 主模块是 esbuild-wasm 的浏览器 ESM 入口，wasm 二进制单独下载（约 12MB）：
 * 下载时按 ReadableStream 分片上报进度，并尽量放进 Cache Storage
 * （`nanovm-esbuild-cache`）。字节拿到后做成 blob URL 传给 `initialize({ wasmURL })`；
 * 缓存不可用时直接回落到 CDN 地址。
 *
 * esbuild 的 `initialize` 每页只能成功调用一次，所以这里用模块级单例 + initialized
 * 标记，重复 load 直接复用。dispose 不调用 `stop()`（浏览器版 stop 之后能否再次
 * initialize 没有保证），只标记已卸载，重新安装需要刷新页面。
 *
 * 打包模式通过一个 VFS 插件把 import 解析到虚拟文件系统：相对路径按 resolveDir 解析，
 * 依次尝试原扩展、TS 风格的 .js → .ts 映射、补扩展名与 /index.*；裸模块名（npm 包）
 * 不支持，会给出明确报错。esbuild 本身的 worker 关闭（worker: false），避免 blob
 * worker 在部分 CSP 下被拦截，代价是构建时占用主线程。
 */

const ESBUILD_MODULE_URL = 'https://cdn.jsdelivr.net/npm/esbuild-wasm@0.25.10/esm/browser.min.js'
const WASM_URL = 'https://cdn.jsdelivr.net/npm/esbuild-wasm@0.25.10/esbuild.wasm'
const CACHE_NAME = 'nanovm-esbuild-cache'
const CACHE_KEY = WASM_URL
const FALLBACK_VERSION = '0.25.10'

type LoaderName = 'js' | 'jsx' | 'ts' | 'tsx' | 'json' | 'css' | 'text'

type FormatName = 'esm' | 'cjs' | 'iife'

type PlatformName = 'browser' | 'node'

type SourcemapMode = 'inline' | 'external' | 'linked' | 'both'

type EsbuildMessage = {
  text: string
  location?: { file: string; line: number; column: number } | null
}

type EsbuildOutputFile = {
  path: string
  contents: Uint8Array
}

type EsbuildBuildResult = {
  errors: EsbuildMessage[]
  warnings: EsbuildMessage[]
  outputFiles?: EsbuildOutputFile[]
}

type EsbuildTransformResult = {
  code: string
  map?: string
  warnings: EsbuildMessage[]
}

type OnResolveArgs = {
  path: string
  importer: string
  namespace: string
  resolveDir: string
  kind: string
}

type OnResolveResult = {
  path?: string
  namespace?: string
  external?: boolean
  errors?: EsbuildMessage[]
}

type OnLoadArgs = {
  path: string
  namespace: string
}

type OnLoadResult = {
  contents?: string | Uint8Array
  loader?: LoaderName
  resolveDir?: string
  errors?: EsbuildMessage[]
}

type EsbuildPluginBuild = {
  onResolve: (
    options: { filter: RegExp; namespace?: string },
    callback: (args: OnResolveArgs) => OnResolveResult | undefined
  ) => void
  onLoad: (
    options: { filter: RegExp; namespace?: string },
    callback: (args: OnLoadArgs) => OnLoadResult | undefined
  ) => void
}

type EsbuildPlugin = {
  name: string
  setup: (build: EsbuildPluginBuild) => void
}

type EsbuildBuildOptions = {
  entryPoints: string[]
  bundle: boolean
  write: false
  absWorkingDir: string
  outfile?: string
  outdir?: string
  format?: FormatName
  target?: string
  platform?: PlatformName
  minify?: boolean
  sourcemap?: boolean | SourcemapMode
  define?: Record<string, string>
  loader?: Record<string, LoaderName>
  plugins: EsbuildPlugin[]
  logLevel?: 'silent'
}

type EsbuildTransformOptions = {
  sourcefile?: string
  loader: LoaderName
  format?: FormatName
  target?: string
  platform?: PlatformName
  minify?: boolean
  sourcemap?: boolean | SourcemapMode
  define?: Record<string, string>
  logLevel?: 'silent'
}

type EsbuildApi = {
  initialize: (options: {
    wasmURL?: string
    wasmModule?: WebAssembly.Module
    worker?: boolean
  }) => Promise<void>
  build: (options: EsbuildBuildOptions) => Promise<EsbuildBuildResult>
  transform: (input: string, options: EsbuildTransformOptions) => Promise<EsbuildTransformResult>
  version: string
}

/** 解析后的命令行 */
type EsbuildInvocation = {
  mode: 'version' | 'help' | 'error' | 'run'
  entry: string | null
  bundle: boolean
  outfile: string | null
  outdir: string | null
  minify: boolean
  format: FormatName | null
  target: string | null
  platform: PlatformName | null
  sourcemap: boolean | SourcemapMode
  loader: LoaderName | null
  loaderOverrides: Record<string, LoaderName>
  define: Record<string, string>
  message?: string
}

const USAGE = [
  '用法：esbuild 入口.ts [选项]',
  '',
  '  --bundle              从入口打包（跟随 VFS 里的 import）',
  '  --outfile=文件        输出到指定文件（相对当前目录）',
  '  --outdir=目录         输出到指定目录',
  '  --minify              压缩输出',
  '  --format=esm|cjs|iife 输出格式',
  '  --target=es2020       目标语法版本',
  '  --platform=browser|node',
  '  --sourcemap           生成 sourcemap',
  '  --loader=ts|js|jsx|tsx|json',
  '  --define:KEY=VALUE    编译期替换（可重复）',
  '  --version / --help',
  '',
  '不加 --bundle 时只转译入口文件；打包模式不支持 npm 包（没有 node_modules）。',
  '',
].join('\n')

const LOADERS: LoaderName[] = ['js', 'jsx', 'ts', 'tsx', 'json', 'css', 'text']

const LOADER_BY_EXTENSION: Record<string, LoaderName> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.json': 'json',
  '.css': 'css',
  '.txt': 'text',
  '.md': 'text',
}

/** 补扩展名时的尝试顺序（TS 项目里 `./x.js` 常常实际是 `./x.ts`） */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs', '.cjs']

const INDEX_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json']

const TS_ALIASABLE = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])

const SOURCEMAP_MODES: SourcemapMode[] = ['inline', 'external', 'linked', 'both']

const REMOTE_PATTERN = /^(?:https?:|data:|blob:)/i

/** 远程 ESM 只能靠原生 import 加载，`new Function` 里的 import 不会被 rspack 打包 */
const importRemote = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>

let loadedApi: EsbuildApi | null = null
let initialized = false
let loadingApi: Promise<EsbuildApi> | null = null
let disposed = false
let detectedVersion = FALLBACK_VERSION

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

const readCachedWasm = async (): Promise<Uint8Array | null> => {
  const storage = cacheStorage()
  if (!storage) {
    return null
  }
  try {
    const cache = await storage.open(CACHE_NAME)
    const response = await cache.match(CACHE_KEY)
    return response ? new Uint8Array(await response.arrayBuffer()) : null
  } catch {
    return null
  }
}

const writeCachedWasm = async (bytes: Uint8Array): Promise<void> => {
  const storage = cacheStorage()
  if (!storage) {
    return
  }
  try {
    const cache = await storage.open(CACHE_NAME)
    await cache.put(
      CACHE_KEY,
      new Response(toArrayBuffer(bytes), {
        headers: { 'content-type': 'application/wasm' },
      })
    )
  } catch {
    // 缓存失败不影响本次使用
  }
}

/** 带进度的下载 */
const downloadWasm = async (onProgress: (fraction: number) => void): Promise<Uint8Array | null> => {
  try {
    const response = await fetch(WASM_URL)
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

const errorText = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const readProperty = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  return (value as Record<string, unknown>)[key]
}

/** 校验并取出 esbuild 的 ESM 导出 */
const resolveEsbuildApi = (module: unknown): EsbuildApi => {
  if (typeof module !== 'object' || module === null) {
    throw new Error('esbuild 模块格式异常（不是对象）')
  }
  const record = module as Record<string, unknown>
  const initialize = record.initialize
  const build = record.build
  const transform = record.transform
  if (
    typeof initialize !== 'function' ||
    typeof build !== 'function' ||
    typeof transform !== 'function'
  ) {
    throw new Error('esbuild 模块缺少 initialize / build / transform 导出')
  }
  return {
    initialize: initialize as EsbuildApi['initialize'],
    build: build as EsbuildApi['build'],
    transform: transform as EsbuildApi['transform'],
    version: typeof record.version === 'string' ? record.version : FALLBACK_VERSION,
  }
}

/** 加载 esbuild-wasm：下载 wasm → 动态 import → initialize（每页只成功一次） */
const loadEsbuild = async (onProgress: RuntimeProgress): Promise<EsbuildApi> => {
  if (disposed) {
    // initialize 每页只能成功一次：卸载后无法安全地重新初始化，只能提示刷新
    throw new Error('esbuild 运行时已卸载，请刷新页面后重新安装')
  }
  if (loadedApi && initialized) {
    onProgress(1)
    return loadedApi
  }
  if (loadingApi) {
    const api = await loadingApi
    onProgress(1)
    return api
  }
  const pending = (async (): Promise<EsbuildApi> => {
    onProgress(0)
    let bytes: Uint8Array | null = null
    if (cacheStorage()) {
      bytes = await readCachedWasm()
      if (bytes) {
        onProgress(0.55)
      } else {
        bytes = await downloadWasm((fraction) => onProgress(0.05 + fraction * 0.55))
        if (bytes) {
          await writeCachedWasm(bytes)
        }
      }
    } else {
      // 没有 Cache Storage 时不做预下载，直接把 CDN 地址交给 esbuild.initialize
      onProgress(0.55)
    }
    onProgress(0.65)
    const module = await importRemote(ESBUILD_MODULE_URL)
    const api = resolveEsbuildApi(module)
    detectedVersion = api.version || FALLBACK_VERSION
    onProgress(0.75)

    // worker: false 避免 blob worker 在部分 CSP 下被拦截；代价是构建占用主线程
    let blobUrl: string | null = null
    if (bytes) {
      try {
        blobUrl = URL.createObjectURL(
          new Blob([toArrayBuffer(bytes)], { type: 'application/wasm' })
        )
      } catch {
        blobUrl = null
      }
    }
    const wasmLocation = blobUrl ?? WASM_URL
    try {
      await api.initialize({ wasmURL: wasmLocation, worker: false })
      initialized = true
      loadedApi = api
      onProgress(1)
      return api
    } finally {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  })()
  loadingApi = pending
  try {
    return await pending
  } finally {
    loadingApi = null
  }
}

const ensureEsbuild = async (onProgress: RuntimeProgress): Promise<EsbuildApi> => {
  if (loadedApi && initialized) {
    onProgress(1)
    return loadedApi
  }
  return loadEsbuild(onProgress)
}

// ---------- 参数解析 ----------

const asLoader = (value: string): LoaderName | null => {
  return LOADERS.includes(value as LoaderName) ? (value as LoaderName) : null
}

const asFormat = (value: string): FormatName | null => {
  return value === 'esm' || value === 'cjs' || value === 'iife' ? value : null
}

const asPlatform = (value: string): PlatformName | null => {
  return value === 'browser' || value === 'node' ? value : null
}

const normalizeExtensionKey = (value: string): string => {
  if (value.startsWith('.')) {
    return value.toLowerCase()
  }
  return `.${value.toLowerCase()}`
}

const parseDefine = (definition: string): { key: string; value: string } | null => {
  const equals = definition.indexOf('=')
  if (equals <= 0) {
    return null
  }
  return { key: definition.slice(0, equals), value: definition.slice(equals + 1) }
}

/** 解析参数；argv 不含命令名 */
const parseInvocation = (argv: string[]): EsbuildInvocation => {
  const out: EsbuildInvocation = {
    mode: 'run',
    entry: null,
    bundle: false,
    outfile: null,
    outdir: null,
    minify: false,
    format: null,
    target: null,
    platform: null,
    sourcemap: false,
    loader: null,
    loaderOverrides: {},
    define: {},
  }
  const fail = (message: string): EsbuildInvocation => ({ ...out, mode: 'error', message })
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === undefined) {
      break
    }
    if (arg === '--version' || arg === '-v') {
      return { ...out, mode: 'version' }
    }
    if (arg === '--help' || arg === '-h') {
      return { ...out, mode: 'help' }
    }
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-')) {
        return fail(`esbuild: 无法识别的选项 '${arg}'\n${USAGE}`)
      }
      if (out.entry !== null) {
        return fail(`esbuild: 只能有一个入口文件（多余的参数 '${arg}'）\n`)
      }
      out.entry = arg
      index += 1
      continue
    }
    const body = arg.slice(2)
    if (!body) {
      return fail(`esbuild: 无法识别的选项 '${arg}'\n`)
    }

    // --define:KEY=VALUE 的 '=' 属于定义内容，先单独处理
    if (body === 'define' || body.startsWith('define:')) {
      let definition = body === 'define' ? null : body.slice('define:'.length)
      if (definition === null) {
        const next = argv[index + 1]
        if (next === undefined) {
          return fail('esbuild: --define 需要 KEY=VALUE 形式的参数\n')
        }
        definition = next
        index += 1
      }
      const parsed = parseDefine(definition)
      if (!parsed) {
        return fail(`esbuild: --define 参数 '${definition}' 不是 KEY=VALUE 形式\n`)
      }
      out.define[parsed.key] = parsed.value
      index += 1
      continue
    }

    let name = body
    let value: string | null = null
    const equals = body.indexOf('=')
    if (equals >= 0) {
      name = body.slice(0, equals)
      value = body.slice(equals + 1)
    }

    if (name === 'bundle' || name === 'minify') {
      if (value !== null) {
        return fail(`esbuild: --${name} 是开关，不接受值 '${value}'\n`)
      }
      if (name === 'bundle') {
        out.bundle = true
      } else {
        out.minify = true
      }
      index += 1
      continue
    }

    if (name === 'sourcemap') {
      if (value === null) {
        out.sourcemap = true
      } else if (SOURCEMAP_MODES.includes(value as SourcemapMode)) {
        out.sourcemap = value as SourcemapMode
      } else {
        return fail('esbuild: --sourcemap 只支持 inline / external / linked / both\n')
      }
      index += 1
      continue
    }

    if (name.startsWith('loader:')) {
      const extension = normalizeExtensionKey(name.slice('loader:'.length))
      const loaderValue = value ?? argv[index + 1]
      if (loaderValue === undefined) {
        return fail('esbuild: --loader 需要一个值\n')
      }
      if (value === null) {
        index += 1
      }
      const loader = asLoader(loaderValue)
      if (!loader) {
        return fail(`esbuild: 不支持的 loader '${loaderValue}'\n`)
      }
      out.loaderOverrides[extension] = loader
      index += 1
      continue
    }

    const needsValue = ['outfile', 'outdir', 'format', 'target', 'platform', 'loader'].includes(
      name
    )
    if (!needsValue) {
      return fail(`esbuild: 无法识别的选项 '${arg}'\n${USAGE}`)
    }
    let resolvedValue = value
    if (resolvedValue === null) {
      const next = argv[index + 1]
      if (next === undefined) {
        return fail(`esbuild: --${name} 需要一个值\n`)
      }
      resolvedValue = next
      index += 1
    }
    if (name === 'outfile') {
      out.outfile = resolvedValue
    } else if (name === 'outdir') {
      out.outdir = resolvedValue
    } else if (name === 'format') {
      const format = asFormat(resolvedValue)
      if (!format) {
        return fail(`esbuild: 不支持的 format '${resolvedValue}'\n`)
      }
      out.format = format
    } else if (name === 'target') {
      out.target = resolvedValue
    } else if (name === 'platform') {
      const platform = asPlatform(resolvedValue)
      if (!platform) {
        return fail(`esbuild: 不支持的 platform '${resolvedValue}'\n`)
      }
      out.platform = platform
    } else {
      const loader = asLoader(resolvedValue)
      if (!loader) {
        return fail(`esbuild: 不支持的 loader '${resolvedValue}'\n`)
      }
      out.loader = loader
    }
    index += 1
  }
  return out
}

// ---------- VFS 解析 ----------

const extensionOf = (path: string): string => {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    return ''
  }
  return name.slice(dot).toLowerCase()
}

const loaderForPath = (path: string): LoaderName | null => {
  return LOADER_BY_EXTENSION[extensionOf(path)] ?? null
}

const isFile = (fs: RuntimeIO['fs'], path: string): boolean => {
  const stat = fs.stat(path)
  return stat?.kind === 'file'
}

/** 在 VFS 里解析一个路径：原样、扩展名别名、补扩展名、目录 index.* */
const resolveVfsFile = (fs: RuntimeIO['fs'], target: string): string | null => {
  const stat = fs.stat(target)
  if (stat?.kind === 'file') {
    return stat.path
  }
  if (stat?.kind === 'dir') {
    for (const extension of INDEX_EXTENSIONS) {
      const candidate = `${target}/index${extension}`
      if (isFile(fs, candidate)) {
        return candidate
      }
    }
    return null
  }
  const extension = extensionOf(target)
  if (extension && TS_ALIASABLE.has(extension)) {
    const stem = target.slice(0, target.length - extension.length)
    for (const candidateExtension of RESOLVE_EXTENSIONS) {
      if (candidateExtension === extension) {
        continue
      }
      const candidate = `${stem}${candidateExtension}`
      if (isFile(fs, candidate)) {
        return candidate
      }
    }
  }
  for (const candidateExtension of RESOLVE_EXTENSIONS) {
    const candidate = `${target}${candidateExtension}`
    if (isFile(fs, candidate)) {
      return candidate
    }
  }
  return null
}

const isBareSpecifier = (specifier: string): boolean => {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return false
  }
  return !REMOTE_PATTERN.test(specifier)
}

/** 把 import 全部导到 VFS 的 esbuild 插件 */
const createVfsPlugin = (io: RuntimeIO): EsbuildPlugin => ({
  name: 'nanovm-vfs',
  setup: (build) => {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') {
        const entry = resolvePath(io.cwd, args.path)
        const found = resolveVfsFile(io.fs, entry)
        if (!found) {
          return { errors: [{ text: `找不到入口文件 '${args.path}'` }] }
        }
        return { path: found, namespace: 'nanovm' }
      }
      if (args.namespace !== 'nanovm') {
        return undefined
      }
      if (REMOTE_PATTERN.test(args.path)) {
        return { path: args.path, external: true }
      }
      if (isBareSpecifier(args.path)) {
        return {
          errors: [
            {
              text: `无法解析裸模块名 '${args.path}'：NanoVM 的 esbuild 不读取 node_modules`,
            },
          ],
        }
      }
      const baseDir = args.resolveDir || (args.importer ? dirName(args.importer) : io.cwd)
      const target = args.path.startsWith('/')
        ? resolvePath('/', args.path)
        : resolvePath(baseDir, args.path)
      const found = resolveVfsFile(io.fs, target)
      if (!found) {
        return {
          errors: [{ text: `无法从 VFS 解析 '${args.path}'（引用者 ${args.importer}）` }],
        }
      }
      return { path: found, namespace: 'nanovm' }
    })
    build.onLoad({ filter: /.*/, namespace: 'nanovm' }, (args) => {
      const bytes = io.fs.read(args.path)
      if (!bytes) {
        return { errors: [{ text: `无法读取 ${args.path}` }] }
      }
      const loader = loaderForPath(args.path)
      if (!loader) {
        return { errors: [{ text: `${args.path} 的扩展名没有对应的 loader` }] }
      }
      return { contents: bytes, loader, resolveDir: dirName(args.path) }
    })
  },
})

// ---------- 输出与错误 ----------

const toMessages = (value: unknown): EsbuildMessage[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const messages: EsbuildMessage[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const record = item as Record<string, unknown>
    const text = record.text
    if (typeof text !== 'string') {
      continue
    }
    const locationValue = record.location
    let location: EsbuildMessage['location'] = null
    if (typeof locationValue === 'object' && locationValue !== null) {
      const fields = locationValue as Record<string, unknown>
      if (typeof fields.file === 'string' && typeof fields.line === 'number') {
        location = {
          file: fields.file,
          line: fields.line,
          column: typeof fields.column === 'number' ? fields.column : 0,
        }
      }
    }
    messages.push({ text, location })
  }
  return messages
}

const reportMessages = (io: RuntimeIO, messages: EsbuildMessage[]) => {
  for (const message of messages) {
    const location = message.location
    if (location) {
      io.stderr(
        `esbuild: ${location.file}:${location.line}:${location.column + 1}: ${message.text}\n`
      )
    } else {
      io.stderr(`esbuild: ${message.text}\n`)
    }
  }
}

const writeOutput = (io: RuntimeIO, path: string, contents: Uint8Array): boolean => {
  try {
    io.fs.mkdir(dirName(path), true)
    io.fs.write(path, contents)
    return true
  } catch (error) {
    io.stderr(`esbuild: 写入 ${path} 失败：${errorText(error)}\n`)
    return false
  }
}

const appendSourcemapComment = (code: string, mapName: string): string => {
  if (code.includes('sourceMappingURL')) {
    return code
  }
  const separator = code.endsWith('\n') ? '' : '\n'
  return `${code}${separator}//# sourceMappingURL=${mapName}\n`
}

// ---------- 执行 ----------

const buildBaseOptions = (invocation: EsbuildInvocation): Partial<EsbuildBuildOptions> => {
  const options: Partial<EsbuildBuildOptions> = {}
  if (invocation.format) {
    options.format = invocation.format
  }
  if (invocation.target) {
    options.target = invocation.target
  }
  if (invocation.platform) {
    options.platform = invocation.platform
  }
  if (invocation.minify) {
    options.minify = true
  }
  if (invocation.sourcemap) {
    options.sourcemap = invocation.sourcemap
  }
  if (Object.keys(invocation.define).length > 0) {
    options.define = invocation.define
  }
  return options
}

const runTransform = async (
  api: EsbuildApi,
  invocation: EsbuildInvocation,
  resolvedEntry: string,
  io: RuntimeIO
): Promise<{ code: number }> => {
  let source: string | null = null
  try {
    source = io.fs.readText(resolvedEntry)
  } catch {
    source = null
  }
  if (source === null) {
    io.stderr(`esbuild: 找不到入口文件 '${invocation.entry ?? ''}'\n`)
    return { code: 1 }
  }
  const loader = invocation.loader ?? loaderForPath(resolvedEntry)
  if (!loader) {
    io.stderr(`esbuild: 无法判断 '${resolvedEntry}' 的 loader，请用 --loader=ts|js|jsx|tsx|json\n`)
    return { code: 1 }
  }
  const options: EsbuildTransformOptions = {
    loader,
    sourcefile: resolvedEntry,
    logLevel: 'silent',
  }
  if (invocation.format) {
    options.format = invocation.format
  }
  if (invocation.target) {
    options.target = invocation.target
  }
  if (invocation.platform) {
    options.platform = invocation.platform
  }
  if (invocation.minify) {
    options.minify = true
  }
  if (invocation.sourcemap) {
    options.sourcemap = invocation.sourcemap
  }
  if (Object.keys(invocation.define).length > 0) {
    options.define = invocation.define
  }
  let result: EsbuildTransformResult
  try {
    result = await api.transform(source, options)
  } catch (error) {
    const errors = toMessages(readProperty(error, 'errors'))
    if (errors.length > 0) {
      reportMessages(io, errors)
    } else {
      io.stderr(`esbuild: ${errorText(error)}\n`)
    }
    return { code: 1 }
  }
  if (invocation.outfile) {
    const target = resolvePath(io.cwd, invocation.outfile)
    let code = result.code
    if (typeof result.map === 'string' && result.map && invocation.sourcemap) {
      const mapName = `${baseName(target)}.map`
      if (invocation.sourcemap !== 'inline') {
        if (!writeOutput(io, `${target}.map`, new TextEncoder().encode(result.map))) {
          return { code: 1 }
        }
        code = appendSourcemapComment(code, mapName)
      }
    }
    if (!writeOutput(io, target, new TextEncoder().encode(code))) {
      return { code: 1 }
    }
    return { code: 0 }
  }
  io.stdout(result.code.endsWith('\n') ? result.code : `${result.code}\n`)
  return { code: 0 }
}

const runBuild = async (
  api: EsbuildApi,
  invocation: EsbuildInvocation,
  resolvedEntry: string,
  io: RuntimeIO
): Promise<{ code: number }> => {
  const options: EsbuildBuildOptions = {
    entryPoints: [resolvedEntry],
    bundle: true,
    write: false,
    absWorkingDir: io.cwd,
    plugins: [createVfsPlugin(io)],
    logLevel: 'silent',
    ...buildBaseOptions(invocation),
  }
  if (invocation.outfile) {
    options.outfile = resolvePath(io.cwd, invocation.outfile)
  }
  if (invocation.outdir) {
    options.outdir = resolvePath(io.cwd, invocation.outdir)
  }
  const loaderMap: Record<string, LoaderName> = { ...invocation.loaderOverrides }
  if (invocation.loader) {
    const extension = extensionOf(resolvedEntry) || baseName(resolvedEntry)
    loaderMap[extension.startsWith('.') ? extension : `.${extension}`] = invocation.loader
  }
  if (Object.keys(loaderMap).length > 0) {
    options.loader = loaderMap
  }

  let result: EsbuildBuildResult
  try {
    result = await api.build(options)
  } catch (error) {
    const errors = toMessages(readProperty(error, 'errors'))
    if (errors.length > 0) {
      reportMessages(io, errors)
    } else {
      io.stderr(`esbuild: ${errorText(error)}\n`)
    }
    return { code: 1 }
  }
  const errors = toMessages(result.errors)
  if (errors.length > 0) {
    reportMessages(io, errors)
    return { code: 1 }
  }
  const files = result.outputFiles ?? []
  if (files.length === 0) {
    io.stderr('esbuild: 构建完成但没有生成输出文件\n')
    return { code: 1 }
  }

  if (invocation.outfile) {
    const target = resolvePath(io.cwd, invocation.outfile)
    const main = files[0]
    if (main && !writeOutput(io, target, main.contents)) {
      return { code: 1 }
    }
    for (const file of files.slice(1)) {
      if (!writeOutput(io, file.path, file.contents)) {
        return { code: 1 }
      }
    }
    return { code: 0 }
  }
  if (invocation.outdir) {
    for (const file of files) {
      if (!writeOutput(io, file.path, file.contents)) {
        return { code: 1 }
      }
    }
    return { code: 0 }
  }
  const main = files[0]
  if (!main) {
    io.stderr('esbuild: 构建完成但没有生成输出文件\n')
    return { code: 1 }
  }
  const text = new TextDecoder().decode(main.contents)
  io.stdout(text.endsWith('\n') ? text : `${text}\n`)
  io.stderr('esbuild: 输出已写到标准输出，可以用 --outfile 或 --outdir 写入虚拟文件系统\n')
  return { code: 0 }
}

const runEsbuild = async (argv: string[], io: RuntimeIO): Promise<{ code: number }> => {
  const invocation = parseInvocation(argv)
  if (invocation.mode === 'version') {
    io.stdout(`${detectedVersion || FALLBACK_VERSION}\n`)
    return { code: 0 }
  }
  if (invocation.mode === 'help') {
    io.stdout(USAGE)
    return { code: 0 }
  }
  if (invocation.mode === 'error') {
    io.stderr(invocation.message ?? 'esbuild: 参数错误\n')
    return { code: 1 }
  }
  if (disposed) {
    io.stderr('esbuild: 运行时已卸载，请刷新页面后重新安装\n')
    return { code: 1 }
  }
  if (!invocation.entry) {
    io.stderr(`esbuild: 缺少入口文件\n${USAGE}`)
    return { code: 1 }
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }

  let api: EsbuildApi
  try {
    api = await ensureEsbuild(() => undefined)
  } catch (error) {
    const detail = errorText(error)
    io.stderr(
      `esbuild: esbuild 运行时加载失败，需要联网（首次安装约 12MB）：${detail}\n` +
        '提示：连上网后执行 vm install esbuild，装好之后本页内可复用。\n'
    )
    return { code: 1 }
  }

  const resolvedEntry = resolvePath(io.cwd, invocation.entry)
  const result = invocation.bundle
    ? await runBuild(api, invocation, resolvedEntry, io)
    : await runTransform(api, invocation, resolvedEntry, io)
  if (io.signal?.aborted) {
    return { code: 130 }
  }
  return result
}

/** esbuild（esbuild-wasm）：从 CDN 取 ESM 与 wasm 二进制 */
export const esbuildRuntime: RuntimeModule = {
  load: async (onProgress) => {
    await ensureEsbuild(onProgress)
    return { version: detectedVersion }
  },
  run: async (argv, io) => runEsbuild(argv, io),
  dispose: () => {
    // 浏览器版的 initialize 每页只能成功一次：这里不调用 stop()，只标记卸载，
    // 重新安装需要刷新页面（load 会返回明确提示）。
    disposed = true
    loadedApi = null
    initialized = false
    loadingApi = null
    detectedVersion = FALLBACK_VERSION
  },
}
