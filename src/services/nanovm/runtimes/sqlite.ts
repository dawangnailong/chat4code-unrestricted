import { dirName, resolvePath } from '../fs.js'
import type { RuntimeIO, RuntimeModule, RuntimeProgress } from './types.js'

/**
 * SQLite 3 运行时（sql.js）。
 *
 * sql.js 的 ESM 入口从 jsDelivr 加载（`+esm` 转换），wasm 二进制单独下载：
 * 下载时按 ReadableStream 的分片上报进度，并尽量放进 Cache Storage
 * （`nanovm-sqlite-cache`），下次安装命中缓存就不再联网。初始化时把缓存的字节做成
 * blob URL 交给 `locateFile`，没有 Cache Storage 时直接回落到 CDN 地址。
 *
 * 命令语义按 sqlite3 CLI 的一个常用子集实现：直接读写虚拟文件系统里的 .db 文件，
 * 支持 `.tables` / `.schema` / `.mode` / `.headers` / `.read` / `.dump` 等点命令，
 * SQL 与点命令都按行流式处理。这里不追求完整的 sqlite3 shell：FTS、扩展、ATTACH
 * 等能力取决于 sql.js 的编译选项；复杂 tokenizer 场景也只做「够用」的切分。
 */

const SQL_MODULE_URL = 'https://cdn.jsdelivr.net/npm/sql.js@1.13.0/+esm'
const WASM_URL = 'https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/sql-wasm.wasm'
const CACHE_NAME = 'nanovm-sqlite-cache'
const CACHE_KEY = WASM_URL
const BASE_VERSION = 'SQLite 3'

/** sql.js 的查询结果：columns 与按行排列的值 */
type SqlQueryResult = {
  columns: string[]
  values: unknown[][]
}

/** sql.js 预处理语句的常用方法（.schema / .dump 需要参数绑定） */
type SqlStatement = {
  bind: (params: unknown[]) => boolean
  step: () => boolean
  getAsObject: () => Record<string, unknown>
  free: () => void
}

type SqlDatabase = {
  run: (sql: string) => void
  exec: (sql: string) => SqlQueryResult[]
  prepare: (sql: string) => SqlStatement
  export: () => Uint8Array
  close: () => void
}

type SqlJsStatic = {
  Database: new (data?: Uint8Array | null) => SqlDatabase
}

