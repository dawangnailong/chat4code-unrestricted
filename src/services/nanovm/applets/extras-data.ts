import { unzipSync, zipSync } from 'fflate'
import type { Applet, AppletContext, AppletResult } from '../types.js'
import { dirName, normalizePath, resolvePath } from '../fs.js'
import {
  fail,
  interrupted,
  joinLines,
  ok,
  parseArgs,
  readInputBytes,
  splitLines,
  type FlagSpec,
  type ParsedArgs,
} from './helpers.js'

/**
 * 数据 / 路径层面的补充命令。
 *
 * basename / dirname / realpath / readlink 是纯路径工具；mktemp / nproc / timeout
 * 提供脚本里常用的运行时能力；split / shuf / join / comm 做文本切分与合并；
 * zip / unzip 用 fflate 实现，压缩结果只在 Uint8Array 上流转，二进制不进 stdout。
 *
 * 路径类命令按 POSIX 的「文本」规则处理参数（而不是先 normalize），
 * 所以 `dirname a` 给出 `.`、`dirname /` 仍是 `/`、`basename a/b/` 得到 `b`。
 * 所有长循环都检查 interrupted，被 Ctrl+C / 超时打断时统一返回 130。
 */

const decoder = new TextDecoder()

/** 超时 / Ctrl+C 的统一返回码 */
const ABORTED: AppletResult = { code: 130 }

/**
 * `-h` / `--help`：所有命令都认，打印 usage 后退出 0。
 * 只扫描开头的选项区，这样 `timeout 5 ls --help` 会把 --help 传给子命令而不是被截走。
 */
const hasHelp = (argv: string[]): boolean => {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--' || arg === '-' || !arg.startsWith('-')) {
      return false
    }
    if (arg === '-h' || arg === '--help') {
      return true
    }
  }
  return false
}

// ---------- 参数与错误 ----------

const flagOn = (flags: ParsedArgs['flags'], ...names: string[]): boolean =>
  names.some((name) => flags[name] === true)

const flagText = (flags: ParsedArgs['flags'], ...names: string[]): string | null => {
  for (const name of names) {
    const value = flags[name]
    if (typeof value === 'string') {
      return value
    }
  }
  return null
}

/** 把异常翻译成人读的原因（文件系统错误已经是英文 errno 文案） */
const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 用法错误：退出码 2 */
const usageError = (command: string, message: string): AppletResult =>
  fail(`${command}: ${message}\n`, 2)

/** 严格解析整数，失败返回 null */
const parseInteger = (text: string): number | null => {
  const trimmed = text.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return null
  }
  const value = Number.parseInt(trimmed, 10)
  return Number.isFinite(value) ? value : null
}

// ---------- 路径文本工具 ----------

/** 去掉结尾多余的斜杠，根目录 / 保留一个 */
const stripTrailingSlash = (path: string): string => {
  let end = path.length
  while (end > 1 && path[end - 1] === '/') {
    end -= 1
  }
  return path.slice(0, end)
}

