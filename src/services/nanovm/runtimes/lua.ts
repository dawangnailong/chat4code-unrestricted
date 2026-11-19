import { resolvePath } from '../fs.js'
import type { RuntimeIO, RuntimeModule, RuntimeProgress } from './types.js'

/**
 * Lua 5.4 运行时（wasmoon）。
 *
 * wasmoon 的主模块与 wasm 都从 jsDelivr 按需加载：`+esm` 入口用 `new Function`
 * 包一层动态 import，rspack 不会尝试解析这个 URL。注意 wasmoon 的浏览器分支默认
 * 会去 unpkg 下载 glue.wasm，这里显式把 wasm 地址指向同一个 CDN，避免多一个依赖。
 *
 * 为了让 Lua 像命令行工具一样工作，创建引擎后会重写一批标准库函数：
 * - print / io.write / io.stdout 走 io.stdout；
 * - io.stderr:write 走 io.stderr；
 * - io.read / io.lines 从 io.stdin 按行（或按格式）供给；
 * - require / dofile / loadfile 读虚拟文件系统里的 .lua 脚本；
 * - os.exit 记录退出码后抛哨兵，避免 wasmoon 的 os.exit 直接终止整个引擎。
 *
 * 每次执行都新建一个以 _G 为 __index 的环境表，脚本里赋值的全局变量只留在这次
 * 执行里，接近「每次都是一次新进程」的语义。
 */

/** Lua 版本展示文案 */
const LUA_VERSION = 'Lua 5.4'

/** wasmoon 的 ES 模块入口（jsDelivr 会把它转成 ESM） */
const LUA_MODULE_URL = 'https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/+esm'

/** wasmoon 的 wasm 本体：显式指定，避免它默认去 unpkg 下载 */
const LUA_WASM_URL = 'https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/dist/glue.wasm'

type LuaGlobal = {
  set: (name: string, value: unknown) => void
  get: (name: string) => unknown
  close: () => void
}

type LuaEngineLike = {
  global: LuaGlobal
  doString: (script: string) => Promise<unknown>
}

type LuaFactoryLike = {
  createEngine: () => Promise<LuaEngineLike>
}

type LuaFactoryConstructor = new (customWasmUri?: string) => LuaFactoryLike

/** 一次执行里可以访问的上下文，JS 注入的函数都从这里取数据 */
type LuaRunContext = {
  io: RuntimeIO
  /** 标准输入的读取游标（io.read 用） */
  stdin: string
  stdinPos: number
  /** 本次要执行的源码块 */
  chunks: LuaChunk[]
  /** arg[0]，没有脚本时为 null */
  arg0: string | null
  /** 脚本参数（arg[1..]） */
  args: string[]
}

/** 一段待执行的 Lua 源码 */
type LuaChunk = {
  source: string
  /** Lua 的 chunkname：@file 表示文件，=stdin 表示标准输入 */
  name: string
  /** 作为可变参数传给主 chunk 的脚本参数（只有脚本文件有） */
  args: string[]
}

/** 解析命令行之后得到的结果 */
type LuaInvocation = {
  mode: 'version' | 'help' | 'error' | 'run'
  /** -e 传入的代码块，可以有多段 */
  code: string[]
  /** 脚本路径（命令行原样），null 表示没有脚本 */
  script: string | null
  /** 脚本之后的参数 */
  args: string[]
  /** mode 为 error 时的提示 */
  message?: string
}

const LUA_USAGE = [
  '用法：lua [-v] [-h] [-e "代码"] [脚本.lua] [参数...]',
  '',
  'wasmoon 版 Lua 5.4（WebAssembly），标准库来自 Lua 5.4 本体。',
  'print / io.write / io.stderr 会写到命令的标准输出与标准错误，',
  'io.read 从标准输入读取；require / dofile / loadfile 可以加载虚拟文件系统里的 .lua。',
  '没有脚本且标准输入为空时不支持交互式 REPL。',
  '',
].join('\n')