type InitSqlJs = (options?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>

/** 输出模式 */
type SqlMode = 'list' | 'column' | 'json'

/** 一次 sqlite3 命令的会话状态 */
type SqlSession = {
  io: RuntimeIO
  db: SqlDatabase
  /** 数据库文件在 VFS 里的绝对路径；内存数据库为 null */
  dbPath: string | null
  headers: boolean
  mode: SqlMode
  /** 是否有过成功执行的语句（决定要不要写回文件） */
  changed: boolean
}

/** 点命令的执行结果：stop 表示要结束整个脚本 */
type DotResult = {
  code: number
  stop: boolean
}

type ScriptResult = {
  code: number
  stop: boolean
}

const SQLITE_USAGE = [
  '用法：sqlite3 [数据库.db] [SQL]',
  '',
  'sql.js 版 SQLite 3，直接读写虚拟文件系统里的 .db 文件。',
  '没有 SQL 参数时把标准输入当作脚本；支持常用的点命令：',
  '  .help  .tables  .schema [表]  .headers on|off  .mode column|list|json',
  '  .width  .read 文件  .dump  .databases  .quit  .exit',
  '',
].join('\n')

const DOT_HELP = [
  '.help                显示这段帮助',
  '.tables              列出表与视图',
  '.schema [表]         查看建表语句',
  '.headers on|off      是否输出列名',
  '.mode column|list|json  输出格式',
  '.width ...           忽略（保留参数兼容）',
  '.read 文件           执行文件里的 SQL 脚本',
  '.dump                导出建表语句与数据',
  '.databases           显示当前数据库',
  '.quit / .exit        结束',
  '',
].join('\n')

/** 远程 ESM 只能靠原生 import 加载，`new Function` 里的 import 不会被 rspack 打包 */
const importRemote = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>

let loadedSqlJs: SqlJsStatic | null = null
let loadingSqlJs: Promise<SqlJsStatic> | null = null
let detectedVersion = BASE_VERSION

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

/** 带进度的下载；拿不到 content-length 时就只上报「还在下载」 */
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

/** 从 sql.js 的 ESM 模块里取出 initSqlJs（default 或 Module 导出） */
const resolveInitSqlJs = (module: unknown): InitSqlJs => {
  if (typeof module === 'function') {
    return module as InitSqlJs
  }
  if (typeof module === 'object' && module !== null) {
    const record = module as Record<string, unknown>
    const candidate = record.default ?? record.Module
    if (typeof candidate === 'function') {
      return candidate as InitSqlJs
    }
  }
  throw new Error('sql.js 模块缺少初始化函数')
}

const detectSqliteVersion = (sqlJs: SqlJsStatic): string => {
  try {
    const db = new sqlJs.Database()
    try {
      const result = db.exec('select sqlite_version()')
      const value = result[0]?.values[0]?.[0]
      if (typeof value === 'string' && value) {
        return `SQLite ${value}`
      }
    } finally {
      db.close()
    }
  } catch {
    // 拿不到具体版本就退回通用文案
  }
  return BASE_VERSION
}

/** 加载 sql.js；缓存实例、并发共用加载 Promise */
const loadSqlJs = async (onProgress: RuntimeProgress): Promise<SqlJsStatic> => {
  if (loadedSqlJs) {
    onProgress(1)
    return loadedSqlJs
  }
  if (loadingSqlJs) {
    const instance = await loadingSqlJs
    onProgress(1)
    return instance
  }
  const pending = (async (): Promise<SqlJsStatic> => {
    onProgress(0)
    let bytes: Uint8Array | null = null
    if (cacheStorage()) {
      bytes = await readCachedWasm()
      if (bytes) {
        onProgress(0.6)
      } else {
        bytes = await downloadWasm((fraction) => onProgress(0.05 + fraction * 0.55))
        if (bytes) {
          await writeCachedWasm(bytes)
        }
      }
    } else {
      // 没有 Cache Storage（比如 file:// 环境）时不做预下载，直接让 sql.js 走 CDN
      onProgress(0.55)
    }
    onProgress(0.65)
    const module = await importRemote(SQL_MODULE_URL)
    const initSqlJs = resolveInitSqlJs(module)
    onProgress(0.8)

    // 有下载到字节就用 blob URL，避免 sql.js 再下载一次；缓存不可用时回落到 CDN
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
      const instance = await initSqlJs({ locateFile: () => wasmLocation })
      detectedVersion = detectSqliteVersion(instance)
      loadedSqlJs = instance
      onProgress(1)
      return instance
    } finally {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  })()
  loadingSqlJs = pending
  try {
    return await pending
  } finally {
    loadingSqlJs = null
  }
}

const ensureSqlJs = async (onProgress: RuntimeProgress): Promise<SqlJsStatic> => {
  if (loadedSqlJs) {
    onProgress(1)
    return loadedSqlJs
  }
  return loadSqlJs(onProgress)
}

// ---------- 结果格式化 ----------

const bytesToHex = (bytes: Uint8Array): string => {
  const parts: string[] = []
  for (const byte of bytes) {
    parts.push(byte.toString(16).padStart(2, '0'))
  }
  return parts.join('')
}

/** 单元格文本：NULL 空串，BLOB 用 x'..' 表示（sqlite3 CLI 会输出原始字节，这里取可打印的形式） */
const valueText = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'string') {
    return value
  }
  if (value instanceof Uint8Array) {
    return `x'${bytesToHex(value)}'`
  }
  return String(value)
}

const jsonValue = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (value instanceof Uint8Array) {
    return `x'${bytesToHex(value)}'`
  }
  return String(value)
}

