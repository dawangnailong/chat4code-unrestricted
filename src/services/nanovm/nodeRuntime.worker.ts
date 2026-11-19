/**
 * Node.js 兼容运行时的沙箱内核。
 *
 * 浏览器里没有真正的 Node，这里用 Function 构造函数搭一个「够用」的子集：
 * console / process / require('fs'|'path'|...) / Buffer / module.exports /
 * __dirname / __filename / 定时器。脚本改过的文件最后以差分的形式回传主线程，
 * 由主线程写回 NanoVM 的虚拟文件系统。
 *
 * 这个文件被两条路径共用：
 * - 有 Worker 时它就是 Worker 入口（检测到 postMessage 才注册消息处理）；
 * - 拿不到 Worker 时主线程回落到 executeNode，直接跑同一套沙箱。
 * 因此这里不能碰 DOM、OPFS 与 zustand，也不 import 项目里的其他模块。
 */

/** 沙箱里报告的 Node 版本号，仅用于 `node -v` 与 `process.version` 展示 */
export const NODE_VERSION = '22.0.0-nanovm'

/** 沙箱里报告的运行平台，脚本可以用它判断「不是真 Node」 */
export const NODE_PLATFORM = 'nanovm'

/** 沙箱内单个脚本的默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 15_000

/** 输出攒够这么多字符或遇到换行就推给主线程，避免一条条消息刷屏 */
const SINK_FLUSH_CHARS = 8 * 1024

export type SandboxFileMap = Record<string, Uint8Array>

/** 主线程 → Worker 的执行请求 */
export type NodeSandboxRequest = {
  type: 'run'
  code: string
  scriptPath: string
  argv: string[]
  env: Record<string, string>
  cwd: string
  files: SandboxFileMap
  timeoutMs: number
}

/** Worker → 主线程的消息 */
export type NodeSandboxMessage =
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | {
      type: 'done'
      code: number
      files: SandboxFileMap
      removed: string[]
      timedOut: boolean
      aborted: boolean
    }
  | { type: 'error'; message: string }

export type SandboxOptions = {
  code: string
  /** 写进 process.argv[1] 与 __filename 的路径 */
  scriptPath: string
  argv: string[]
  env: Record<string, string>
  cwd: string
  files: SandboxFileMap
  timeoutMs?: number
  onStdout: (text: string) => void
  onStderr: (text: string) => void
  /** 主线程回落路径用它响应 AbortSignal；Worker 里由主线程 terminate 代替 */
  shouldAbort?: () => boolean
}

export type SandboxOutcome = {
  code: number
  /** 改动过或新建的文件 */
  files: SandboxFileMap
  /** 被删掉的文件 */
  removed: string[]
  timedOut: boolean
  aborted: boolean
}

// ---------- 路径 ----------

