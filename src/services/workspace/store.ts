import { create } from 'zustand'
import {
  isNativeApp as nativeApp,
  opfsClear,
  opfsDeleteFile,
  opfsReadAll,
  opfsSupported,
  opfsWriteAll,
  opfsWriteFile,
} from './opfs.js'

/**
 * 虚拟长期文件工作区：完全活在浏览器存储里的一个「文件系统」。
 *
 * v2 起不再限制格式：
 * - 文本文件直接存字符串；
 * - 图片、PDF、压缩包等二进制存 base64（localStorage 模式）或原始字节（OPFS 模式）。
 * 两条后端都按同一份内存状态展示，导入导出支持任意文件与 ZIP。
 *
 * 容量限制按模式区分，避免把 localStorage 写爆；OPFS 模式容量更大。
 */

const STORE_KEY = 'chat-demo:workspace'
const ENABLED_KEY = 'chat-demo:workspace-enabled'
const MODE_KEY = 'chat-demo:workspace-mode'

/** 工作区底层存储：浏览器 localStorage 或 OPFS 真文件系统 */
export type WorkspaceMode = 'local' | 'opfs'

const MB = 1024 * 1024
const GB = 1024 * MB

/**
 * 容量上限：
 * - OPFS 按浏览器实际配额动态计算（留 20% 给其它数据），配额越大可用越大；
 * - localStorage 无法扩容，给一个接近浏览器真实上限的软限制，写满时明确报错。
 */
export type WorkspaceLimits = {
  file: number
  total: number
  files: number
  /** quota：按 storage.estimate() 算出来的；default：浏览器没给配额时的兜底 */
  source: 'quota' | 'default'
}

const LOCAL_LIMITS: WorkspaceLimits = { file: 4 * MB, total: 5 * MB, files: 200, source: 'default' }
const OPFS_FALLBACK: WorkspaceLimits = {
  file: 256 * MB,
  total: 4 * GB,
  files: 2000,
  source: 'default',
}

export const computeWorkspaceLimits = (
  mode: WorkspaceMode,
  quota: number | null
): WorkspaceLimits => {
  if (mode !== 'opfs') {
    return LOCAL_LIMITS
  }
  if (!quota || !Number.isFinite(quota) || quota <= 0) {
    return OPFS_FALLBACK
  }
  // 浏览器里最多用 80% 配额（上限 64GB 总量 / 256MB 单文件，单文件要整体读入内存）；
  // 安卓壳的数据不会被站点清理策略回收，放宽到 90% 配额、单文件最多 2GB。
  const native = nativeApp()
  const total = native
    ? Math.max(1 * GB, Math.floor(quota * 0.9))
    : Math.min(64 * GB, Math.max(512 * MB, Math.floor(quota * 0.8)))
  const file = native
    ? Math.min(2 * GB, Math.max(64 * MB, Math.floor(total / 8)))
    : Math.min(256 * MB, Math.max(64 * MB, Math.floor(total / 32)))
  return { file, total, files: native ? 20000 : 2000, source: 'quota' }
}

export type FileEncoding = 'text' | 'base64'

export type WorkspaceFile = {
  /** 相对路径，例如 notes/todo.md */
  path: string
  /** text：明文；base64：二进制按 base64 保存 */
  encoding: FileEncoding
  /** 文本内容或 base64 字符串 */
  content: string
  /** 字节数（二进制为解码后的真实大小） */
  size: number
  mime: string
  createdAt: number
  updatedAt: number
  /** 进入工作区时的初始内容，用于「查看 diff」（仅文本） */
  baseline?: string
}

type WorkspaceState = {
  enabled: boolean
  mode: WorkspaceMode
  hydrated: boolean
  /** 浏览器给当前 Origin 的存储配额（字节），用于动态计算上限 */
  quota: number | null
  persistError: string | null
  files: Record<string, WorkspaceFile>
}

/** 导出包格式（JSON，兼容旧版）：只含文本或 base64 */
export type WorkspaceArchive = {
  kind: 'chat-demo-workspace'
  version: 2
  exportedAt: string
  files: {
    path: string
    content: string
    encoding?: FileEncoding
    mime: string
    updatedAt: number
  }[]
}

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  js: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  css: 'text/css',
  sh: 'text/x-shellscript',
  toml: 'text/toml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export const mimeForPath = (path: string): string => {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** 规范化路径：去掉开头斜杠、折叠多余分隔符，拒绝越界路径 */
export const normalizeWorkspacePath = (input: string): string | null => {
  const raw = input.trim().replace(/\\/g, '/')
  if (raw === '') {
    return null
  }
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    return null
  }
  const parts: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      return null
    }
    parts.push(segment)
  }
  if (parts.length === 0) {
    return null
  }
  const path = parts.join('/')
  return path.length > 200 ? path.slice(0, 200) : path
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