const padRight = (text: string, width: number): string => {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

const printList = (session: SqlSession, result: SqlQueryResult) => {
  if (session.headers && result.columns.length > 0) {
    session.io.stdout(`${result.columns.join('|')}\n`)
  }
  for (const row of result.values) {
    session.io.stdout(`${row.map((value) => valueText(value)).join('|')}\n`)
  }
}

const printColumn = (session: SqlSession, result: SqlQueryResult) => {
  const rows = result.values.map((row) => row.map((value) => valueText(value)))
  const widths = result.columns.map((name, index) => {
    let width = session.headers ? name.length : 0
    for (const row of rows) {
      width = Math.max(width, (row[index] ?? '').length)
    }
    return Math.max(1, width)
  })
  const formatRow = (cells: string[]): string => {
    return cells
      .map((cell, index) => padRight(cell, widths[index] ?? 1))
      .join('  ')
      .trimEnd()
  }
  if (session.headers && result.columns.length > 0) {
    session.io.stdout(`${formatRow(result.columns)}\n`)
    session.io.stdout(`${formatRow(widths.map((width) => '-'.repeat(width)))}\n`)
  }
  for (const row of rows) {
    session.io.stdout(`${formatRow(row)}\n`)
  }
}

const printJson = (session: SqlSession, result: SqlQueryResult) => {
  const rows = result.values.map((row) => {
    const record: Record<string, unknown> = {}
    result.columns.forEach((column, index) => {
      record[column] = jsonValue(row[index])
    })
    return record
  })
  session.io.stdout(`${JSON.stringify(rows)}\n`)
}

const printResult = (session: SqlSession, result: SqlQueryResult) => {
  if (session.mode === 'json') {
    printJson(session, result)
    return
  }
  if (session.mode === 'column') {
    printColumn(session, result)
    return
  }
  printList(session, result)
}

const errorText = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

/** 执行一条 SQL；成功时标记数据库有改动 */
const executeStatement = (session: SqlSession, sql: string): boolean => {
  try {
    const results = session.db.exec(sql)
    for (const result of results) {
      printResult(session, result)
    }
    session.changed = true
    return true
  } catch (error) {
    session.io.stderr(`Error: ${errorText(error)}\n`)
    return false
  }
}

const query = (session: SqlSession, sql: string): unknown[][] => {
  try {
    const results = session.db.exec(sql)
    return results[0]?.values ?? []
  } catch {
    return []
  }
}

// ---------- SQL / 点命令切分 ----------

/**
 * 按顶层分号切分 SQL，跳过字符串、引号标识符、行注释与块注释。
 * 返回已完成的语句和最后一段还没结束的内容。
 */
const splitSqlStatements = (text: string): { statements: string[]; rest: string } => {
  const statements: string[] = []
  let start = 0
  let index = 0
  let quote: '"' | "'" | '`' | ']' | null = null
  let lineComment = false
  let blockComment = false
  while (index < text.length) {
    const char = text[index]
    if (lineComment) {
      if (char === '\n') {
        lineComment = false
      }
      index += 1
      continue
    }
    if (blockComment) {
      if (char === '*' && text[index + 1] === '/') {
        blockComment = false
        index += 2
      } else {
        index += 1
      }
      continue
    }
    if (quote) {
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          index += 2
          continue
        }
        quote = null
      }
      index += 1
      continue
    }
    if (char === '-' && text[index + 1] === '-') {
      lineComment = true
      index += 2
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      blockComment = true
      index += 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      index += 1
      continue
    }
    if (char === '[') {
      quote = ']'
      index += 1
      continue
    }
    if (char === ';') {
      const statement = text.slice(start, index).trim()
      if (statement) {
        statements.push(statement)
      }
      start = index + 1
    }
    index += 1
  }
  return { statements, rest: text.slice(start) }
}

// ---------- 点命令 ----------

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

const sqlLiteral = (value: unknown): string => {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL'
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0'
  }
  if (value instanceof Uint8Array) {
    return `X'${bytesToHex(value)}'`
  }
  return `'${String(value).replace(/'/g, "''")}'`
}