/** 远程 ESM 只能靠原生 import 加载，`new Function` 里的 import 不会被 rspack 打包 */
const importRemote = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>

let loadedEngine: LuaEngineLike | null = null
let loadingEngine: Promise<LuaEngineLike> | null = null
let detectedVersion = LUA_VERSION

/** Lua 只有一个引擎，run 串行执行，避免并发命令互相覆盖 activeContext */
let runChain: Promise<unknown> = Promise.resolve()

const withRunLock = <T>(task: () => Promise<T>): Promise<T> => {
  const result = runChain.then(task, task)
  runChain = result.catch(() => undefined)
  return result
}

/** 当前正在执行的上下文；JS 注入的函数全部通过它转接 */
let activeContext: LuaRunContext | null = null

/** os.exit 记录的退出码；null 表示没有请求退出 */
let pendingExit: number | null = null

/** 注入到 Lua 全局的辅助函数：读写、参数、退出 */
const installHelpers = (engine: LuaEngineLike) => {
  engine.global.set('__nanovm_write', (text: unknown) => {
    activeContext?.io.stdout(String(text))
  })
  engine.global.set('__nanovm_write_err', (text: unknown) => {
    activeContext?.io.stderr(String(text))
  })
  engine.global.set('__nanovm_read_file', (path: unknown): string | undefined => {
    if (!activeContext) {
      return undefined
    }
    const target = resolvePath(activeContext.io.cwd, String(path))
    try {
      const source = activeContext.io.fs.readText(target)
      return source === null ? undefined : source
    } catch {
      // 目录或读不出来的文件按「找不到」处理，交给 Lua 的 require 报错
      return undefined
    }
  })
  engine.global.set('__nanovm_io_read', (format: unknown): string | number | undefined => {
    if (!activeContext) {
      return undefined
    }
    return readFromStdin(activeContext, format)
  })
  engine.global.set('__nanovm_arg', (index: unknown): string | undefined => {
    if (!activeContext) {
      return undefined
    }
    const position = Number(index)
    if (position === 0) {
      return activeContext.arg0 === null ? undefined : activeContext.arg0
    }
    if (!Number.isInteger(position) || position < 1) {
      return undefined
    }
    return activeContext.args[position - 1]
  })
  engine.global.set('__nanovm_argc', (): number => activeContext?.args.length ?? 0)
  engine.global.set('__nanovm_chunk_count', (): number => activeContext?.chunks.length ?? 0)
  engine.global.set('__nanovm_chunk_source', (index: unknown): string => {
    const chunk = chunkAt(index)
    return chunk ? chunk.source : ''
  })
  engine.global.set('__nanovm_chunk_name', (index: unknown): string => {
    const chunk = chunkAt(index)
    return chunk ? chunk.name : '=(chunk)'
  })
  engine.global.set('__nanovm_chunk_arg_count', (index: unknown): number => {
    const chunk = chunkAt(index)
    return chunk ? chunk.args.length : 0
  })
  engine.global.set('__nanovm_chunk_arg', (index: unknown, position: unknown): string => {
    const chunk = chunkAt(index)
    if (!chunk) {
      return ''
    }
    return chunk.args[Number(position) - 1] ?? ''
  })
  engine.global.set('__nanovm_exit', (code: unknown) => {
    // 记录退出码后抛哨兵；wasmoon 会把 JS 错误转成 Lua 错误，从而中止当前 chunk
    pendingExit = normalizeExitCode(code)
    throw new Error('__NANOVM_EXIT__')
  })
  engine.global.set('__nanovm_exit_code', (): number | undefined => {
    return pendingExit === null ? undefined : pendingExit
  })
}

const chunkAt = (index: unknown): LuaChunk | undefined => {
  const position = Number(index)
  if (!Number.isInteger(position) || position < 1) {
    return undefined
  }
  return activeContext?.chunks[position - 1]
}