/** 折叠重复斜杠与 . / ..，返回绝对路径（根为 /） */
const normalizePath = (input: string): string => {
  const parts: string[] = []
  for (const part of input.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join('/')}`
}

const isAbsolutePath = (input: string): boolean => input.startsWith('/')

const resolvePath = (cwd: string, input: string): string =>
  isAbsolutePath(input) ? normalizePath(input) : normalizePath(`${cwd}/${input}`)

const dirNameOf = (path: string): string => {
  const normalized = normalizePath(path)
  if (normalized === '/') {
    return '/'
  }
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

const baseNameOf = (path: string): string => {
  const normalized = normalizePath(path)
  return normalized === '/' ? '/' : normalized.slice(normalized.lastIndexOf('/') + 1)
}

const joinPaths = (base: string, ...parts: string[]): string => {
  let result = base
  for (const part of parts) {
    result = part.startsWith('/') ? part : `${result}/${part}`
  }
  return normalizePath(result)
}

/** 与 path.join 一致：只拼接与折叠，不引入 cwd，也不强制绝对路径 */
const joinRelative = (parts: string[]): string => {
  const joined = parts.filter((part) => part !== '').join('/')
  const absolute = joined.startsWith('/')
  const segments: string[] = []
  for (const part of joined.split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop()
      } else if (!absolute) {
        segments.push('..')
      }
      continue
    }
    segments.push(part)
  }
  return `${absolute ? '/' : ''}${segments.join('/')}`
}

// ---------- 编码 ----------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const utf8Encode = (text: string): Uint8Array => encoder.encode(text)

/** 宽松解码：二进制内容解不出来也不抛错，尽量给出可读文本 */
const utf8Decode = (bytes: Uint8Array): string => decoder.decode(bytes)

const latin1Decode = (bytes: Uint8Array): string => {
  let text = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    text += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return text
}

const latin1Encode = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff
  }
  return bytes
}

const hexDecode = (text: string): Uint8Array => {
  const clean = text.replace(/[^0-9a-fA-F]/g, '')
  const length = Math.floor(clean.length / 2)
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

const hexEncode = (bytes: Uint8Array): string => {
  let text = ''
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0')
  }
  return text
}

const base64Encode = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

const base64Decode = (text: string): Uint8Array => {
  try {
    const binary = atob(text.replace(/[^A-Za-z0-9+/=]/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return new Uint8Array(0)
  }
}

type BufferEncoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'latin1' | 'binary' | 'ascii'

const encodeWith = (text: string, encoding: string = 'utf8'): Uint8Array => {
  const kind = encoding.toLowerCase() as BufferEncoding
  if (kind === 'hex') {
    return hexDecode(text)
  }
  if (kind === 'base64') {
    return base64Decode(text)
  }
  if (kind === 'latin1' || kind === 'binary' || kind === 'ascii') {
    return latin1Encode(text)
  }
  return utf8Encode(text)
}

const decodeWith = (bytes: Uint8Array, encoding: string = 'utf8'): string => {
  const kind = encoding.toLowerCase() as BufferEncoding
  if (kind === 'hex') {
    return hexEncode(bytes)
  }
  if (kind === 'base64') {
    return base64Encode(bytes)
  }
  if (kind === 'latin1' || kind === 'binary' || kind === 'ascii') {
    return latin1Decode(bytes)
  }
  return utf8Decode(bytes)
}

// ---------- Buffer ----------

/** 带 Node 风格 toString 的 Uint8Array 子类 */
class VmBuffer extends Uint8Array {
  override toString(encoding: string = 'utf8'): string {
    return decodeWith(this, encoding)
  }

  equals(other: Uint8Array): boolean {
    if (this.length !== other.length) {
      return false
    }
    for (let index = 0; index < this.length; index += 1) {
      if (this[index] !== other[index]) {
        return false
      }
    }
    return true
  }

  write(text: string, offset = 0, encoding: string = 'utf8'): number {
    const bytes = encodeWith(text, encoding)
    const length = Math.min(bytes.length, this.length - offset)
    this.set(bytes.subarray(0, length), offset)
    return length
  }

  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: [...this] }
  }
}

/** 把普通 Uint8Array 换成 VmBuffer（不复制内容） */
const asBuffer = (bytes: Uint8Array): VmBuffer =>
  Object.setPrototypeOf(bytes, VmBuffer.prototype) as VmBuffer

const toBytes = (input: unknown): Uint8Array => {
  if (input instanceof Uint8Array) {
    return input
  }
  if (typeof input === 'string') {
    return utf8Encode(input)
  }
  if (Array.isArray(input)) {
    return new Uint8Array(input.map((value) => Number(value) & 0xff))
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input)
  }
  throw new TypeError('The first argument must be of type string, Buffer, or ArrayBuffer')
}

const BufferApi = {
  from: (input: unknown, encodingOrOffset?: string | number, length?: number): VmBuffer => {
    if (typeof input === 'string') {
      return asBuffer(
        encodeWith(input, typeof encodingOrOffset === 'string' ? encodingOrOffset : 'utf8')
      )
    }
    if (input instanceof ArrayBuffer) {
      const offset = typeof encodingOrOffset === 'number' ? encodingOrOffset : 0
      const size = typeof length === 'number' ? length : input.byteLength - offset
      return asBuffer(new Uint8Array(input, offset, size))
    }
    return asBuffer(toBytes(input))
  },
  alloc: (size: number, fill?: string | number, encoding?: string): VmBuffer => {
    const bytes = new VmBuffer(Math.max(0, Math.trunc(size)))
    if (typeof fill === 'string' && fill) {
      const pattern = encodeWith(fill, encoding)
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = pattern[index % pattern.length]
      }
    } else if (typeof fill === 'number') {
      bytes.fill(fill & 0xff)
    }
    return bytes
  },
  allocUnsafe: (size: number): VmBuffer => new VmBuffer(Math.max(0, Math.trunc(size))),
  concat: (list: Uint8Array[], totalLength?: number): VmBuffer => {
    const size =
      typeof totalLength === 'number'
        ? totalLength
        : list.reduce((sum, item) => sum + item.byteLength, 0)
    const bytes = new VmBuffer(Math.max(0, Math.trunc(size)))
    let offset = 0
    for (const item of list) {
      const rest = bytes.length - offset
      if (rest <= 0) {
        break
      }
      bytes.set(item.subarray(0, rest), offset)
      offset += item.byteLength
    }
    return bytes
  },
  isBuffer: (value: unknown): boolean => value instanceof VmBuffer,
  byteLength: (input: unknown, encoding = 'utf8'): number =>
    typeof input === 'string' ? encodeWith(input, encoding).byteLength : toBytes(input).byteLength,
  isEncoding: (encoding: string): boolean =>
    ['utf8', 'utf-8', 'hex', 'base64', 'latin1', 'binary', 'ascii'].includes(
      encoding.toLowerCase()
    ),
}

// ---------- 错误 ----------

type NodeError = Error & { code: string; path?: string; syscall?: string; errno?: number }

const ERRNO_MESSAGE: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EISDIR: 'illegal operation on a directory',
  ENOTDIR: 'not a directory',
  EEXIST: 'file already exists',
  ENOTEMPTY: 'directory not empty',
  EPERM: 'operation not permitted',
  EACCES: 'permission denied',
  EINVAL: 'invalid argument',
}

const fsError = (code: string, syscall: string, path: string): NodeError => {
  const error = new Error(
    `${code}: ${ERRNO_MESSAGE[code] ?? 'filesystem error'}, ${syscall} '${path}'`
  ) as NodeError
  error.code = code
  error.syscall = syscall
  error.path = path
  return error
}

/** process.exit() 用它把控制流从用户脚本里抛出来 */
class ExitSignal extends Error {
  readonly code: number

  constructor(code: number) {
    super(`process.exit(${code})`)
    this.name = 'ExitSignal'
    this.code = code
  }
}

/** 退出码按 POSIX 习惯截断到 0–255 */
const normalizeExitCode = (code: number): number => {
  if (!Number.isFinite(code)) {
    return 0
  }
  const value = Math.trunc(code)
  return ((value % 256) + 256) % 256
}

// ---------- 虚拟文件系统 ----------

type StatResult = {
  dev: number
  mode: number
  nlink: number
  uid: number
  gid: number
  rdev: number
  size: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  atime: Date
  mtime: Date
  ctime: Date
  birthtime: Date
  isFile: () => boolean
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
}

/** 沙箱内部的只读/可写文件表，按绝对路径存字节 */
class SandboxFs {
  private files = new Map<string, Uint8Array>()
  private dirs = new Set<string>(['/'])
  private written = new Set<string>()
  private deleted = new Set<string>()

  constructor(files: SandboxFileMap) {
    for (const [path, bytes] of Object.entries(files)) {
      this.files.set(normalizePath(path), new Uint8Array(bytes))
      this.rememberDirs(normalizePath(path))
    }
  }

  private rememberDirs = (path: string) => {
    const segments = path.split('/').filter(Boolean)
    let current = ''
    for (let index = 0; index < segments.length - 1; index += 1) {
      current += `/${segments[index]}`
      this.dirs.add(current)
    }
  }

  writtenPaths = (): string[] => [...this.written]

  deletedPaths = (): string[] => [...this.deleted]

  hasFile = (path: string): boolean => this.files.has(path)

  hasDir = (path: string): boolean => this.dirs.has(path)

  peek = (path: string): Uint8Array | undefined => this.files.get(path)

  readFile = (path: string): Uint8Array => {
    const bytes = this.files.get(path)
    if (!bytes) {
      if (this.dirs.has(path)) {
        throw fsError('EISDIR', 'read', path)
      }
      throw fsError('ENOENT', 'open', path)
    }
    return new Uint8Array(bytes)
  }

  writeFile = (path: string, data: Uint8Array) => {
    if (this.dirs.has(path)) {
      throw fsError('EISDIR', 'open', path)
    }
    const parent = dirNameOf(path)
    if (!this.dirs.has(parent)) {
      throw fsError('ENOENT', 'open', path)
    }
    this.files.set(path, new Uint8Array(data))
    this.written.add(path)
    this.deleted.delete(path)
  }

  appendFile = (path: string, data: Uint8Array) => {
    const previous = this.files.get(path) ?? new Uint8Array(0)
    const merged = new Uint8Array(previous.byteLength + data.byteLength)
    merged.set(previous, 0)
    merged.set(data, previous.byteLength)
    this.writeFile(path, merged)
  }

  unlink = (path: string) => {
    if (this.dirs.has(path)) {
      throw fsError('EISDIR', 'unlink', path)
    }
    if (!this.files.has(path)) {
      throw fsError('ENOENT', 'unlink', path)
    }
    this.files.delete(path)
    this.written.delete(path)
    this.deleted.add(path)
  }

  mkdir = (path: string, recursive = false) => {
    if (this.files.has(path)) {
      throw fsError('EEXIST', 'mkdir', path)
    }
    if (this.dirs.has(path)) {
      if (recursive) {
        return
      }
      throw fsError('EEXIST', 'mkdir', path)
    }
    if (recursive) {
      const segments = path.split('/').filter(Boolean)
      let current = ''
      for (const segment of segments) {
        current += `/${segment}`
        if (this.files.has(current)) {
          throw fsError('ENOTDIR', 'mkdir', current)
        }
        this.dirs.add(current)
      }
      return
    }
    const parent = dirNameOf(path)
    if (!this.dirs.has(parent)) {
      throw fsError('ENOENT', 'mkdir', path)
    }
    this.dirs.add(path)
  }

  removeTree = (path: string, recursive: boolean) => {
    if (this.files.has(path)) {
      this.unlink(path)
      return
    }
    if (!this.dirs.has(path)) {
      throw fsError('ENOENT', 'rm', path)
    }
    const children = this.list(path)
    if (children.length > 0 && !recursive) {
      throw fsError('ENOTEMPTY', 'rm', path)
    }
    const prefix = path === '/' ? '/' : `${path}/`
    for (const entry of [...this.files.keys()]) {
      if (entry === path || entry.startsWith(prefix)) {
        this.files.delete(entry)
        this.written.delete(entry)
        this.deleted.add(entry)
      }
    }
    for (const entry of [...this.dirs]) {
      if (entry === path || entry.startsWith(prefix)) {
        this.dirs.delete(entry)
      }
    }
  }

  /** 列目录下的名字（文件与目录都有） */
  list = (path: string): string[] => {
    if (!this.dirs.has(path)) {
      if (this.files.has(path)) {
        throw fsError('ENOTDIR', 'scandir', path)
      }
      throw fsError('ENOENT', 'scandir', path)
    }
    const prefix = path === '/' ? '/' : `${path}/`
    const names = new Set<string>()
    for (const entry of this.files.keys()) {
      if (entry.startsWith(prefix)) {
        const rest = entry.slice(prefix.length)
        if (rest && !rest.includes('/')) {
          names.add(rest)
        }
      }
    }
    for (const entry of this.dirs) {
      if (entry !== path && entry.startsWith(prefix)) {
        const rest = entry.slice(prefix.length)
        if (rest && !rest.includes('/')) {
          names.add(rest)
        }
      }
    }
    return [...names].sort()
  }

  stat = (path: string): StatResult => {
    const size = this.files.get(path)?.byteLength ?? 0
    const isFile = this.files.has(path)
    const isDirectory = this.dirs.has(path)
    if (!isFile && !isDirectory) {
      throw fsError('ENOENT', 'stat', path)
    }
    const now = Date.now()
    return {
      dev: 1,
      mode: isDirectory ? 0o40755 : 0o100644,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now,
      atime: new Date(now),
      mtime: new Date(now),
      ctime: new Date(now),
      birthtime: new Date(now),
      isFile: () => isFile,
      isDirectory: () => isDirectory,
      isSymbolicLink: () => false,
    }
  }

  rename = (from: string, to: string) => {
    const bytes = this.readFile(from)
    this.writeFile(to, bytes)
    this.files.delete(from)
    this.written.delete(from)
    this.deleted.add(from)
  }
}

// ---------- 输出 ----------

type Sink = {
  write: (text: string) => void
  flush: () => void
}

const createSink = (emit: (text: string) => void): Sink => {
  let buffer = ''
  const sink: Sink = {
    write: (text: string) => {
      buffer += text
      if (buffer.length >= SINK_FLUSH_CHARS || buffer.endsWith('\n')) {
        emit(buffer)
        buffer = ''
      }
    },
    flush: () => {
      if (buffer) {
        emit(buffer)
        buffer = ''
      }
    },
  }
  return sink
}

// ---------- 值格式化（console） ----------

const inspectValue = (value: unknown, depth = 0): string => {
  if (typeof value === 'string') {
    return depth === 0 ? value : `'${value}'`
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (typeof value === 'undefined') {
    return 'undefined'
  }
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'function') {
    const named = value.name || 'anonymous'
    return `[Function: ${named}]`
  }
  if (typeof value === 'symbol') {
    return value.toString()
  }
  if (value instanceof Error) {
    return value.stack
      ? value.stack.split('\n').slice(0, 4).join('\n')
      : `${value.name}: ${value.message}`
  }
  if (value instanceof Uint8Array) {
    const head = [...value.subarray(0, 24)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' ')
    return value.byteLength > 24 ? `<Buffer ${head} ...>` : `<Buffer ${head}>`
  }
  if (depth >= 3) {
    return Array.isArray(value) ? '[Array]' : '[Object]'
  }
  if (Array.isArray(value)) {
    return `[ ${value.map((item) => inspectValue(item, depth + 1)).join(', ')} ]`
  }
  if (value instanceof Map) {
    return `Map(${value.size}) { ${[...value.entries()]
      .map(([key, item]) => `${inspectValue(key, depth + 1)} => ${inspectValue(item, depth + 1)}`)
      .join(', ')} }`
  }
  if (value instanceof Set) {
    return `Set(${value.size}) { ${[...value.values()]
      .map((item) => inspectValue(item, depth + 1))
      .join(', ')} }`
  }
  const record = value as Record<string, unknown>
  const entries = Object.keys(record).map(
    (key) => `${key}: ${inspectValue(record[key], depth + 1)}`
  )
  return `{ ${entries.join(', ')} }`
}

/** 支持 %s %d %i %f %j %o %O %% 的 console 格式化，其余参数按空格拼接 */
const formatArgs = (args: unknown[]): string => {
  if (args.length === 0) {
    return ''
  }
  const first = args[0]
  if (typeof first !== 'string' || !first.includes('%')) {
    return args.map((value) => inspectValue(value)).join(' ')
  }
  let rest = 1
  const text = first.replace(/%([sdifjjoO%])/g, (match, token: string) => {
    if (token === '%') {
      return '%'
    }
    if (rest >= args.length) {
      return match
    }
    const value = args[rest]
    rest += 1
    if (token === 'd' || token === 'i') {
      return String(Number(value))
    }
    if (token === 'f') {
      return String(Number(value))
    }
    if (token === 'j') {
      try {
        return JSON.stringify(value) ?? String(value)
      } catch {
        return '[Circular]'
      }
    }
    if (token === 'o' || token === 'O') {
      return inspectValue(value)
    }
    return inspectValue(value)
  })
  const tail = args.slice(rest).map((value) => inspectValue(value))
  return tail.length > 0 ? `${text} ${tail.join(' ')}` : text
}

// ---------- 定时器 ----------

class TimerRegistry {
  private timeouts = new Map<number, ReturnType<typeof setTimeout>>()
  private intervals = new Map<number, ReturnType<typeof setInterval>>()
  private nextId = 1
  private onError: (error: unknown) => void

  constructor(onError: (error: unknown) => void) {
    this.onError = onError
  }

  setTimeout = (callback: unknown, delay = 0, ...args: unknown[]): number => {
    const id = this.nextId
    this.nextId += 1
    if (typeof callback !== 'function') {
      return id
    }
    const handle = setTimeout(
      () => {
        this.timeouts.delete(id)
        try {
          ;(callback as (...params: unknown[]) => void)(...args)
        } catch (error) {
          // 定时器里的异常在真 Node 里会让进程非零退出，这里同样上报
          this.onError(error)
        }
      },
      Math.max(0, Number(delay) || 0)
    )
    this.timeouts.set(id, handle)
    return id
  }

  clearTimeout = (id: unknown): void => {
    const handle = this.timeouts.get(Number(id))
    if (handle !== undefined) {
      clearTimeout(handle)
      this.timeouts.delete(Number(id))
    }
  }

  setInterval = (callback: unknown, delay = 0, ...args: unknown[]): number => {
    const id = this.nextId
    this.nextId += 1
    if (typeof callback !== 'function') {
      return id
    }
    const handle = setInterval(
      () => {
        try {
          ;(callback as (...params: unknown[]) => void)(...args)
        } catch (error) {
          this.onError(error)
        }
      },
      Math.max(1, Number(delay) || 0)
    )
    this.intervals.set(id, handle)
    return id
  }

  clearInterval = (id: unknown): void => {
    const handle = this.intervals.get(Number(id))
    if (handle !== undefined) {
      clearInterval(handle)
      this.intervals.delete(Number(id))
    }
  }

  clearAll = (): void => {
    for (const handle of this.timeouts.values()) {
      clearTimeout(handle)
    }
    for (const handle of this.intervals.values()) {
      clearInterval(handle)
    }
    this.timeouts.clear()
    this.intervals.clear()
  }

  /**
   * 等脚本里挂着的 setTimeout 跑完。
   * setInterval 不算「还在跑」——否则任何定时器都会把脚本永远挂住。
   */
  drain = async (
    deadline: number,
    shouldAbort: () => boolean
  ): Promise<'idle' | 'timeout' | 'aborted'> => {
    while (this.timeouts.size > 0) {
      if (shouldAbort()) {
        return 'aborted'
      }
      if (Date.now() > deadline) {
        return 'timeout'
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 4)
      })
    }
    if (shouldAbort()) {
      return 'aborted'
    }
    // 让最后一批微任务（nextTick / Promise）跑完再收尾
    await Promise.resolve()
    return 'idle'
  }
}

// ---------- 模块 ----------

const createPathModule = (getCwd: () => string) => {
  const extname = (path: string): string => {
    const name = baseNameOf(path)
    const index = name.lastIndexOf('.')
    if (index <= 0) {
      return ''
    }
    return name.slice(index)
  }
  const basename = (path: string, ext?: string): string => {
    const name = baseNameOf(path)
    if (ext && name.endsWith(ext) && name !== ext) {
      return name.slice(0, -ext.length)
    }
    return name
  }
  const relative = (from: string, to: string): string => {
    const source = normalizePath(from).split('/').filter(Boolean)
    const target = normalizePath(to).split('/').filter(Boolean)
    let common = 0
    while (common < source.length && common < target.length && source[common] === target[common]) {
      common += 1
    }
    const up = source.slice(common).map(() => '..')
    return [...up, ...target.slice(common)].join('/') || ''
  }
  const pathModule = {
    sep: '/',
    delimiter: ':',
    posix: null as unknown,
    join: (...parts: string[]): string => joinRelative(parts),
    resolve: (...parts: string[]): string => {
      let result = ''
      for (const part of parts) {
        result = isAbsolutePath(part) ? part : `${result}/${part}`
      }
      return result ? resolvePath(getCwd(), result) : getCwd()
    },
    normalize: (path: string): string => normalizePath(path),
    isAbsolute: (path: string): boolean => isAbsolutePath(path),
    basename,
    dirname: (path: string): string => dirNameOf(path),
    extname,
    relative,
    parse: (path: string) => {
      const dir = dirNameOf(path)
      const base = baseNameOf(path)
      const ext = extname(path)
      return { root: '/', dir, base, ext, name: ext ? base.slice(0, -ext.length) : base }
    },
  }
  pathModule.posix = pathModule
  return pathModule
}

type FsModuleOptions = {
  fs: SandboxFs
  getCwd: () => string
}

const createFsModule = ({ fs, getCwd }: FsModuleOptions) => {
  const withEncoding = (bytes: Uint8Array, encoding?: string): string | Uint8Array =>
    encoding ? decodeWith(bytes, encoding) : asBuffer(bytes)

  const readFileSync = (
    path: string,
    options?: string | { encoding?: string }
  ): string | Uint8Array => {
    const encoding = typeof options === 'string' ? options : options?.encoding
    return withEncoding(fs.readFile(resolvePath(getCwd(), path)), encoding)
  }

  const writeFileSync = (
    path: string,
    data: unknown,
    options?: string | { encoding?: string }
  ): void => {
    const encoding = typeof options === 'string' ? options : options?.encoding
    const bytes = typeof data === 'string' ? encodeWith(data, encoding) : toBytes(data)
    fs.writeFile(resolvePath(getCwd(), path), bytes)
  }

  const mkdirSync = (path: string, options?: { recursive?: boolean } | number): void => {
    const recursive =
      typeof options === 'object' && options !== null ? options.recursive === true : false
    fs.mkdir(resolvePath(getCwd(), path), recursive)
  }

  const rmSync = (path: string, options?: { recursive?: boolean; force?: boolean }): void => {
    const target = resolvePath(getCwd(), path)
    const recursive = options?.recursive === true
    try {
      fs.removeTree(target, recursive)
    } catch (error) {
      if (options?.force === true && (error as NodeError).code === 'ENOENT') {
        return
      }
      throw error
    }
  }

  return {
    readFileSync,
    writeFileSync,
    appendFileSync: (
      path: string,
      data: unknown,
      options?: string | { encoding?: string }
    ): void => {
      const encoding = typeof options === 'string' ? options : options?.encoding
      const bytes = typeof data === 'string' ? encodeWith(data, encoding) : toBytes(data)
      fs.appendFile(resolvePath(getCwd(), path), bytes)
    },
    readdirSync: (path: string, options?: { withFileTypes?: boolean }): unknown[] => {
      const names = fs.list(resolvePath(getCwd(), path))
      if (options?.withFileTypes !== true) {
        return names
      }
      const base = resolvePath(getCwd(), path)
      return names.map((name) => {
        const stat = fs.stat(joinPaths(base, name))
        return { name, isFile: stat.isFile, isDirectory: stat.isDirectory }
      })
    },
    existsSync: (path: string): boolean => {
      const target = resolvePath(getCwd(), path)
      return fs.hasFile(target) || fs.hasDir(target)
    },
    statSync: (path: string) => fs.stat(resolvePath(getCwd(), path)),
    lstatSync: (path: string) => fs.stat(resolvePath(getCwd(), path)),
    unlinkSync: (path: string): void => fs.unlink(resolvePath(getCwd(), path)),
    mkdirSync,
    mkdtempSync: (prefix: string): string => {
      const base = resolvePath(getCwd(), prefix)
      const target = `${base}-${Math.random().toString(36).slice(2, 8)}`
      fs.mkdir(target, true)
      return target
    },
    rmSync,
    rmdirSync: (path: string): void => fs.removeTree(resolvePath(getCwd(), path), false),
    renameSync: (from: string, to: string): void =>
      fs.rename(resolvePath(getCwd(), from), resolvePath(getCwd(), to)),
    copyFileSync: (from: string, to: string): void =>
      fs.writeFile(resolvePath(getCwd(), to), fs.readFile(resolvePath(getCwd(), from))),
    realpathSync: (path: string): string => resolvePath(getCwd(), path),
    createReadStream: () => {
      throw new Error('fs.createReadStream 不在 NanoVM 的 Node 子集里，请用 readFileSync')
    },
    createWriteStream: () => {
      throw new Error('fs.createWriteStream 不在 NanoVM 的 Node 子集里，请用 writeFileSync')
    },
    promises: null as unknown,
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
  }
}

// ---------- 沙箱执行 ----------

/** 用户脚本拿到的参数名（顺序与调用处一致） */
const SANDBOX_ARGS = [
  'exports',
  'require',
  'module',
  '__filename',
  '__dirname',
  'process',
  'console',
  'Buffer',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'global',
] as const

const formatThrown = (error: unknown): string => {
  if (error instanceof Error) {
    const stack = error.stack ?? `${error.name}: ${error.message}`
    // 只保留用户脚本相关的几帧，避免把沙箱内部实现暴露给用户
    const lines = stack.split('\n')
    const head = lines[0] ?? `${error.name}: ${error.message}`
    const frames = lines
      .slice(1)
      .filter(
        (line) => line.includes('eval') || line.includes('Function') || line.includes('anonymous')
      )
      .slice(0, 4)
    return [head, ...frames].join('\n')
  }
  return `Uncaught ${inspectValue(error)}`
}

/**
 * 执行一段 Node 风格脚本，返回退出码与文件改动。
 * 这是 Worker 与主线程回落共用的实现。
 */
export const executeNode = async (options: SandboxOptions): Promise<SandboxOutcome> => {
  const fs = new SandboxFs(options.files)
  const stdout = createSink(options.onStdout)
  const stderr = createSink(options.onStderr)
  const state = {
    cwd: normalizePath(options.cwd || '/home/user'),
    env: { ...options.env },
  }
  let asyncExit: number | null = null
  let asyncFailed = false
  const timers = new TimerRegistry((error) => {
    if (error instanceof ExitSignal) {
      asyncExit = normalizeExitCode(error.code)
      timers.clearAll()
      return
    }
    asyncFailed = true
    stderr.write(`${formatThrown(error)}\n`)
    timers.clearAll()
  })
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const deadline = Date.now() + timeoutMs
  const shouldAbort = options.shouldAbort ?? (() => false)

  // `<eval>` / `<stdin>` 这种伪路径保持原样，别当成真实文件解析
  const rawScript = options.scriptPath || 'index.js'
  const scriptPath = rawScript.startsWith('<') ? rawScript : resolvePath(state.cwd, rawScript)
  // 工作目录与脚本目录在沙箱里必须存在，否则脚本一开始就写不了相对路径的文件
  for (const dir of [state.cwd, dirNameOf(scriptPath)]) {
    try {
      fs.mkdir(dir, true)
    } catch {
      // 已存在
    }
  }

  const pathModule = createPathModule(() => state.cwd)
  const fsModule = createFsModule({ fs, getCwd: () => state.cwd })

  const processApi: Record<string, unknown> = {
    argv: ['/usr/local/bin/node', scriptPath, ...options.argv],
    env: state.env,
    platform: NODE_PLATFORM,
    arch: 'wasm',
    version: `v${NODE_VERSION}`,
    versions: { node: NODE_VERSION, nanovm: '2.7.0' },
    pid: 1,
    exitCode: 0,
    title: 'node',
    cwd: () => state.cwd,
    chdir: (path: string) => {
      const next = resolvePath(state.cwd, path)
      if (!fs.hasDir(next)) {
        throw fsError('ENOENT', 'chdir', next)
      }
      state.cwd = next
    },
    exit: (code?: number) => {
      throw new ExitSignal(typeof code === 'number' ? code : Number(processApi.exitCode ?? 0))
    },
    abort: () => {
      throw new ExitSignal(130)
    },
    stdout: {
      write: (text: string): boolean => {
        stdout.write(String(text))
        return true
      },
      isTTY: false,
      columns: 80,
    },
    stderr: {
      write: (text: string): boolean => {
        stderr.write(String(text))
        return true
      },
      isTTY: false,
      columns: 80,
    },
    stdin: { isTTY: false, readable: false, on: () => processApi, read: () => null },
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      queueMicrotask(() => callback(...args))
    },
    hrtime: Object.assign(
      () => {
        const ms = performance.now()
        return [Math.floor(ms / 1000), Math.round((ms % 1000) * 1_000_000)]
      },
      { bigint: () => BigInt(Math.round(performance.now() * 1_000_000)) }
    ),
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
    uptime: () => Math.max(0, (Date.now() - (deadline - timeoutMs)) / 1000),
    on: () => processApi,
    once: () => processApi,
    off: () => processApi,
    emit: () => false,
    removeListener: () => processApi,
    removeAllListeners: () => processApi,
  }

  const consoleApi = (() => {
    const writes = (target: Sink, values: unknown[]) => target.write(`${formatArgs(values)}\n`)
    const timeLabels = new Map<string, number>()
    return {
      log: (...values: unknown[]) => writes(stdout, values),
      info: (...values: unknown[]) => writes(stdout, values),
      debug: (...values: unknown[]) => writes(stdout, values),
      dir: (value: unknown) => writes(stdout, [inspectValue(value)]),
      table: (value: unknown) => writes(stdout, [inspectValue(value)]),
      trace: (...values: unknown[]) => writes(stderr, ['Trace:', ...values]),
      warn: (...values: unknown[]) => writes(stderr, values),
      error: (...values: unknown[]) => writes(stderr, values),
      assert: (condition: unknown, ...values: unknown[]) => {
        if (!condition) {
          writes(stderr, ['Assertion failed', ...values])
        }
      },
      time: (label = 'default') => {
        timeLabels.set(label, performance.now())
      },
      timeEnd: (label = 'default') => {
        const started = timeLabels.get(label)
        timeLabels.delete(label)
        if (started !== undefined) {
          writes(stdout, [`${label}: ${(performance.now() - started).toFixed(3)}ms`])
        }
      },
      group: () => undefined,
      groupEnd: () => undefined,
      count: () => undefined,
    }
  })()

  const moduleObject = {
    exports: {} as Record<string, unknown>,
    id: scriptPath,
    filename: scriptPath,
    loaded: false,
  }
  const moduleCache = new Map<string, unknown>()

  const nodeModules: Record<string, unknown> = {
    fs: fsModule,
    'fs/promises': fsModule,
    path: pathModule,
    'path/posix': pathModule,
    process: processApi,
    buffer: { Buffer: BufferApi },
    os: {
      EOL: '\n',
      platform: () => NODE_PLATFORM,
      type: () => 'NanoVM',
      arch: () => 'wasm',
      cpus: () => [{ model: 'NanoVM virtual CPU', speed: 1000 }],
      tmpdir: () => '/tmp',
      homedir: () => '/home/user',
      hostname: () => 'nanovm',
      release: () => '2.7.0',
    },
    util: {
      format: (...values: unknown[]): string => formatArgs(values),
      inspect: (value: unknown): string => inspectValue(value),
      isDeepStrictEqual: (left: unknown, right: unknown): boolean =>
        JSON.stringify(left) === JSON.stringify(right),
      TextEncoder,
      TextDecoder,
    },
    events: {
      EventEmitter: class EventEmitter {
        private handlers = new Map<string, ((...args: unknown[]) => void)[]>()

        on(event: string, handler: (...args: unknown[]) => void) {
          const list = this.handlers.get(event) ?? []
          list.push(handler)
          this.handlers.set(event, list)
          return this
        }

        once(event: string, handler: (...args: unknown[]) => void) {
          return this.on(event, handler)
        }

        off(event: string, handler: (...args: unknown[]) => void) {
          const list = (this.handlers.get(event) ?? []).filter((item) => item !== handler)
          this.handlers.set(event, list)
          return this
        }

        emit(event: string, ...args: unknown[]): boolean {
          const list = this.handlers.get(event) ?? []
          for (const handler of list) {
            handler(...args)
          }
          return list.length > 0
        }
      },
    },
  }

  const requireModule = (id: string): unknown => {
    const name = id.startsWith('node:') ? id.slice(5) : id
    if (moduleCache.has(name)) {
      return moduleCache.get(name)
    }
    const found = nodeModules[name]
    if (found === undefined) {
      const error = new Error(`Cannot find module '${id}'`) as Error & { code: string }
      error.code = 'MODULE_NOT_FOUND'
      throw error
    }
    moduleCache.set(name, found)
    return found
  }

  const globalObject = {
    process: processApi,
    console: consoleApi,
    Buffer: BufferApi,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    require: requireModule,
    __dirname: dirNameOf(scriptPath),
    __filename: scriptPath,
  }

  let code = 0
  let timedOut = false
  let aborted = false

  try {
    const factory = new Function(
      SANDBOX_ARGS.join(','),
      `${options.code}\n//# sourceURL=nanovm-node://${scriptPath}`
    ) as (...args: unknown[]) => unknown
    factory(
      moduleObject.exports,
      requireModule,
      moduleObject,
      scriptPath,
      dirNameOf(scriptPath),
      processApi,
      consoleApi,
      BufferApi,
      timers.setTimeout,
      timers.clearTimeout,
      timers.setInterval,
      timers.clearInterval,
      globalObject
    )
  } catch (error) {
    if (error instanceof ExitSignal) {
      code = normalizeExitCode(error.code)
    } else {
      stderr.write(`${formatThrown(error)}\n`)
      code = 1
    }
  }

  if (code === 0) {
    const idle = await timers.drain(deadline, shouldAbort)
    if (idle === 'timeout') {
      timedOut = true
      code = 124
      stderr.write(`node: 执行超时（超过 ${timeoutMs} 毫秒）\n`)
    } else if (idle === 'aborted') {
      aborted = true
      code = 130
      stderr.write('node: 已被中断\n')
    }
  }

  if (asyncExit !== null) {
    code = asyncExit
  } else if (asyncFailed && code === 0) {
    code = 1
  }

  timers.clearAll()
  stdout.flush()
  stderr.flush()

  const changed: SandboxFileMap = {}
  for (const path of fs.writtenPaths()) {
    const bytes = fs.peek(path)
    if (bytes) {
      changed[path] = bytes
    }
  }
  const removed = fs.deletedPaths().filter((path) => !(path in changed))

  return { code, files: changed, removed, timedOut, aborted }
}