const printTableNames = (session: SqlSession, names: string[]) => {
  if (names.length === 0) {
    return
  }
  const width = Math.max(...names.map((name) => name.length)) + 2
  const perLine = Math.max(1, Math.floor(80 / width))
  for (let index = 0; index < names.length; index += perLine) {
    const line = names
      .slice(index, index + perLine)
      .map((name) => padRight(name, width))
      .join('')
      .trimEnd()
    session.io.stdout(`${line}\n`)
  }
}

const schemaStatements = (session: SqlSession, table: string | null): string[] => {
  const base = [
    'select sql from sqlite_master',
    "where sql is not null and type in ('table', 'index', 'trigger', 'view')",
  ]
  if (table) {
    base.push('and (name = ? or tbl_name = ?)')
  }
  base.push(
    "order by case type when 'table' then 0 when 'index' then 1 when 'trigger' then 2 else 3 end, name"
  )
  const sql = base.join(' ')
  const out: string[] = []
  try {
    const statement = session.db.prepare(sql)
    try {
      if (table) {
        statement.bind([table, table])
      }
      while (statement.step()) {
        const row = statement.getAsObject()
        const text = row.sql
        if (typeof text === 'string' && text) {
          out.push(text)
        }
      }
    } finally {
      statement.free()
    }
  } catch (error) {
    session.io.stderr(`Error: ${errorText(error)}\n`)
  }
  return out
}

const dumpDatabase = (session: SqlSession) => {
  const objects = query(
    session,
    'select type, name, sql from sqlite_master ' +
      "where sql is not null and name not like 'sqlite_%' " +
      "order by case type when 'table' then 0 when 'index' then 1 when 'trigger' then 2 else 3 end, name"
  )
  const tables = objects.filter((row) => String(row[0]) === 'table')
  const others = objects.filter((row) => String(row[0]) !== 'table')
  session.io.stdout('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n')
  for (const row of tables) {
    session.io.stdout(`${String(row[2])};\n`)
  }
  for (const row of tables) {
    const name = String(row[1])
    const rows = query(session, `select * from ${quoteIdent(name)}`)
    for (const values of rows) {
      session.io.stdout(
        `INSERT INTO ${quoteIdent(name)} VALUES(${values.map((value) => sqlLiteral(value)).join(',')});\n`
      )
    }
  }
  for (const row of others) {
    session.io.stdout(`${String(row[2])};\n`)
  }
  session.io.stdout('COMMIT;\n')
}