/** os.exit 的参数归一化：数字直接用，布尔按成功/失败，其余当 0 */
const normalizeExitCode = (code: unknown): number => {
  if (typeof code === 'number' && Number.isFinite(code)) {
    return Math.trunc(code)
  }
  if (typeof code === 'boolean') {
    return code ? 0 : 1
  }
  return 0
}

/** io.read 的读取实现：支持 *l / *L / *a / *n 与「读 n 个字节」 */
const readFromStdin = (context: LuaRunContext, format: unknown): string | number | undefined => {
  if (typeof format === 'number') {
    if (!Number.isFinite(format) || format <= 0) {
      return undefined
    }
    if (context.stdinPos >= context.stdin.length) {
      return undefined
    }
    const chunk = context.stdin.slice(context.stdinPos, context.stdinPos + Math.trunc(format))
    context.stdinPos += chunk.length
    return chunk
  }
  const mode = typeof format === 'string' ? format : ''
  if (mode === 'a' || mode === '*a') {
    const rest = context.stdin.slice(context.stdinPos)
    context.stdinPos = context.stdin.length
    return rest
  }
  if (mode === 'L' || mode === '*L') {
    if (context.stdinPos >= context.stdin.length) {
      return undefined
    }
    const newline = context.stdin.indexOf('\n', context.stdinPos)
    if (newline === -1) {
      const rest = context.stdin.slice(context.stdinPos)
      context.stdinPos = context.stdin.length
      return rest
    }
    const line = context.stdin.slice(context.stdinPos, newline + 1)
    context.stdinPos = newline + 1
    return line
  }
  if (mode === 'n' || mode === '*n') {
    const match = /^[\t\n\v\f\r ]*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(
      context.stdin.slice(context.stdinPos)
    )
    if (!match) {
      return undefined
    }
    context.stdinPos += match[0].length
    const value = Number(match[0])
    return Number.isNaN(value) ? undefined : value
  }
  if (mode !== '' && mode !== 'l' && mode !== '*l') {
    throw new Error(`不支持的 io.read 格式 '${mode}'`)
  }
  // 默认格式（l / *l）按行读取
  if (context.stdinPos >= context.stdin.length) {
    return undefined
  }
  const newline = context.stdin.indexOf('\n', context.stdinPos)
  if (newline === -1) {
    const rest = context.stdin.slice(context.stdinPos)
    context.stdinPos = context.stdin.length
    return rest
  }
  const line = context.stdin.slice(context.stdinPos, newline)
  context.stdinPos = newline + 1
  return line
}

/**
 * 创建引擎后安装一次的环境补丁。
 *
 * 这里的函数都只捕获 `__nanovm_*` 全局，真正的数据由每次 run 更新，所以补丁只装一次。
 */