// ---------- Worker 入口 ----------

type WorkerScope = {
  postMessage: (message: NodeSandboxMessage) => void
  addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void
}

/** 判断当前是不是 Worker 作用域；主线程与 Node 里都返回 null */
const workerScope = (): WorkerScope | null => {
  if (typeof window !== 'undefined') {
    return null
  }
  const scope = globalThis as unknown as Partial<WorkerScope>
  if (typeof scope.postMessage !== 'function' || typeof scope.addEventListener !== 'function') {
    return null
  }
  return scope as WorkerScope
}

const handleRequest = async (scope: WorkerScope, request: NodeSandboxRequest): Promise<void> => {
  try {
    const outcome = await executeNode({
      code: request.code,
      scriptPath: request.scriptPath,
      argv: request.argv,
      env: request.env,
      cwd: request.cwd,
      files: request.files,
      timeoutMs: request.timeoutMs,
      onStdout: (text) => scope.postMessage({ type: 'stdout', text }),
      onStderr: (text) => scope.postMessage({ type: 'stderr', text }),
    })
    scope.postMessage({ type: 'done', ...outcome })
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

const activeScope = workerScope()
if (activeScope) {
  activeScope.addEventListener('message', (event) => {
    const request = event.data as NodeSandboxRequest | null
    if (!request || request.type !== 'run') {
      return
    }
    void handleRequest(activeScope, request)
  })
}