const base64ToBytes = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xml',
  'yml',
  'yaml',
  'toml',
  'ini',
  'conf',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'sql',
  'svg',
  'log',
  'gitignore',
  'env',
])

const extOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 明确按文本处理：已知文本扩展名或文本类 MIME */
const isTextMime = (mime: string, path: string): boolean => {
  const ext = extOf(path)
  if (ext && TEXT_EXTS.has(ext)) {
    return true
  }
  return (
    mime.startsWith('text/') ||
    mime === 'image/svg+xml' ||
    mime === 'application/json' ||
    mime === 'application/ld+json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/x-javascript' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml')
  )
}

/** 把任意文件内容转成可持久化的文本 / base64 形态 */
export const fileToContent = (
  bytes: Uint8Array,
  mime: string,
  path = ''
): { encoding: FileEncoding; content: string; size: number } => {
  const head = bytes.subarray(0, 4096)
  let binary = head.includes(0)
  const ext = extOf(path)
  // 浏览器只给 octet-stream 且扩展名不是常见文本：按二进制处理，避免把 .bin/.webm 误判成文本
  if (
    !binary &&
    (mime === '' || mime === 'application/octet-stream') &&
    ext !== '' &&
    !TEXT_EXTS.has(ext)
  ) {
    binary = true
  }
  if (!binary && !isTextMime(mime, path)) {
    // 没有 NUL 也不一定是文本：控制字符占比高就按二进制处理
    let control = 0
    for (const byte of head) {
      if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
        control += 1
      }
    }
    binary = control > Math.max(8, head.length * 0.02)
  }
  if (!binary) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return { encoding: 'text', content: text, size: bytes.length }
    } catch {
      binary = true
    }
  }
  return { encoding: 'base64', content: bytesToBase64(bytes), size: bytes.length }
}

/** 读取文件最终字节：文本按 UTF-8 编码，base64 解码 */
export const workspaceFileBytes = (file: WorkspaceFile): Uint8Array<ArrayBuffer> =>
  file.encoding === 'base64' ? base64ToBytes(file.content) : new TextEncoder().encode(file.content)

export const isTextFile = (file: WorkspaceFile): boolean => file.encoding === 'text'

const totalBytes = (files: Record<string, WorkspaceFile>): number =>
  Object.values(files).reduce((sum, file) => sum + file.size, 0)

const readFiles = (): Record<string, WorkspaceFile> => {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    const entries =
      typeof parsed === 'object' && parsed !== null && 'files' in parsed
        ? (parsed as { files: unknown }).files
        : parsed
    if (typeof entries !== 'object' || entries === null) {
      return {}
    }
    const files: Record<string, WorkspaceFile> = {}
    for (const [path, value] of Object.entries(entries as Record<string, unknown>)) {
      const item = value as Partial<WorkspaceFile>
      if (typeof item?.content !== 'string') {
        continue
      }
      const safePath = normalizeWorkspacePath(path)
      if (!safePath) {
        continue
      }
      const encoding: FileEncoding = item.encoding === 'base64' ? 'base64' : 'text'
      const size =
        typeof item.size === 'number' && item.size >= 0
          ? item.size
          : encoding === 'text'
            ? byteLength(item.content)
            : Math.floor((item.content.length * 3) / 4)
      files[safePath] = {
        path: safePath,
        encoding,
        content: item.content,
        size,
        mime: typeof item.mime === 'string' ? item.mime : mimeForPath(safePath),
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
        baseline: typeof item.baseline === 'string' ? item.baseline : undefined,
      }
    }
    return files
  } catch {
    return {}
  }
}