const SETUP_SCRIPT = String.raw`
local raw_write = __nanovm_write
local raw_write_err = __nanovm_write_err

print = function(...)
  local parts = {}
  for index = 1, select('#', ...) do
    parts[index] = tostring((select(index, ...)))
  end
  raw_write(table.concat(parts, '\t') .. '\n')
end

local function make_writer(sink)
  local writer = {}
  function writer:write(...)
    local parts = {}
    for index = 1, select('#', ...) do
      local value = select(index, ...)
      local kind = type(value)
      if kind == 'string' then
        parts[index] = value
      elseif kind == 'number' then
        parts[index] = tostring(value)
      else
        error("bad argument #" .. index .. " to 'write' (string expected, got " .. kind .. ')', 2)
      end
    end
    sink(table.concat(parts))
    return self
  end
  writer.write = writer.write
  return writer
end

local stdout_writer = make_writer(raw_write)
local stderr_writer = make_writer(raw_write_err)
io.stdout = stdout_writer
io.stderr = stderr_writer
io.write = function(...)
  stdout_writer:write(...)
  return stdout_writer
end

io.read = function(...)
  local count = select('#', ...)
  if count == 0 then
    return __nanovm_io_read('l')
  end
  local results = {}
  for index = 1, count do
    local value = __nanovm_io_read((select(index, ...)))
    results[index] = value
    if value == nil then
      return table.unpack(results, 1, index - 1)
    end
  end
  return table.unpack(results, 1, count)
end

local read_file = __nanovm_read_file

local function find_module(name)
  local base = name:gsub('%.', '/')
  local candidates = {
    name .. '.lua',
    name .. '/init.lua',
    base .. '.lua',
    base .. '/init.lua',
  }
  for index = 1, #candidates do
    local source = read_file(candidates[index])
    if source ~= nil then
      return candidates[index], source
    end
  end
  return nil
end

require = function(name)
  if package.loaded[name] ~= nil then
    return package.loaded[name]
  end
  local path, source = find_module(name)
  if path == nil then
    error("module '" .. name .. "' not found", 2)
  end
  local chunk, load_error = load(source, '@' .. path)
  if chunk == nil then
    error(load_error, 2)
  end
  local result = chunk(name)
  if result == nil then
    result = true
  end
  package.loaded[name] = result
  return result
end

loadfile = function(path)
  local source = read_file(path)
  if source == nil then
    return nil, 'cannot open ' .. path .. ': No such file or directory'
  end
  return load(source, '@' .. path)
end

dofile = function(path)
  local chunk, load_error = loadfile(path)
  if chunk == nil then
    error(load_error, 2)
  end
  return chunk()
end

io.lines = function(path)
  if path ~= nil then
    local source = read_file(path)
    if source == nil then
      error('cannot open ' .. path .. ': No such file or directory', 2)
    end
    local position = 1
    return function()
      if position > #source then
        return nil
      end
      local newline = string.find(source, '\n', position, true)
      if newline == nil then
        local line = string.sub(source, position)
        position = #source + 1
        return line
      end
      local line = string.sub(source, position, newline - 1)
      position = newline + 1
      return line
    end
  end
  return function()
    return __nanovm_io_read('l')
  end
end

os.exit = function(code, close)
  if type(code) == 'boolean' then
    code = code and 0 or 1
  elseif type(code) ~= 'number' then
    code = 0
  end
  __nanovm_exit(code)
end
`

/**
 * 每次执行都经过这段 runner：
 * - 新建一个以 _G 为 __index 的环境，脚本里的全局赋值不会泄漏到下一次执行；
 * - 按顺序执行 -e 代码块与脚本；
 * - xpcall 捕获错误，带上报错时的 traceback；
 * - os.exit 的哨兵不打印，直接把记录的退出码返回给 JS。
 */
const RUNNER_SCRIPT = String.raw`
local env = setmetatable({}, { __index = _G })
env._G = env
env.arg = {}
local arg0 = __nanovm_arg(0)
if arg0 ~= nil then
  env.arg[0] = arg0
end
local argc = __nanovm_argc()
for index = 1, argc do
  env.arg[index] = __nanovm_arg(index)
end

local function message_of(value)
  if type(value) == 'string' then
    return value
  end
  if type(value) == 'table' then
    return '(error object is a table value)'
  end
  local ok, text = pcall(tostring, value)
  if ok and type(text) == 'string' and text ~= '' then
    return text
  end
  return '(error object is a ' .. type(value) .. ' value)'
end

local count = __nanovm_chunk_count()
for index = 1, count do
  local name = __nanovm_chunk_name(index)
  local source = __nanovm_chunk_source(index)
  local chunk, load_error = load(source, name, 't', env)
  if chunk == nil then
    __nanovm_write_err('lua: ' .. load_error .. '\n')
    return 1
  end

  local passed = {}
  local passed_count = __nanovm_chunk_arg_count(index)
  for position = 1, passed_count do
    passed[position] = __nanovm_chunk_arg(index, position)
  end

  local ok, result = xpcall(function()
    return chunk(table.unpack(passed, 1, passed_count))
  end, function(value)
    local trace = debug.traceback('', 2):gsub('^\n', '')
    local head = trace:match("^(.*)\n\t%[C%]: in function 'xpcall'")
    if head ~= nil then
      trace = head
    end
    return { message = message_of(value), trace = trace }
  end)

  local exit_code = __nanovm_exit_code()
  if exit_code ~= nil then
    return exit_code
  end
  if not ok then
    __nanovm_write_err('lua: ' .. result.message .. '\n' .. result.trace .. '\n')
    return 1
  end
end
return 0
`