const readQuotedArg = (text: string): string => {
  const trimmed = text.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' || first === "'") && last === first) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

const runDotCommand = (session: SqlSession, line: string, depth: number): DotResult => {
  const match = /^(\.[^\s]+)\s*([\s\S]*)$/.exec(line.trim())
  if (!match) {
    session.io.stderr(`Error: 无法解析的点命令 '${line}'\n`)
    return { code: 1, stop: false }
  }
  const name = match[1] ?? ''
  const rest = (match[2] ?? '').trim()
  switch (name) {
    case '.help':
      session.io.stdout(DOT_HELP)
      return { code: 0, stop: false }
    case '.tables': {
      const rows = query(
        session,
        "select name from sqlite_master where type in ('table', 'view') " +
          "and name not like 'sqlite_%' order by name"
      )
      printTableNames(
        session,
        rows.map((row) => String(row[0]))
      )
      return { code: 0, stop: false }
    }
    case '.schema': {
      const table = rest ? readQuotedArg(rest) : null
      for (const statement of schemaStatements(session, table)) {
        session.io.stdout(`${statement};\n`)
      }
      return { code: 0, stop: false }
    }
    case '.headers': {
      if (!rest) {
        session.io.stdout(`headers: ${session.headers ? 'on' : 'off'}\n`)
        return { code: 0, stop: false }
      }
      const value = rest.toLowerCase()
      if (value === 'on' || value === '1' || value === 'true') {
        session.headers = true
        return { code: 0, stop: false }
      }
      if (value === 'off' || value === '0' || value === 'false') {
        session.headers = false
        return { code: 0, stop: false }
      }
      session.io.stderr(`Error: .headers 只接受 on 或 off\n`)
      return { code: 1, stop: false }
    }
    case '.mode': {
      if (!rest) {
        session.io.stdout(`${session.mode}\n`)
        return { code: 0, stop: false }
      }
      const value = rest.toLowerCase()
      if (value === 'list' || value === 'column' || value === 'json') {
        session.mode = value
        return { code: 0, stop: false }
      }
      session.io.stderr(`Error: .mode 只支持 column / list / json\n`)
      return { code: 1, stop: false }
    }
    case '.width':
      // 列宽由内容自动决定，这里只吞掉参数保持兼容
      return { code: 0, stop: false }
    case '.quit':
    case '.exit':
      return { code: 0, stop: true }
    case '.read': {
      const path = readQuotedArg(rest)
      if (!path) {
        session.io.stderr('Error: .read 需要一个文件名\n')
        return { code: 1, stop: false }
      }
      if (depth >= 16) {
        session.io.stderr('Error: .read 嵌套层数过多\n')
        return { code: 1, stop: false }
      }
      let source: string | null = null
      try {
        source = session.io.fs.readText(resolvePath(session.io.cwd, path))
      } catch {
        source = null
      }
      if (source === null) {
        session.io.stderr(`Error: cannot open "${path}"\n`)
        return { code: 1, stop: false }
      }
      const result = executeScript(session, source, depth + 1)
      return { code: result.code, stop: result.stop }
    }
    case '.dump':
      dumpDatabase(session)
      return { code: 0, stop: false }
    case '.databases':
      session.io.stdout(`main: ${session.dbPath ?? ''} r/w\n`)
      return { code: 0, stop: false }
    default:
      session.io.stderr(
        `Error: unknown command or invalid arguments: "${name}". Enter ".help" for help\n`
      )
      return { code: 1, stop: false }
  }
}

/** 逐行执行脚本：只有语句边界上的 `.命令` 才按点命令处理 */
const executeScript = (session: SqlSession, script: string, depth: number): ScriptResult => {
  let pending = ''
  for (const line of script.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('.') && pending.trim() === '') {
      const result = runDotCommand(session, trimmed, depth)
      if (result.code !== 0 || result.stop) {
        return { code: result.code, stop: result.stop }
      }
      continue
    }
    pending += `${line}\n`
    const split = splitSqlStatements(pending)
    pending = split.rest
    for (const statement of split.statements) {
      if (!executeStatement(session, statement)) {
        return { code: 1, stop: true }
      }
    }
  }
  if (pending.trim()) {
    if (!executeStatement(session, pending)) {
      return { code: 1, stop: true }
    }
  }
  return { code: 0, stop: false }
}

// ---------- 命令入口 ----------

type SqliteInvocation = {
  mode: 'version' | 'help' | 'error' | 'run'
  database: string | null
  sql: string | null
  /** -header / -noheader 指定的表头开关 */
  headers: boolean
  message?: string
}

const parseSqliteArgs = (argv: string[]): SqliteInvocation => {
  let database: string | null = null
  const sqlParts: string[] = []
  let headers = false
  for (const arg of argv) {
    if (arg === '--version' || arg === '-version') {
      return { mode: 'version', database: null, sql: null, headers }
    }
    if (arg === '--help' || arg === '-help' || arg === '-h') {
      return { mode: 'help', database: null, sql: null, headers }
    }
    if (arg === '-header' || arg === '--header') {
      headers = true
      continue
    }
    if (arg === '-noheader' || arg === '--noheader') {
      headers = false
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      return {
        mode: 'error',
        database: null,
        sql: null,
        headers,
        message: `sqlite3: 无法识别的选项 '${arg}'\n${SQLITE_USAGE}`,
      }
    }
    if (database === null) {
      database = arg
      continue
    }
    sqlParts.push(arg)
  }
  return {
    mode: 'run',
    database,
    sql: sqlParts.length > 0 ? sqlParts.join(' ') : null,
    headers,
  }
}