const writeFiles = (files: Record<string, WorkspaceFile>): boolean => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ version: 2, files }))
    return true
  } catch (error) {
    // 配额写满（QuotaExceededError）：把原因留给调用方展示，不要静默丢数据
    useWorkspace.setState({
      persistError: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

const readMode = (): WorkspaceMode =>
  localStorage.getItem(MODE_KEY) === 'opfs' && opfsSupported() ? 'opfs' : 'local'

export const useWorkspace = create<WorkspaceState>(() => ({
  enabled: localStorage.getItem(ENABLED_KEY) === 'true',
  mode: readMode(),
  hydrated: localStorage.getItem(MODE_KEY) !== 'opfs' || !opfsSupported(),
  quota: null,
  persistError: null,
  files: localStorage.getItem(MODE_KEY) === 'opfs' && opfsSupported() ? {} : readFiles(),
}))

/** 串行执行 OPFS 写操作，避免并发 createWritable 互相覆盖 */
let persistQueue: Promise<void> = Promise.resolve()

const queuePersist = (task: () => Promise<void>) => {
  persistQueue = persistQueue
    .then(task)
    .then(() => {
      if (useWorkspace.getState().persistError) {
        useWorkspace.setState({ persistError: null })
      }
    })
    .catch((error: unknown) => {
      useWorkspace.setState({
        persistError: error instanceof Error ? error.message : String(error),
      })
    })
}

export const setWorkspaceEnabled = (enabled: boolean) => {
  try {
    localStorage.setItem(ENABLED_KEY, String(enabled))
  } catch {
    // 隐私模式忽略
  }
  useWorkspace.setState({ enabled })
}

export const isWorkspaceEnabled = () => useWorkspace.getState().enabled

/** 当前模式的上限（OPFS 按实际配额动态计算） */
export const workspaceLimits = (): WorkspaceLimits =>
  computeWorkspaceLimits(useWorkspace.getState().mode, useWorkspace.getState().quota)

/** 读取浏览器配额并刷新上限；启动与打开设置页时调用 */
export const refreshWorkspaceQuota = async (): Promise<number | null> => {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    useWorkspace.setState({ quota: null })
    return null
  }
  try {
    const estimate = await navigator.storage.estimate()
    const quota = typeof estimate.quota === 'number' ? estimate.quota : null
    useWorkspace.setState({ quota })
    return quota
  } catch {
    useWorkspace.setState({ quota: null })
    return null
  }
}

export type SaveInput = string | { text?: string; bytes?: Uint8Array; mime?: string }

export type SaveResult =
  | { ok: true; file: WorkspaceFile; created: boolean }
  | { ok: false; reason: 'path' | 'tooLarge' | 'tooManyFiles' | 'totalTooLarge' | 'quota' }

/**
 * 写入文件：存在则覆盖并保留 baseline（首次创建时的内容），不存在则新建。
 * 支持文本与二进制；容量检查在写入前完成，失败时返回原因而不是静默截断。
 */
export const saveWorkspaceFile = (
  inputPath: string,
  input: SaveInput,
  options: { mime?: string } = {}
): SaveResult => {
  const path = normalizeWorkspacePath(inputPath)
  if (!path) {
    return { ok: false, reason: 'path' }
  }
  let encoding: FileEncoding = 'text'
  let content = ''
  let size = 0
  let mime = options.mime ?? mimeForPath(path)

  if (typeof input === 'string') {
    content = input
    size = byteLength(input)
  } else if (input.bytes) {
    mime = input.mime ?? mime
    const converted = fileToContent(input.bytes, mime, path)
    encoding = converted.encoding
    content = converted.content
    size = converted.size
  } else {
    content = input.text ?? ''
    size = byteLength(content)
    mime = input.mime ?? mime
  }

  const limits = workspaceLimits()
  if (size > limits.file) {
    return { ok: false, reason: 'tooLarge' }
  }
  const current = useWorkspace.getState().files
  const existing = current[path]
  if (!existing && Object.keys(current).length >= limits.files) {
    return { ok: false, reason: 'tooManyFiles' }
  }
  const totalAfter = totalBytes(current) - (existing?.size ?? 0) + size
  if (totalAfter > limits.total) {
    return { ok: false, reason: 'totalTooLarge' }
  }

  const now = Date.now()
  const file: WorkspaceFile = {
    path,
    encoding,
    content,
    size,
    mime,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    // 只有文本需要 diff 基线
    baseline:
      encoding === 'text'
        ? (existing?.baseline ?? (existing?.encoding === 'text' ? existing.content : content))
        : undefined,
  }
  const files = { ...current, [path]: file }
  if (useWorkspace.getState().mode === 'opfs') {
    useWorkspace.setState({ files })
    queuePersist(() => opfsWriteFile(path, workspaceFileBytes(file)))
  } else {
    // localStorage 先写成功再更新内存，避免界面显示已保存但刷新后丢失
    if (!writeFiles(files)) {
      return { ok: false, reason: 'quota' }
    }
    useWorkspace.setState({ files })
  }
  return { ok: true, file, created: !existing }
}

export const readWorkspaceFile = (inputPath: string): WorkspaceFile | null => {
  const path = normalizeWorkspacePath(inputPath)
  if (!path) {
    return null
  }
  return useWorkspace.getState().files[path] ?? null
}

export const deleteWorkspaceFile = (inputPath: string): boolean => {
  const path = normalizeWorkspacePath(inputPath)
  if (!path || !Object.hasOwn(useWorkspace.getState().files, path)) {
    return false
  }
  const rest = Object.fromEntries(
    Object.entries(useWorkspace.getState().files).filter(([key]) => key !== path)
  )
  useWorkspace.setState({ files: rest })
  if (useWorkspace.getState().mode === 'opfs') {
    queuePersist(() => opfsDeleteFile(path))
  } else {
    writeFiles(rest)
  }
  return true
}

/** 列表按路径排序，供设置页与工具共用 */
export const listWorkspaceFiles = (): WorkspaceFile[] =>
  Object.values(useWorkspace.getState().files).sort((a, b) => a.path.localeCompare(b.path))

/** 工作区用量：字节数 + 文件数，设置页用来画占用条 */
export const workspaceUsage = (): { files: number; bytes: number } => {
  const files = useWorkspace.getState().files
  return { files: Object.keys(files).length, bytes: totalBytes(files) }
}

/** 给新文件找一个不冲突的路径：同名时追加 -1、-2 */
export const uniqueWorkspacePath = (inputPath: string): string => {
  const safe = normalizeWorkspacePath(inputPath) ?? 'file'
  const files = useWorkspace.getState().files
  if (!files[safe]) {
    return safe
  }
  const dot = safe.lastIndexOf('.')
  const base = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}-${index}${ext}`
    if (!files[candidate]) {
      return candidate
    }
  }
  return `${base}-${Date.now()}${ext}`
}

/**
 * 导入单个任意文件（来自文件选择器或拖拽）。
 * 返回实际路径与结果，调用方可据此提示。
 */
export const importWorkspaceFile = (
  name: string,
  bytes: Uint8Array,
  mime: string
): { path: string; ok: boolean; reason?: string } => {
  const path = uniqueWorkspacePath(name)
  const result = saveWorkspaceFile(path, { bytes, mime })
  return result.ok ? { path, ok: true } : { path, ok: false, reason: result.reason }
}

/** 导出：JSON 包（兼容旧版），二进制以 base64 内联 */
export const exportWorkspace = (): { name: string; blob: Blob } => {
  const archive: WorkspaceArchive = {
    kind: 'chat-demo-workspace',
    version: 2,
    exportedAt: new Date().toISOString(),
    files: listWorkspaceFiles().map((file) => ({
      path: file.path,
      content: file.content,
      encoding: file.encoding,
      mime: file.mime,
      updatedAt: file.updatedAt,
    })),
  }
  const name = `chat-demo-workspace-${new Date().toISOString().slice(0, 10)}.json`
  return {
    name,
    blob: new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }),
  }
}

export type ImportResult = { imported: number; skipped: number; error?: 'format' | 'tooMany' }

/**
 * 导入 JSON 归档（旧版备份格式）：merge 只覆盖同名文件，replace 先清空再导入。
 * 非本格式或字段不合法的条目跳过并计数，不让整次导入失败。
 */
export const importWorkspace = (text: string, mode: 'merge' | 'replace'): ImportResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { imported: 0, skipped: 0, error: 'format' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { imported: 0, skipped: 0, error: 'format' }
  }
  const record = parsed as Partial<WorkspaceArchive> & { files?: unknown }
  if (record.kind !== 'chat-demo-workspace' || !Array.isArray(record.files)) {
    return { imported: 0, skipped: 0, error: 'format' }
  }
  if (mode === 'replace') {
    clearWorkspace()
  }
  let imported = 0
  let skipped = 0
  for (const entry of record.files) {
    if (typeof entry !== 'object' || entry === null) {
      skipped += 1
      continue
    }
    const item = entry as Partial<WorkspaceArchive['files'][number]>
    const path = typeof item.path === 'string' ? normalizeWorkspacePath(item.path) : null
    if (!path || typeof item.content !== 'string') {
      skipped += 1
      continue
    }
    const encoding: FileEncoding = item.encoding === 'base64' ? 'base64' : 'text'
    const bytes =
      encoding === 'base64' ? base64ToBytes(item.content) : new TextEncoder().encode(item.content)
    const saved = saveWorkspaceFile(path, {
      bytes,
      mime: typeof item.mime === 'string' ? item.mime : mimeForPath(path),
    })
    if (saved.ok) {
      imported += 1
    } else {
      skipped += 1
    }
  }
  if (imported === 0 && skipped === 0) {
    return { imported: 0, skipped: 0, error: 'format' }
  }
  return { imported, skipped }
}

/** 批量导入任意文件；返回成功数量与跳过的文件 */
export const importWorkspaceFiles = (
  files: { name: string; bytes: Uint8Array; mime: string }[]
): { imported: number; skipped: number } => {
  let imported = 0
  let skipped = 0
  for (const item of files) {
    if (importWorkspaceFile(item.name, item.bytes, item.mime).ok) {
      imported += 1
    } else {
      skipped += 1
    }
  }
  return { imported, skipped }
}

export const clearWorkspace = () => {
  useWorkspace.setState({ files: {} })
  if (useWorkspace.getState().mode === 'opfs') {
    queuePersist(() => opfsClear())
  } else {
    writeFiles({})
  }
}

/** 启动时加载 OPFS 工作区；二进制按 base64 读入内存 */
/** 安卓壳里默认用 OPFS：localStorage 只有 5–10MB，跨不过「存储文件」这件事 */
const migrateNativeToOpfs = async (): Promise<void> => {
  if (!nativeApp() || !opfsSupported() || useWorkspace.getState().mode === 'opfs') {
    return
  }
  const files = useWorkspace.getState().files
  try {
    await opfsWriteAll(
      Object.fromEntries(
        Object.entries(files).map(([path, file]) => [path, workspaceFileBytes(file)])
      )
    )
    localStorage.setItem(MODE_KEY, 'opfs')
    useWorkspace.setState({ mode: 'opfs', files: {} })
  } catch {
    // 迁移失败就留在本地模式，不丢数据
  }
}

export const hydrateWorkspace = async (): Promise<void> => {
  await migrateNativeToOpfs()
  if (useWorkspace.getState().mode !== 'opfs' || !opfsSupported()) {
    useWorkspace.setState({ hydrated: true })
    return
  }
  try {
    const raw = await opfsReadAll()
    const now = Date.now()
    const files: Record<string, WorkspaceFile> = {}
    for (const [path, bytes] of Object.entries(raw)) {
      const safePath = normalizeWorkspacePath(path)
      if (!safePath) {
        continue
      }
      const converted = fileToContent(bytes, mimeForPath(safePath), safePath)
      files[safePath] = {
        path: safePath,
        encoding: converted.encoding,
        content: converted.content,
        size: converted.size,
        mime: mimeForPath(safePath),
        createdAt: now,
        updatedAt: now,
        baseline: converted.encoding === 'text' ? converted.content : undefined,
      }
    }
    useWorkspace.setState({ files, hydrated: true, persistError: null })
  } catch (error) {
    useWorkspace.setState({
      hydrated: true,
      persistError: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * 切换存储方式：把当前内存里的文件整体写到新后端，成功后写模式键。
 * 切到 OPFS 时如果浏览器不支持，返回错误而不改模式。
 */
export const setWorkspaceMode = async (mode: WorkspaceMode): Promise<WorkspaceMode> => {
  if (mode === 'opfs' && !opfsSupported()) {
    return useWorkspace.getState().mode
  }
  const files = useWorkspace.getState().files
  if (mode === 'opfs') {
    await opfsWriteAll(
      Object.fromEntries(
        Object.entries(files).map(([path, file]) => [path, workspaceFileBytes(file)])
      )
    )
  } else {
    writeFiles(files)
  }
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    // 隐私模式写不进去时至少本次会话生效
  }
  useWorkspace.setState({ mode, hydrated: true, persistError: null })
  return mode
}

/** 当前是否使用 OPFS；设置页用来显示状态 */
export const isOpfsMode = (): boolean => useWorkspace.getState().mode === 'opfs'

/** 保存普通文件到磁盘 */
export const downloadWorkspaceFile = (file: WorkspaceFile) => {
  const blob = new Blob([workspaceFileBytes(file)], { type: file.mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file.path.split('/').pop() ?? file.path
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 简单的按行 diff：仅文本文件有意义 */
export type DiffSummary = { added: number; removed: number; lines: string[] }

export const diffWorkspaceFile = (file: WorkspaceFile, maxLines = 200): DiffSummary => {
  if (file.encoding !== 'text') {
    return { added: 0, removed: 0, lines: [] }
  }
  const before = (file.baseline ?? '').split('\n')
  const after = file.content.split('\n')
  const lines: string[] = []
  let added = 0
  let removed = 0
  const max = Math.max(before.length, after.length)
  for (let index = 0; index < max; index += 1) {
    const oldLine = before[index]
    const newLine = after[index]
    if (oldLine === newLine) {
      continue
    }
    if (oldLine !== undefined) {
      removed += 1
      if (lines.length < maxLines) {
        lines.push(`- ${oldLine}`)
      }
    }
    if (newLine !== undefined) {
      added += 1
      if (lines.length < maxLines) {
        lines.push(`+ ${newLine}`)
      }
    }
  }
  return { added, removed, lines }
}