/** 从 wasmoon 模块里取出 LuaFactory，并做一次形状检查 */
const resolveFactory = (module: unknown): LuaFactoryConstructor => {
  if (typeof module !== 'object' || module === null) {
    throw new Error('wasmoon 模块格式异常（不是对象）')
  }
  const factory = (module as Record<string, unknown>).LuaFactory
  if (typeof factory !== 'function') {
    throw new Error('wasmoon 模块缺少 LuaFactory 导出')
  }
  return factory as LuaFactoryConstructor
}

const readVersion = (engine: LuaEngineLike): string => {
  try {
    const value = engine.global.get('_VERSION')
    if (typeof value === 'string' && value.startsWith('Lua ')) {
      return value
    }
  } catch {
    // 拿不到就退回常量
  }
  return LUA_VERSION
}

/** 创建引擎并装好环境补丁 */
const createEngine = async (onProgress: RuntimeProgress): Promise<LuaEngineLike> => {
  onProgress(0.1)
  const module = await importRemote(LUA_MODULE_URL)
  onProgress(0.5)
  const Factory = resolveFactory(module)
  const factory = new Factory(LUA_WASM_URL)
  const engine = await factory.createEngine()
  installHelpers(engine)
  await engine.doString(SETUP_SCRIPT)
  detectedVersion = readVersion(engine)
  onProgress(1)
  return engine
}

/** 取引擎；并发调用共用同一个加载 Promise */
const ensureEngine = async (onProgress: RuntimeProgress): Promise<LuaEngineLike> => {
  if (loadedEngine) {
    onProgress(1)
    return loadedEngine
  }
  if (loadingEngine) {
    const engine = await loadingEngine
    onProgress(1)
    return engine
  }
  const pending = createEngine(onProgress)
  loadingEngine = pending
  try {
    const engine = await pending
    loadedEngine = engine
    return engine
  } finally {
    loadingEngine = null
  }
}

/** 解析命令行；argv 不含命令名 */
const parseInvocation = (argv: string[]): LuaInvocation => {
  const code: string[] = []
  let script: string | null = null
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === '--') {
      const next = argv[index + 1]
      if (next !== undefined) {
        script = next
        index += 2
      } else {
        index += 1
      }
      break
    }
    if (arg === '-v' || arg === '--version') {
      return { mode: 'version', code, script: null, args: [] }
    }
    if (arg === '-h' || arg === '--help') {
      return { mode: 'help', code, script: null, args: [] }
    }
    if (arg === '-e') {
      const source = argv[index + 1]
      if (source === undefined) {
        return {
          mode: 'error',
          code,
          script: null,
          args: [],
          message: "lua: '-e' 缺少要执行的代码\n",
        }
      }
      code.push(source)
      index += 2
      continue
    }
    if (arg === '-i') {
      return {
        mode: 'error',
        code,
        script: null,
        args: [],
        message: 'lua: 交互式 REPL 不支持，请用 lua script.lua 或 lua -e "代码"\n',
      }
    }
    if (arg === '-') {
      script = '-'
      index += 1
      break
    }
    if (arg.startsWith('-')) {
      return {
        mode: 'error',
        code,
        script: null,
        args: [],
        message: `lua: 无法识别的选项 '${arg}'\n${LUA_USAGE}`,
      }
    }
    script = arg
    index += 1
    break
  }
  return { mode: 'run', code, script, args: argv.slice(index) }
}