/** 文本意义上的 basename：不做 `.` / `..` 折叠，保留相对形式 */
const textBaseName = (path: string): string => {
  const trimmed = stripTrailingSlash(path)
  if (trimmed === '') {
    return ''
  }
  if (trimmed === '/') {
    return '/'
  }
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/** 文本意义上的 dirname：`a` -> `.`、`/a/b` -> `/a`、`/` -> `/` */
const textDirName = (path: string): string => {
  const trimmed = stripTrailingSlash(path)
  const index = trimmed.lastIndexOf('/')
  if (index < 0) {
    return '.'
  }
  if (index === 0) {
    return '/'
  }
  return stripTrailingSlash(trimmed.slice(0, index))
}

/** 路径最后一段，用于 mktemp 的模板文件名 */
const lastSegment = (path: string): string => {
  const trimmed = stripTrailingSlash(path)
  const index = trimmed.lastIndexOf('/')
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

/** 把目录文本与文件名拼成展示用路径（保留调用者写的相对形式） */
const joinDisplay = (dirText: string, name: string): string => {
  if (dirText === '') {
    return name
  }
  return dirText.endsWith('/') ? `${dirText}${name}` : `${dirText}/${name}`
}

/**
 * 路径存在性检查的强度：
 * - `all`：每一段都必须存在（realpath -e / readlink -f、-e）
 * - `middle`：除最后一段外都必须存在（GNU realpath 的默认行为）
 * - `missing`：不检查（-m）
 */
type Existence = 'all' | 'middle' | 'missing'

/** 规范化路径，并按需检查各段是否存在 */
const canonicalize = (
  ctx: AppletContext,
  raw: string,
  mode: Existence
): { path: string; missing: string | null } => {
  const path = resolvePath(ctx.cwd, raw)
  if (mode === 'missing' || path === '/') {
    return { path, missing: null }
  }
  const segments = path.split('/').filter((segment) => segment.length > 0)
  let current = ''
  for (let index = 0; index < segments.length; index += 1) {
    current += `/${segments[index]}`
    if (mode === 'middle' && index === segments.length - 1) {
      continue
    }
    if (!ctx.fs.exists(current)) {
      return { path, missing: current }
    }
  }
  return { path, missing: null }
}

// ---------- basename / dirname ----------

const basenameSpec: FlagSpec = {
  a: 'boolean',
  s: 'value',
  multiple: 'boolean',
  suffix: 'value',
}

const basenameUsage = 'basename [-a] [-s SUFFIX] NAME...｜basename NAME [SUFFIX]'

/** 后缀匹配就删掉；后缀与整个名字相同时保留（GNU 的约定） */
const removeSuffix = (name: string, suffix: string): string => {
  if (suffix === '' || name === suffix || !name.endsWith(suffix)) {
    return name
  }
  return name.slice(0, name.length - suffix.length)
}

const basenameApplet: Applet = {
  name: 'basename',
  summary: '取路径的最后一段，可去掉指定后缀',
  summaryEn: 'Strip the directory part of a path, optionally removing a suffix',
  usage: basenameUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (hasHelp(ctx.argv)) {
      return ok(`${basenameUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, basenameSpec)
    if (parsed.error) {
      return fail(`basename: ${parsed.error}\n`, 2)
    }
    const suffixFlag = flagText(parsed.flags, 's', 'suffix')
    const multiple = flagOn(parsed.flags, 'a', 'multiple') || suffixFlag !== null
    if (parsed.operands.length === 0) {
      return usageError('basename', 'missing operand')
    }
    let names: string[]
    let suffix = suffixFlag ?? ''
    if (multiple) {
      names = parsed.operands
    } else {
      if (parsed.operands.length > 2) {
        return usageError('basename', `extra operand '${parsed.operands[2]}'`)
      }
      names = [parsed.operands[0]]
      suffix = parsed.operands[1] ?? ''
    }
    const lines: string[] = []
    for (const name of names) {
      if (interrupted(ctx)) {
        return ABORTED
      }
      lines.push(removeSuffix(textBaseName(name), suffix))
    }
    return ok(joinLines(lines))
  },
}

const dirnameUsage = 'dirname NAME...'

const dirnameApplet: Applet = {
  name: 'dirname',
  summary: '取路径的目录部分（a -> .，/ -> /）',
  summaryEn: 'Strip the last component of a path',
  usage: dirnameUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (hasHelp(ctx.argv)) {
      return ok(`${dirnameUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, {})
    if (parsed.error) {
      return fail(`dirname: ${parsed.error}\n`, 2)
    }
    if (parsed.operands.length === 0) {
      return usageError('dirname', 'missing operand')
    }
    const lines: string[] = []
    for (const operand of parsed.operands) {
      if (interrupted(ctx)) {
        return ABORTED
      }
      lines.push(textDirName(operand))
    }
    return ok(joinLines(lines))
  },
}

// ---------- realpath / readlink ----------

const realpathSpec: FlagSpec = {
  m: 'boolean',
  e: 'boolean',
  'canonicalize-missing': 'boolean',
  'canonicalize-existing': 'boolean',
}

const realpathUsage = 'realpath [-m|-e] PATH...'

const realpathApplet: Applet = {
  name: 'realpath',
  summary: '把路径规范化成绝对路径，-e 要求每一段都存在，-m 允许不存在',
  summaryEn: 'Print canonicalized absolute paths; -e requires existence, -m allows missing',
  usage: realpathUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (hasHelp(ctx.argv)) {
      return ok(`${realpathUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, realpathSpec)
    if (parsed.error) {
      return fail(`realpath: ${parsed.error}\n`, 2)
    }
    const allowMissing = flagOn(parsed.flags, 'm', 'canonicalize-missing')
    const requireExisting = flagOn(parsed.flags, 'e', 'canonicalize-existing')
    const mode: Existence = allowMissing ? 'missing' : requireExisting ? 'all' : 'middle'
    if (parsed.operands.length === 0) {
      return usageError('realpath', 'missing operand')
    }
    const lines: string[] = []
    const errors: string[] = []
    for (const operand of parsed.operands) {
      if (interrupted(ctx)) {
        return ABORTED
      }
      const result = canonicalize(ctx, operand, mode)
      if (result.missing !== null) {
        errors.push(`realpath: ${operand}: No such file or directory\n`)
        continue
      }
      lines.push(`${result.path}\n`)
    }
    return errors.length > 0
      ? { code: 1, stdout: lines.join(''), stderr: errors.join('') }
      : ok(lines.join(''))
  },
}

const readlinkSpec: FlagSpec = {
  f: 'boolean',
  e: 'boolean',
  m: 'boolean',
  canonicalize: 'boolean',
  'canonicalize-existing': 'boolean',
  'canonicalize-missing': 'boolean',
}

const readlinkUsage = 'readlink [-f|-e|-m] PATH...'

const readlinkApplet: Applet = {
  name: 'readlink',
  summary: '打印符号链接目标；NanoVM 没有符号链接，-f/-e/-m 改为输出规范化绝对路径',
  summaryEn: 'Print symlink targets; NanoVM has none, so -f/-e/-m print canonical paths',
  usage: readlinkUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (hasHelp(ctx.argv)) {
      return ok(`${readlinkUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, readlinkSpec)
    if (parsed.error) {
      return fail(`readlink: ${parsed.error}\n`, 2)
    }
    const canonical = flagOn(
      parsed.flags,
      'f',
      'e',
      'm',
      'canonicalize',
      'canonicalize-existing',
      'canonicalize-missing'
    )
    const allowMissing = flagOn(parsed.flags, 'm', 'canonicalize-missing')
    if (parsed.operands.length === 0) {
      return usageError('readlink', 'missing operand')
    }
    const lines: string[] = []
    const errors: string[] = []
    for (const operand of parsed.operands) {
      if (interrupted(ctx)) {
        return ABORTED
      }
      if (canonical) {
        // VFS 里没有链接：-f / -e 都要求全部存在，-m 允许缺失
        const result = canonicalize(ctx, operand, allowMissing ? 'missing' : 'all')
        if (result.missing !== null) {
          errors.push(`readlink: ${operand}: No such file or directory\n`)
          continue
        }
        lines.push(`${result.path}\n`)
        continue
      }
      const path = resolvePath(ctx.cwd, operand)
      if (!ctx.fs.exists(path)) {
        errors.push(`readlink: ${operand}: No such file or directory\n`)
        continue
      }
      // NanoVM Slim 没有符号链接：和 Linux 对普通文件的行为对齐
      errors.push(`readlink: ${operand}: Invalid argument\n`)
    }
    return errors.length > 0
      ? { code: 1, stdout: lines.join(''), stderr: errors.join('') }
      : ok(lines.join(''))
  },
}

// ---------- mktemp ----------

/** 随机串：优先用 WebCrypto，纯 Node / 老环境回落到 Math.random */
const randomChars = (length: number): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(length)
  const webcrypto = globalThis.crypto
  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    webcrypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  let text = ''
  for (const byte of bytes) {
    text += alphabet[byte % alphabet.length]
  }
  return text
}

/** 模板末尾连续 X 的个数（busybox 要求至少 3 个） */
const trailingXCount = (name: string): number => {
  const match = /X+$/.exec(name)
  return match ? match[0].length : 0
}

const mktempSpec: FlagSpec = {
  d: 'boolean',
  q: 'boolean',
  p: 'value',
  t: 'boolean',
  directory: 'boolean',
  quiet: 'boolean',
  tmpdir: 'value',
}

const mktempUsage = 'mktemp [-d] [-q] [-p DIR] [-t] [TEMPLATE]'

const mktempApplet: Applet = {
  name: 'mktemp',
  summary: '按模板创建唯一的临时文件或目录（默认 /tmp/tmp.XXXXXXXXXX）',
  summaryEn: 'Create a unique temporary file or directory from a template',
  usage: mktempUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (hasHelp(ctx.argv)) {
      return ok(`${mktempUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, mktempSpec)
    if (parsed.error) {
      return fail(`mktemp: ${parsed.error}\n`, 2)
    }
    if (parsed.operands.length > 1) {
      return usageError('mktemp', `extra operand '${parsed.operands[1]}'`)
    }
    const quiet = flagOn(parsed.flags, 'q', 'quiet')
    const makeDirectory = flagOn(parsed.flags, 'd', 'directory')
    const template = parsed.operands[0] ?? '/tmp/tmp.XXXXXXXXXX'
    const parentFlag = flagText(parsed.flags, 'p', 'tmpdir')
    const useTmp = flagOn(parsed.flags, 't')
    let parentText: string | null = null
    let nameText = lastSegment(template)
    let textualPrefix = ''
    if (parentFlag !== null) {
      parentText = parentFlag
    } else if (useTmp) {
      parentText = ctx.env.TMPDIR ?? '/tmp'
    } else {
      const index = template.lastIndexOf('/')
      textualPrefix = index >= 0 ? template.slice(0, index + 1) : ''
    }
    const parentPath =
      parentText === null
        ? dirName(resolvePath(ctx.cwd, template))
        : resolvePath(ctx.cwd, parentText)
    const parentLabel =
      parentText ??
      (stripTrailingSlash(textualPrefix) === '' ? '.' : stripTrailingSlash(textualPrefix))
    if (!ctx.fs.exists(parentPath) || !ctx.fs.isDirectory(parentPath)) {
      if (quiet) {
        return { code: 1 }
      }
      return fail(`mktemp: ${parentLabel}: No such file or directory\n`)
    }
    const xCount = trailingXCount(nameText)
    if (xCount < 3) {
      if (quiet) {
        return { code: 1 }
      }
      return fail(`mktemp: too few X's in template '${template}'\n`)
    }
    for (let attempt = 0; attempt < 128; attempt += 1) {
      if (interrupted(ctx)) {
        return ABORTED
      }
      const candidate = nameText.replace(/X+$/, randomChars(xCount))
      const target = normalizePath(`${parentPath}/${candidate}`)
      if (ctx.fs.exists(target)) {
        continue
      }
      const display =
        parentText === null ? `${textualPrefix}${candidate}` : joinDisplay(parentText, candidate)
      try {
        if (makeDirectory) {
          ctx.fs.mkdir(target)
        } else {
          ctx.fs.write(target, new Uint8Array(0))
        }
      } catch {
        // 名字被人抢先占了就换一个；其他错误重试几次后统一报失败
        continue
      }
      return ok(`${display}\n`)
    }
    if (quiet) {
      return { code: 1 }
    }
    return fail(
      `mktemp: failed to create ${makeDirectory ? 'directory' : 'file'} via template '${template}'\n`
    )
  },
}

// ---------- nproc ----------

const nprocSpec: FlagSpec = {
  all: 'boolean',
  ignore: 'value',
}

const nprocUsage = 'nproc [--all] [--ignore=N]'

const nprocApplet: Applet = {
  name: 'nproc',
  summary: '打印可用的并发数（navigator.hardwareConcurrency）',
  summaryEn: 'Print the number of processing units available',
  usage: nprocUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (hasHelp(ctx.argv)) {
      return ok(`${nprocUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, nprocSpec)
    if (parsed.error) {
      return fail(`nproc: ${parsed.error}\n`, 2)
    }
    if (parsed.operands.length > 0) {
      return usageError('nproc', `extra operand '${parsed.operands[0]}'`)
    }
    const reported =
      typeof navigator === 'undefined' ||
      typeof navigator.hardwareConcurrency !== 'number' ||
      !Number.isFinite(navigator.hardwareConcurrency)
        ? 1
        : navigator.hardwareConcurrency
    const total = Math.max(1, Math.trunc(reported))
    if (flagOn(parsed.flags, 'all')) {
      return ok(`${total}\n`)
    }
    const ignoreText = flagText(parsed.flags, 'ignore')
    if (ignoreText === null) {
      return ok(`${total}\n`)
    }
    const ignore = parseInteger(ignoreText)
    if (ignore === null || ignore < 0) {
      return usageError('nproc', `invalid number: '${ignoreText}'`)
    }
    return ok(`${Math.max(1, total - ignore)}\n`)
  },
}

// ---------- timeout ----------

/** 解析 `5` / `5s` / `500ms` / `1m` / `2h` / `1d`，返回毫秒 */
const parseDuration = (text: string): number | null => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i.exec(text.trim())
  if (!match) {
    return null
  }
  const value = Number.parseFloat(match[1])
  const unit = (match[2] ?? 's').toLowerCase()
  const factor =
    unit === 'ms'
      ? 1
      : unit === 'm'
        ? 60_000
        : unit === 'h'
          ? 3_600_000
          : unit === 'd'
            ? 86_400_000
            : 1000
  return Math.round(value * factor)
}

const timeoutSpec: FlagSpec = {
  s: 'value',
  k: 'value',
  signal: 'value',
  'kill-after': 'value',
}

const timeoutUsage = 'timeout [-s SIG] [-k DURATION] DURATION COMMAND [ARG...]'

const timeoutApplet: Applet = {
  name: 'timeout',
  summary: '限时运行子命令；超时返回 124（不能真正杀掉子命令）',
  summaryEn: 'Run a command with a time limit; exits 124 on timeout',
  usage: timeoutUsage,
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    if (hasHelp(ctx.argv)) {
      return ok(`${timeoutUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, timeoutSpec)
    if (parsed.error) {
      return fail(`timeout: ${parsed.error}\n`, 2)
    }
    if (parsed.operands.length < 2) {
      return usageError('timeout', 'missing operand')
    }
    const durationText = parsed.operands[0]
    const limit = parseDuration(durationText)
    if (limit === null) {
      return usageError('timeout', `invalid time interval '${durationText}'`)
    }
    const signalFlag =
      flagText(parsed.flags, 's', 'signal') ?? flagText(parsed.flags, 'k', 'kill-after')
    const notes =
      signalFlag === null ? '' : 'timeout: 不支持发送信号（-s / -k），超时后只返回退出码\n'
    const line = parsed.operands.slice(1).join(' ')
    // shell.run 没有超时参数，只能和定时器赛跑：超时后子命令仍然会在后台跑完
    const running = ctx.shell.run(line, { cwd: ctx.cwd, env: ctx.env, stdin: ctx.stdin }).then(
      (result) => ({ kind: 'done' as const, result }),
      (error: unknown) => ({ kind: 'failed' as const, error })
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<{ kind: 'timeout' }>((resolve) => {
      if (limit > 0) {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), limit)
      }
    })
    try {
      const outcome = await Promise.race([running, expired])
      if (outcome.kind === 'timeout') {
        return {
          code: 124,
          stderr: `${notes}timeout: 已超过 ${durationText}，子命令可能仍在运行\n`,
        }
      }
      if (outcome.kind === 'failed') {
        return { code: 125, stderr: `${notes}timeout: ${reasonOf(outcome.error)}\n` }
      }
      const result: AppletResult = {
        code: outcome.result.code,
        stderr: `${notes}${outcome.result.stderr}`,
      }
      if (outcome.result.stdout) {
        result.stdout = outcome.result.stdout
      }
      if (outcome.result.install) {
        result.install = outcome.result.install
      }
      return result
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  },
}

// ---------- split ----------

/** 解析 `-b` 的字节数：1k / 1m / 1g（1024 进制），也接受纯数字 */
const parseByteCount = (text: string): number | null => {
  const match = /^(\d+)([kKmMgG]?)[bB]?$/.exec(text.trim())
  if (!match) {
    return null
  }
  const value = Number.parseInt(match[1], 10)
  const unit = (match[2] ?? '').toLowerCase()
  const factor = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : unit === 'g' ? 1024 ** 3 : 1
  return value * factor
}

/** 分片后缀：字母（aa、ab、…、ba）或数字（00、01、…） */
const splitSuffix = (index: number, length: number, numeric: boolean): string => {
  if (numeric) {
    return String(index).padStart(length, '0')
  }
  let value = index
  let text = ''
  for (let slot = 0; slot < length; slot += 1) {
    text = String.fromCharCode(97 + (value % 26)) + text
    value = Math.floor(value / 26)
  }
  return text
}

/** 按行切分时直接在字节上找 \n，避免非 UTF-8 内容被解码破坏 */
const splitByLines = (bytes: Uint8Array, perChunk: number): Uint8Array[] => {
  const chunks: Uint8Array[] = []
  let start = 0
  let lines = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) {
      continue
    }
    lines += 1
    if (lines === perChunk) {
      chunks.push(bytes.slice(start, index + 1))
      start = index + 1
      lines = 0
    }
  }
  if (start < bytes.length) {
    chunks.push(bytes.slice(start))
  }
  return chunks
}

const splitByBytes = (bytes: Uint8Array, perChunk: number): Uint8Array[] => {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += perChunk) {
    chunks.push(bytes.slice(offset, Math.min(offset + perChunk, bytes.length)))
  }
  return chunks
}

const splitSpec: FlagSpec = {
  l: 'value',
  b: 'value',
  d: 'boolean',
  a: 'value',
  'additional-suffix': 'value',
  lines: 'value',
  bytes: 'value',
  'numeric-suffixes': 'boolean',
  'suffix-length': 'value',
}

const splitUsage = 'split [-l LINES] [-b BYTES] [-d] [-a N] [--additional-suffix=S] FILE [PREFIX]'

const splitApplet: Applet = {
  name: 'split',
  summary: '把文件按行数或字节数切成多个分片，默认前缀 x、每片 1000 行',
  summaryEn: 'Split a file into pieces by lines or bytes',
  usage: splitUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (hasHelp(ctx.argv)) {
      return ok(`${splitUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, splitSpec)
    if (parsed.error) {
      return fail(`split: ${parsed.error}\n`, 2)
    }
    const linesFlag = flagText(parsed.flags, 'l', 'lines')
    const bytesFlag = flagText(parsed.flags, 'b', 'bytes')
    if (linesFlag !== null && bytesFlag !== null) {
      return usageError('split', 'cannot split in more than one way')
    }
    const lineCount = linesFlag === null ? 1000 : parseInteger(linesFlag)
    if (lineCount === null || lineCount <= 0) {
      return usageError('split', `invalid number of lines: '${linesFlag ?? ''}'`)
    }
    const byteCount = bytesFlag === null ? null : parseByteCount(bytesFlag)
    if (bytesFlag !== null && (byteCount === null || byteCount <= 0)) {
      return usageError('split', `invalid number of bytes: '${bytesFlag}'`)
    }
    const numeric = flagOn(parsed.flags, 'd', 'numeric-suffixes')
    const suffixText = flagText(parsed.flags, 'a', 'suffix-length')
    const suffixLength = suffixText === null ? 2 : parseInteger(suffixText)
    if (suffixLength === null || suffixLength <= 0 || suffixLength > 64) {
      return usageError('split', `invalid suffix length: '${suffixText ?? ''}'`)
    }
    const additional = flagText(parsed.flags, 'additional-suffix') ?? ''
    if (parsed.operands.length === 0) {
      return usageError('split', 'missing operand')
    }
    const source = parsed.operands[0]
    const prefix = parsed.operands[1] ?? 'x'
    let bytes: Uint8Array
    try {
      bytes = readInputBytes(ctx, source)
    } catch (error) {
      return fail(`split: ${source}: ${reasonOf(error)}\n`)
    }
    const chunks =
      byteCount === null ? splitByLines(bytes, lineCount) : splitByBytes(bytes, byteCount)
    const created: string[] = []
    for (let index = 0; index < chunks.length; index += 1) {
      if (interrupted(ctx)) {
        return ABORTED
      }
      const display = `${prefix}${splitSuffix(index, suffixLength, numeric)}${additional}`
      try {
        ctx.fs.write(resolvePath(ctx.cwd, display), chunks[index])
      } catch (error) {
        return fail(`split: ${display}: ${reasonOf(error)}\n`)
      }
      created.push(`${display}\n`)
    }
    return ok(created.join(''))
  },
}

// ---------- shuf ----------

/** Fisher-Yates 洗牌 */
const shuffleInPlace = (items: string[]): void => {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(Math.random() * (index + 1))
    const current = items[index]
    items[index] = items[pick]
    items[pick] = current
  }
}

const shufSpec: FlagSpec = {
  n: 'value',
  e: 'boolean',
  i: 'value',
  r: 'boolean',
  'head-count': 'value',
  echo: 'boolean',
  'input-range': 'value',
  repeat: 'boolean',
}

const shufUsage = 'shuf [-n COUNT] [-e ARG...] [-i LO-HI] [-r] [FILE]'

const shufApplet: Applet = {
  name: 'shuf',
  summary: '随机打乱输入行，-e 洗参数、-i 洗整数区间、-r 允许重复',
  summaryEn: 'Shuffle input lines or a range, with optional repetition',
  usage: shufUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (hasHelp(ctx.argv)) {
      return ok(`${shufUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, shufSpec)
    if (parsed.error) {
      return fail(`shuf: ${parsed.error}\n`, 2)
    }
    const echo = flagOn(parsed.flags, 'e', 'echo')
    const repeat = flagOn(parsed.flags, 'r', 'repeat')
    const rangeText = flagText(parsed.flags, 'i', 'input-range')
    const countText = flagText(parsed.flags, 'n', 'head-count')
    if (echo && rangeText !== null) {
      return usageError('shuf', 'cannot combine -e and -i')
    }
    const items: string[] = []
    if (echo) {
      items.push(...parsed.operands)
    } else if (rangeText !== null) {
      const match = /^(\d+)-(\d+)$/.exec(rangeText.trim())
      if (!match) {
        return usageError('shuf', `invalid input range '${rangeText}'`)
      }
      const low = Number.parseInt(match[1], 10)
      const high = Number.parseInt(match[2], 10)
      if (low > high) {
        return usageError('shuf', `invalid input range '${rangeText}'`)
      }
      if (high - low > 10_000_000) {
        return usageError('shuf', `input range '${rangeText}' is too large`)
      }
      for (let value = low; value <= high; value += 1) {
        items.push(String(value))
      }
    } else {
      if (parsed.operands.length > 1) {
        return usageError('shuf', `extra operand '${parsed.operands[1]}'`)
      }
      if (parsed.operands.length === 1) {
        try {
          items.push(...splitLines(decoder.decode(readInputBytes(ctx, parsed.operands[0]))))
        } catch (error) {
          return fail(`shuf: ${parsed.operands[0]}: ${reasonOf(error)}\n`)
        }
      } else {
        // 没有文件操作数时读 stdin：`seq 5 | shuf -n 2` 是常见用法
        items.push(...splitLines(ctx.stdin))
      }
    }
    const requested = countText === null ? null : parseInteger(countText)
    if (countText !== null && (requested === null || requested < 0)) {
      return usageError('shuf', `invalid line count: '${countText}'`)
    }
    if (repeat) {
      if (requested === null) {
        return usageError('shuf', '--repeat needs -n')
      }
      if (items.length === 0 || requested === 0) {
        return ok('')
      }
      const picks: string[] = []
      for (let index = 0; index < requested; index += 1) {
        if (interrupted(ctx)) {
          return ABORTED
        }
        picks.push(items[Math.floor(Math.random() * items.length)])
      }
      return ok(joinLines(picks))
    }
    shuffleInPlace(items)
    const wanted = requested === null ? items.length : Math.min(requested, items.length)
    return ok(joinLines(items.slice(0, wanted)))
  },
}

// ---------- join ----------

/** `-o` 里的一个字段：side 0 表示连接字段，1 / 2 表示来自对应文件的第 index 个字段 */
type JoinOutputField = { side: 0 | 1 | 2; index: number }

/** 解析 `-o 0,1.2,2.3`；非法返回 null */
const parseJoinFormat = (text: string): JoinOutputField[] | null => {
  const fields: JoinOutputField[] = []
  for (const token of text.split(',')) {
    const trimmed = token.trim()
    if (trimmed === '') {
      return null
    }
    if (trimmed === '0') {
      fields.push({ side: 0, index: 1 })
      continue
    }
    const qualified = /^([12])\.(\d+)$/.exec(trimmed)
    if (qualified) {
      const index = Number.parseInt(qualified[2], 10)
      if (index <= 0) {
        return null
      }
      fields.push({ side: Number(qualified[1]) as 1 | 2, index })
      continue
    }
    const bare = /^([12])$/.exec(trimmed)
    if (!bare) {
      return null
    }
    fields.push({ side: Number(bare[1]) as 1 | 2, index: 1 })
  }
  return fields.length > 0 ? fields : null
}

const joinSpec: FlagSpec = {
  '1': 'value',
  '2': 'value',
  t: 'value',
  a: 'value',
  o: 'value',
  e: 'value',
  delimiter: 'value',
  empty: 'value',
  'output-delimiter': 'value',
}

const joinUsage = 'join [-1 N] [-2 N] [-t SEP] [-a 1|2] [-o FORMAT] [-e EMPTY] FILE1 FILE2'

/** 字段拆分：默认按连续空白，-t 时按给定分隔符原样拆 */
const splitFields = (line: string, separator: string | null): string[] => {
  if (separator === null) {
    const trimmed = line.trim()
    return trimmed === '' ? [] : trimmed.split(/\s+/)
  }
  return line.split(separator)
}

const fieldAt = (fields: string[], index: number): string => fields[index - 1] ?? ''

const joinApplet: Applet = {
  name: 'join',
  summary: '按连接字段合并两个已排序文件，支持 -a / -o / -t',
  summaryEn: 'Join lines of two sorted files on a common field',
  usage: joinUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (hasHelp(ctx.argv)) {
      return ok(`${joinUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, joinSpec)
    if (parsed.error) {
      return fail(`join: ${parsed.error}\n`, 2)
    }
    const parseField = (text: string | null, fallback: number): number | null => {
      if (text === null) {
        return fallback
      }
      const value = parseInteger(text)
      return value !== null && value > 0 ? value : null
    }
    const join1 = parseField(flagText(parsed.flags, '1'), 1)
    const join2 = parseField(flagText(parsed.flags, '2'), 1)
    if (join1 === null || join2 === null) {
      return usageError('join', 'invalid field number')
    }
    const separator = flagText(parsed.flags, 't', 'delimiter')
    const emptyText = flagText(parsed.flags, 'e', 'empty') ?? ''
    const missing = new Set<'1' | '2'>()
    const missingText = flagText(parsed.flags, 'a')
    if (missingText !== null) {
      for (const token of missingText.split(',')) {
        const trimmed = token.trim()
        if (trimmed === '1' || trimmed === '2') {
          missing.add(trimmed)
        } else {
          return usageError('join', `invalid file number in field spec: '${trimmed}'`)
        }
      }
    }
    const formatText = flagText(parsed.flags, 'o')
    const format = formatText === null ? null : parseJoinFormat(formatText)
    if (formatText !== null && format === null) {
      return usageError('join', `invalid field specifier: '${formatText}'`)
    }
    if (parsed.operands.length !== 2) {
      return usageError('join', 'missing operand')
    }
    const readLines = (word: string): string[] | AppletResult => {
      try {
        return splitLines(decoder.decode(readInputBytes(ctx, word)))
      } catch (error) {
        return fail(`join: ${word}: ${reasonOf(error)}\n`)
      }
    }
    const leftLines = readLines(parsed.operands[0])
    if (!Array.isArray(leftLines)) {
      return leftLines
    }
    const rightLines = readLines(parsed.operands[1])
    if (!Array.isArray(rightLines)) {
      return rightLines
    }
    const leftFields = leftLines.map((line) => splitFields(line, separator))
    const rightFields = rightLines.map((line) => splitFields(line, separator))
    const outSeparator = separator ?? ' '
    const out: string[] = []
    const emitDefault = (left: string[], right: string[], key: string): string => {
      const parts: string[] = [key]
      left.forEach((value, index) => {
        if (index !== join1 - 1) {
          parts.push(value)
        }
      })
      right.forEach((value, index) => {
        if (index !== join2 - 1) {
          parts.push(value)
        }
      })
      return parts.join(outSeparator)
    }
    const emitFormat = (left: string[] | null, right: string[] | null, key: string): string => {
      const parts: string[] = []
      for (const field of format ?? []) {
        let value = ''
        if (field.side === 0) {
          value = key
        } else if (field.side === 1) {
          value = left ? fieldAt(left, field.index) : ''
        } else {
          value = right ? fieldAt(right, field.index) : ''
        }
        parts.push(value === '' ? emptyText : value)
      }
      return parts.join(outSeparator)
    }
    const emit = (left: string[] | null, right: string[] | null, key: string): string =>
      format === null
        ? left && right
          ? emitDefault(left, right, key)
          : [...(left ?? []), ...(right ?? [])].join(outSeparator)
        : emitFormat(left, right, key)
    let leftIndex = 0
    let rightIndex = 0
    while (leftIndex < leftLines.length || rightIndex < rightLines.length) {
      if (interrupted(ctx)) {
        return ABORTED
      }
      if (leftIndex >= leftLines.length) {
        if (missing.has('2')) {
          out.push(emit(null, rightFields[rightIndex], fieldAt(rightFields[rightIndex], join2)))
          if (out.length > 200_000) {
            return usageError('join', '输出行数过多')
          }
        }
        rightIndex += 1
        continue
      }
      if (rightIndex >= rightLines.length) {
        if (missing.has('1')) {
          out.push(emit(leftFields[leftIndex], null, fieldAt(leftFields[leftIndex], join1)))
          if (out.length > 200_000) {
            return usageError('join', '输出行数过多')
          }
        }
        leftIndex += 1
        continue
      }
      const leftKey = fieldAt(leftFields[leftIndex], join1)
      const rightKey = fieldAt(rightFields[rightIndex], join2)
      if (leftKey < rightKey) {
        if (missing.has('1')) {
          out.push(emit(leftFields[leftIndex], null, leftKey))
        }
        leftIndex += 1
        continue
      }
      if (leftKey > rightKey) {
        if (missing.has('2')) {
          out.push(emit(null, rightFields[rightIndex], rightKey))
        }
        rightIndex += 1
        continue
      }
      // 同一个连接字段可能有多行：按笛卡尔积输出，和 GNU join 一致
      const leftGroup: string[][] = []
      const rightGroup: string[][] = []
      while (leftIndex < leftLines.length && fieldAt(leftFields[leftIndex], join1) === leftKey) {
        leftGroup.push(leftFields[leftIndex])
        leftIndex += 1
      }
      while (
        rightIndex < rightLines.length &&
        fieldAt(rightFields[rightIndex], join2) === rightKey
      ) {
        rightGroup.push(rightFields[rightIndex])
        rightIndex += 1
      }
      for (const left of leftGroup) {
        for (const right of rightGroup) {
          if (interrupted(ctx)) {
            return ABORTED
          }
          out.push(emit(left, right, leftKey))
          if (out.length > 200_000) {
            return usageError('join', '输出行数过多')
          }
        }
      }
    }
    return ok(joinLines(out))
  },
}

// ---------- comm ----------

const commSpec: FlagSpec = {
  '1': 'boolean',
  '2': 'boolean',
  '3': 'boolean',
  'output-delimiter': 'value',
}

const commUsage = 'comm [-1] [-2] [-3] [--output-delimiter=SEP] FILE1 FILE2'

const commApplet: Applet = {
  name: 'comm',
  summary: '比较两个已排序文件，分三列输出只在 1 / 只在 2 / 共有的行',
  summaryEn: 'Compare two sorted files column by column',
  usage: commUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (hasHelp(ctx.argv)) {
      return ok(`${commUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, commSpec)
    if (parsed.error) {
      return fail(`comm: ${parsed.error}\n`, 2)
    }
    if (parsed.operands.length !== 2) {
      return usageError('comm', 'missing operand')
    }
    const readLines = (word: string): string[] | AppletResult => {
      try {
        return splitLines(decoder.decode(readInputBytes(ctx, word)))
      } catch (error) {
        return fail(`comm: ${word}: ${reasonOf(error)}\n`)
      }
    }
    const leftLines = readLines(parsed.operands[0])
    if (!Array.isArray(leftLines)) {
      return leftLines
    }
    const rightLines = readLines(parsed.operands[1])
    if (!Array.isArray(rightLines)) {
      return rightLines
    }
    const enabled = [
      !flagOn(parsed.flags, '1'),
      !flagOn(parsed.flags, '2'),
      !flagOn(parsed.flags, '3'),
    ]
    const delimiter = flagText(parsed.flags, 'output-delimiter') ?? '\t'
    // 被抑制的前置列不再占位，和 GNU comm -12 的朴素输出一致
    const prefix = (column: number): string => {
      let tabs = 0
      for (let index = 0; index < column; index += 1) {
        if (enabled[index]) {
          tabs += 1
        }
      }
      return delimiter.repeat(tabs)
    }
    const out: string[] = []
    let leftIndex = 0
    let rightIndex = 0
    while (leftIndex < leftLines.length || rightIndex < rightLines.length) {
      if (interrupted(ctx)) {
        return ABORTED
      }
      if (leftIndex >= leftLines.length) {
        if (enabled[1]) {
          out.push(`${prefix(1)}${rightLines[rightIndex]}\n`)
        }
        rightIndex += 1
        continue
      }
      if (rightIndex >= rightLines.length) {
        if (enabled[0]) {
          out.push(`${prefix(0)}${leftLines[leftIndex]}\n`)
        }
        leftIndex += 1
        continue
      }
      const left = leftLines[leftIndex]
      const right = rightLines[rightIndex]
      if (left < right) {
        if (enabled[0]) {
          out.push(`${prefix(0)}${left}\n`)
        }
        leftIndex += 1
        continue
      }
      if (left > right) {
        if (enabled[1]) {
          out.push(`${prefix(1)}${right}\n`)
        }
        rightIndex += 1
        continue
      }
      if (enabled[2]) {
        out.push(`${prefix(2)}${left}\n`)
      }
      leftIndex += 1
      rightIndex += 1
    }
    return ok(out.join(''))
  },
}

// ---------- zip ----------

/**
 * 归档里使用的相对名字：cwd 内的路径去掉前缀，cwd 外的绝对路径去掉开头的 /，
 * 和 zip 的「relative path」习惯一致，也避免把宿主机路径写进归档。
 */
const archiveName = (cwd: string, absolute: string): string => {
  if (absolute === cwd) {
    return ''
  }
  const prefix = cwd === '/' ? '/' : `${cwd}/`
  if (absolute.startsWith(prefix)) {
    return absolute.slice(prefix.length)
  }
  return absolute.replace(/^\/+/, '')
}

const zipSpec: FlagSpec = {
  r: 'boolean',
  q: 'boolean',
  '0': 'boolean',
  '9': 'boolean',
  j: 'boolean',
  d: 'value',
  recursive: 'boolean',
  quiet: 'boolean',
  junkpaths: 'boolean',
}

const zipUsage = 'zip [-r] [-q] [-0|-9] [-j] ARCHIVE.zip FILE...'

const zipApplet: Applet = {
  name: 'zip',
  summary: '用 deflate 打包文件或目录（-r 递归、-j 去路径、-0 仅存储）',
  summaryEn: 'Create a zip archive; -r recurses, -j junks paths, -0 stores',
  usage: zipUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (hasHelp(ctx.argv)) {
      return ok(`${zipUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, zipSpec)
    if (parsed.error) {
      return fail(`zip: ${parsed.error}\n`, 2)
    }
    if (flagText(parsed.flags, 'd') !== null) {
      return fail('zip: -d 只用于解压，请改用 unzip -d <dir>\n', 2)
    }
    if (parsed.operands.length < 2) {
      return usageError('zip', 'missing operand')
    }
    const archiveWord = parsed.operands[0]
    const archivePath = resolvePath(ctx.cwd, archiveWord)
    const recursive = flagOn(parsed.flags, 'r', 'recursive')
    const quiet = flagOn(parsed.flags, 'q', 'quiet')
    const junkPaths = flagOn(parsed.flags, 'j', 'junkpaths')
    const level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = flagOn(parsed.flags, '0')
      ? 0
      : flagOn(parsed.flags, '9')
        ? 9
        : 6
    const entries: Record<string, Uint8Array> = {}
    const added: string[] = []
    const messages: string[] = []
    let code = 0
    const words = ctx.shell.expand(parsed.operands.slice(1), {
      cwd: ctx.cwd,
      env: ctx.env,
    })
    for (const word of words) {
      if (interrupted(ctx)) {
        return ABORTED
      }
      const absolute = resolvePath(ctx.cwd, word)
      const entry = ctx.fs.stat(absolute)
      if (!entry) {
        messages.push(`zip: ${word}: No such file or directory\n`)
        code = 1
        continue
      }
      const base = archiveName(ctx.cwd, absolute)
      if (entry.kind === 'dir') {
        if (!recursive) {
          messages.push(`zip: ${word}: is a directory (use -r)\n`)
          code = 1
          continue
        }
        if (!junkPaths && base !== '') {
          entries[`${base}/`] = new Uint8Array(0)
          if (!quiet) {
            added.push(`${base}/\n`)
          }
        }
        for (const child of ctx.fs.walk(absolute)) {
          if (interrupted(ctx)) {
            return ABORTED
          }
          const relative = child.path.slice(absolute === '/' ? 1 : absolute.length + 1)
          const name = junkPaths ? child.name : base === '' ? relative : `${base}/${relative}`
          if (child.kind === 'dir') {
            if (!junkPaths && relative !== '') {
              entries[`${name}/`] = new Uint8Array(0)
              if (!quiet) {
                added.push(`${name}/\n`)
              }
            }
            continue
          }
          const bytes = ctx.fs.read(child.path)
          if (!bytes) {
            messages.push(`zip: ${child.path}: No such file or directory\n`)
            code = 1
            continue
          }
          entries[name] = bytes
          if (!quiet) {
            added.push(`${name}\n`)
          }
        }
        continue
      }
      const name = junkPaths ? (base.split('/').pop() ?? base) : base
      const bytes = ctx.fs.read(absolute)
      if (!bytes) {
        messages.push(`zip: ${word}: No such file or directory\n`)
        code = 1
        continue
      }
      entries[name] = bytes
      if (!quiet) {
        added.push(`${name}\n`)
      }
    }
    try {
      ctx.fs.write(archivePath, zipSync(entries, { level }))
    } catch (error) {
      return {
        code: 1,
        stderr: `${messages.join('')}zip: ${archiveWord}: ${reasonOf(error)}\n`,
      }
    }
    return { code, stdout: added.join(''), stderr: messages.join('') }
  },
}

// ---------- unzip ----------

/** 解压时的路径安全：拒绝绝对路径与 `..`，返回归档内的相对路径 */
const safeRelativeName = (name: string): string | null => {
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) {
    return null
  }
  const parts = name.split(/[\\/]/)
  const safe: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      return null
    }
    safe.push(part)
  }
  return safe.join('/')
}

/** 简单的通配符匹配：支持 * 与 ?（unzip 的 pattern 参数） */
const wildcardMatch = (pattern: string, target: string): boolean => {
  let source = ''
  for (const char of pattern) {
    if (char === '*') {
      source += '.*'
      continue
    }
    if (char === '?') {
      source += '.'
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`).test(target)
}

const matchesPattern = (name: string, patterns: string[]): boolean => {
  if (patterns.length === 0) {
    return true
  }
  const target = name.replace(/^\.\/+/, '').replace(/\/+$/, '')
  return patterns.some((pattern) => {
    const cleaned = pattern.replace(/^\.\/+/, '').replace(/\/+$/, '')
    if (wildcardMatch(cleaned, target)) {
      return true
    }
    return target.startsWith(`${cleaned}/`)
  })
}

const unzipSpec: FlagSpec = {
  o: 'boolean',
  l: 'boolean',
  q: 'boolean',
  d: 'value',
  overwrite: 'boolean',
  list: 'boolean',
  quiet: 'boolean',
  directory: 'value',
}

const unzipUsage = 'unzip [-o] [-l] [-q] [-d DIR] ARCHIVE.zip [PATTERN...]'

const unzipApplet: Applet = {
  name: 'unzip',
  summary: '解压 zip（-l 查看内容、-d 指定目录、-o 覆盖，带 zip-slip 防护）',
  summaryEn: 'Extract a zip archive; -l lists, -d sets the target directory',
  usage: unzipUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (hasHelp(ctx.argv)) {
      return ok(`${unzipUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, unzipSpec)
    if (parsed.error) {
      return fail(`unzip: ${parsed.error}\n`, 2)
    }
    if (parsed.operands.length === 0) {
      return usageError('unzip', 'missing operand')
    }
    const archiveWord = parsed.operands[0]
    let bytes: Uint8Array
    try {
      bytes = readInputBytes(ctx, archiveWord)
    } catch (error) {
      return fail(`unzip: ${archiveWord}: ${reasonOf(error)}\n`)
    }
    let archive: Record<string, Uint8Array>
    try {
      archive = unzipSync(bytes)
    } catch (error) {
      return fail(`unzip: ${archiveWord}: ${reasonOf(error)}\n`)
    }
    const names = Object.keys(archive).sort()
    const patterns = parsed.operands.slice(1)
    const quiet = flagOn(parsed.flags, 'q', 'quiet')
    if (flagOn(parsed.flags, 'l', 'list')) {
      const lines: string[] = []
      for (const name of names) {
        if (!matchesPattern(name, patterns)) {
          continue
        }
        lines.push(`${String(archive[name].byteLength).padStart(10)}  ${name}\n`)
      }
      const count = lines.length
      return ok(`${lines.join('')}${count} file${count === 1 ? '' : 's'}\n`)
    }
    const overwrite = flagOn(parsed.flags, 'o', 'overwrite')
    const directory = flagText(parsed.flags, 'd', 'directory')
    const destDir = directory === null ? ctx.cwd : resolvePath(ctx.cwd, directory)
    try {
      ctx.fs.mkdir(destDir, true)
    } catch (error) {
      return fail(`unzip: ${directory ?? destDir}: ${reasonOf(error)}\n`)
    }
    const stdout: string[] = []
    const warnings: string[] = []
    let code = 0
    for (const name of names) {
      if (interrupted(ctx)) {
        return ABORTED
      }
      if (!matchesPattern(name, patterns)) {
        continue
      }
      const relative = safeRelativeName(name)
      if (relative === null) {
        warnings.push(`unzip: skipping unsafe path '${name}'\n`)
        code = 1
        continue
      }
      if (relative === '') {
        continue
      }
      const target = normalizePath(`${destDir}/${relative}`)
      if (name.endsWith('/')) {
        try {
          ctx.fs.mkdir(target, true)
        } catch (error) {
          warnings.push(`unzip: ${relative}: ${reasonOf(error)}\n`)
          code = 1
        }
        continue
      }
      if (!overwrite && ctx.fs.exists(target)) {
        warnings.push(`unzip: ${relative}: file already exists\n`)
        code = 1
        continue
      }
      try {
        ctx.fs.mkdir(dirName(target), true)
        ctx.fs.write(target, archive[name])
      } catch (error) {
        warnings.push(`unzip: ${relative}: ${reasonOf(error)}\n`)
        code = 1
        continue
      }
      if (!quiet) {
        stdout.push(`  extracting: ${relative}\n`)
      }
    }
    return { code, stdout: stdout.join(''), stderr: warnings.join('') }
  },
}

/** 注册表：extras.ts 里的 EXTRAS_APPLETS 直接展开这个数组 */
export const EXTRAS_DATA_APPLETS: Applet[] = [
  basenameApplet,
  dirnameApplet,
  realpathApplet,
  readlinkApplet,
  mktempApplet,
  nprocApplet,
  timeoutApplet,
  splitApplet,
  shufApplet,
  joinApplet,
  commApplet,
  zipApplet,
  unzipApplet,
]