const persistDatabase = (session: SqlSession): boolean => {
  if (!session.dbPath || !session.changed) {
    return true
  }
  try {
    const bytes = session.db.export()
    session.io.fs.mkdir(dirName(session.dbPath), true)
    session.io.fs.write(session.dbPath, bytes)
    return true
  } catch (error) {
    session.io.stderr(`Error: 写回数据库失败：${errorText(error)}\n`)
    return false
  }
}

const openDatabase = (
  sqlJs: SqlJsStatic,
  io: RuntimeIO,
  path: string | null
): { db: SqlDatabase | null; changed: boolean; error?: string } => {
  if (path === null) {
    return { db: new sqlJs.Database(), changed: false }
  }
  let bytes: Uint8Array | null = null
  try {
    bytes = io.fs.read(path)
  } catch (error) {
    return {
      db: null,
      changed: false,
      error: `sqlite3: 无法读取 '${path}'：${errorText(error)}\n`,
    }
  }
  try {
    // 文件不存在时 sql.js 会新建一个空数据库，并在结束时写回文件
    const db = new sqlJs.Database(bytes)
    // sql.js 对非 SQLite 文件可能延迟到第一次查询才报错，这里主动校验一次
    db.exec('PRAGMA schema_version')
    return { db, changed: bytes === null }
  } catch (error) {
    return {
      db: null,
      changed: false,
      error: `sqlite3: '${path}' 不是有效的 SQLite 数据库：${errorText(error)}\n`,
    }
  }
}

const runSqlite = async (argv: string[], io: RuntimeIO): Promise<{ code: number }> => {
  const invocation = parseSqliteArgs(argv)
  if (invocation.mode === 'help') {
    io.stdout(SQLITE_USAGE)
    return { code: 0 }
  }
  if (invocation.mode === 'error') {
    io.stderr(invocation.message ?? 'sqlite3: 参数错误\n')
    return { code: 1 }
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }

  let sqlJs: SqlJsStatic
  try {
    sqlJs = await ensureSqlJs(() => undefined)
  } catch (error) {
    const detail = errorText(error)
    io.stderr(
      `sqlite3: SQLite 运行时加载失败，需要联网（首次安装约 1.3MB）：${detail}\n` +
        '提示：连上网后执行 vm install sqlite，装好之后本页内可复用。\n'
    )
    return { code: 1 }
  }
  if (invocation.mode === 'version') {
    io.stdout(`${detectedVersion} (sql.js)\n`)
    return { code: 0 }
  }

  const databaseArg = invocation.database
  const dbPath =
    databaseArg !== null && databaseArg !== ':memory:' ? resolvePath(io.cwd, databaseArg) : null
  const opened = openDatabase(sqlJs, io, dbPath)
  if (opened.error || opened.db === null) {
    io.stderr(opened.error ?? 'sqlite3: 无法打开数据库\n')
    return { code: 1 }
  }

  const session: SqlSession = {
    io,
    db: opened.db,
    dbPath,
    headers: invocation.headers,
    mode: 'list',
    changed: opened.changed,
  }
  let code = 0
  try {
    const script = invocation.sql ?? (io.stdin.trim() ? io.stdin : null)
    if (script === null) {
      if (databaseArg === null) {
        io.stderr(SQLITE_USAGE)
        return { code: 1 }
      }
    } else {
      const result = executeScript(session, script, 0)
      code = result.code
    }
    if (!persistDatabase(session)) {
      code = 1
    }
  } finally {
    try {
      session.db.close()
    } catch {
      // 数据库已经关闭时忽略
    }
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }
  return { code }
}

/** SQLite 3（sql.js）：从 CDN 取 ESM 与 wasm 二进制 */
export const sqliteRuntime: RuntimeModule = {
  load: async (onProgress) => {
    await ensureSqlJs(onProgress)
    return { version: detectedVersion }
  },
  run: async (argv, io) => runSqlite(argv, io),
  dispose: () => {
    loadedSqlJs = null
    loadingSqlJs = null
    detectedVersion = BASE_VERSION
  },
}