/** 构造要执行的源码块；读不到脚本时返回错误文案 */
const buildChunks = (
  invocation: LuaInvocation,
  io: RuntimeIO
): { chunks: LuaChunk[]; arg0: string | null; error?: string } => {
  const chunks: LuaChunk[] = invocation.code.map((source) => ({
    source,
    name: '=(command line)',
    args: [],
  }))
  if (invocation.script === null) {
    return { chunks, arg0: null }
  }
  if (invocation.script === '-') {
    // 显式 `lua -` 表示从标准输入读脚本；空的 stdin 就是空脚本
    chunks.push({ source: io.stdin, name: '=stdin', args: invocation.args })
    return { chunks, arg0: '-' }
  }
  const path = resolvePath(io.cwd, invocation.script)
  let source: string | null = null
  try {
    source = io.fs.readText(path)
  } catch {
    source = null
  }
  if (source === null) {
    return {
      chunks,
      arg0: invocation.script,
      error: `lua: cannot open ${invocation.script}: No such file or directory\n`,
    }
  }
  chunks.push({ source, name: `@${invocation.script}`, args: invocation.args })
  return { chunks, arg0: invocation.script }
}

/** 执行一条 lua 命令 */
const runLua = async (argv: string[], io: RuntimeIO): Promise<{ code: number }> => {
  const invocation = parseInvocation(argv)
  if (invocation.mode === 'version') {
    io.stdout(`${LUA_VERSION} (wasmoon)\n`)
    return { code: 0 }
  }
  if (invocation.mode === 'help') {
    io.stdout(LUA_USAGE)
    return { code: 0 }
  }
  if (invocation.mode === 'error') {
    io.stderr(invocation.message ?? 'lua: 参数错误\n')
    return { code: 1 }
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }

  const built = buildChunks(invocation, io)
  if (built.error) {
    io.stderr(built.error)
    return { code: 1 }
  }
  let chunks = built.chunks
  if (chunks.length === 0) {
    if (!io.stdin.trim()) {
      io.stderr('lua: 交互式 REPL 不支持，请用 lua script.lua 或 lua -e "代码"\n')
      return { code: 1 }
    }
    chunks = [{ source: io.stdin, name: '=stdin', args: [] }]
  }

  let engine: LuaEngineLike
  try {
    engine = await ensureEngine(() => undefined)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    io.stderr(
      `lua: Lua 运行时加载失败，需要联网（首次安装约 0.4MB）：${detail}\n` +
        '提示：连上网后执行 vm install lua，装好之后本页内可复用。\n'
    )
    return { code: 1 }
  }

  activeContext = {
    io,
    stdin: io.stdin,
    stdinPos: 0,
    chunks,
    arg0: built.arg0,
    args: invocation.args,
  }
  pendingExit = null
  let code = 0
  try {
    const value = await engine.doString(RUNNER_SCRIPT)
    code = typeof value === 'number' ? Math.trunc(value) : 0
  } catch (error) {
    if (pendingExit !== null) {
      code = pendingExit
    } else {
      const message = error instanceof Error ? error.message : String(error)
      io.stderr(`lua: ${message}\n`)
      code = 1
    }
  } finally {
    activeContext = null
  }
  if (pendingExit !== null) {
    code = pendingExit
    pendingExit = null
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }
  return { code }
}

/** Lua 5.4（wasmoon）：从 CDN 取 ESM，wasm 显式指向同一个 CDN */
export const luaRuntime: RuntimeModule = {
  load: async (onProgress) => {
    await ensureEngine(onProgress)
    return { version: detectedVersion }
  },
  run: async (argv, io) => withRunLock(() => runLua(argv, io)),
  dispose: () => {
    const engine = loadedEngine
    loadedEngine = null
    loadingEngine = null
    activeContext = null
    pendingExit = null
    detectedVersion = LUA_VERSION
    try {
      engine?.global.close()
    } catch {
      // 引擎已经关闭时忽略
    }
  },
}
