import type { Applet, AppletContext, AppletResult } from '../types.js'
import { ERRNO_TEXT, VmError } from '../types.js'
import { resolvePath } from '../fs.js'
import { fail, interrupted, ok, parseArgs, readInputBytes, type ParsedArgs } from './helpers.js'

/**
 * 字节 / 文本层面的补充命令：哈希校验、十六进制与可见字符、列排版、度量换算。
 *
 * 这一组是 busybox 里「看字节」和「排文本」的常用工具：sha512sum / strings /
 * hexdump / xxd / column / fold / expand / unexpand / numfmt / cmp / base32 / od。
 * 和 core、text、archive 里的程序一样直接跑在 VFS 上：输入走 readInputBytes
 * （`-` 表示标准输入），输出只有文本通道，二进制结果只能写文件。
 *
 * 与 GNU 对齐的约定：多文件按顺序处理，单个文件读失败记一条错误后继续
 * （GNU 行为），全部处理完以 1 退出；长循环里检查 interrupted，中断返回 130
 * 并保留已经产出的 stdout；未知选项走 parseArgs 的 error，按 text.ts 的习惯
 * 当用法错误处理，退出码 2（少数按 GNU 语义需要 1 的地方会单独注释）。
 */

const DECODER = new TextDecoder()

/** 终端只有文本通道：二进制结果不往 stdout 倒 */
const BINARY_HINT = '二进制数据无法写入文本终端'

// ---------- 共用小工具 ----------

/** 只有 `-h` / `--help` 单独出现时才当求助，和 text.ts 一致 */
const wantsHelp = (argv: string[]): boolean =>
  argv.length === 2 && (argv[1] === '-h' || argv[1] === '--help')

/** 把 catch 到的异常翻译成人读的原因（VmError 用 errno 文案） */
const describeError = (error: unknown): string => {
  if (error instanceof VmError) {
    return ERRNO_TEXT[error.code] ?? error.message
  }
  return error instanceof Error ? error.message : String(error)
}

const flagOn = (flags: ParsedArgs['flags'], name: string): boolean => flags[name] === true

const flagText = (flags: ParsedArgs['flags'], name: string): string | null => {
  const value = flags[name]
  return typeof value === 'string' ? value : null
}

/** 用法错误：退出码 2，与 text.ts 的 usageError 对齐 */
const usageError = (command: string, message: string): AppletResult =>
  fail(`${command}: ${message}\n`, 2)

/** 运行期错误：默认退出码 1 */
const runtimeError = (command: string, message: string, code = 1): AppletResult =>
  fail(`${command}: ${message}\n`, code)

/** 解析十进制 / 0x 十六进制 / 0 开头八进制；不认识返回 null */
const parseByteCount = (text: string): number | null => {
  const trimmed = text.trim()
  if (/^0[xX][0-9a-fA-F]+$/.test(trimmed)) {
    return Number.parseInt(trimmed.slice(2), 16)
  }
  if (/^0[0-7]+$/.test(trimmed)) {
    return Number.parseInt(trimmed.slice(1), 8)
  }
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null
}

const HEX_DIGITS = '0123456789abcdef'

/** 一个字节的两位小写十六进制 */
const hexByte = (byte: number): string => `${HEX_DIGITS[byte >> 4]}${HEX_DIGITS[byte & 0x0f]}`

const hexOfBytes = (bytes: Uint8Array): string => {
  let text = ''
  for (const byte of bytes) {
    text += hexByte(byte)
  }
  return text
}

/** 可打印 ASCII（0x20–0x7e）；strings / hexdump / od 的可见判定都用它 */
const isPrintableAscii = (byte: number): boolean => byte >= 0x20 && byte <= 0x7e

const concatBytes = (chunks: Uint8Array[]): Uint8Array => {
  let total = 0
  for (const chunk of chunks) {
    total += chunk.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
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

/** 读多个操作数拼成一条字节流：hexdump / od 按 GNU 习惯把文件当成连续流 */
const readAllInputs = (
  ctx: AppletContext,
  operands: string[],
  command: string
): { bytes: Uint8Array; errors: string } => {
  const chunks: Uint8Array[] = []
  let errors = ''
  const sources = operands.length > 0 ? operands : ['-']
  for (const operand of sources) {
    try {
      chunks.push(readInputBytes(ctx, operand))
    } catch (error) {
      errors += `${command}: ${operand}: ${describeError(error)}\n`
    }
  }
  return { bytes: concatBytes(chunks), errors }
}

/** 读一个输入源并解码成文本，`-` 直接用 stdin */
const readDecoded = (ctx: AppletContext, operand: string): string =>
  operand === '-' ? ctx.stdin : DECODER.decode(readInputBytes(ctx, operand))

const withNewline = (text: string): string =>
  text === '' || text.endsWith('\n') ? text : `${text}\n`

/** 严格 UTF-8 解码：失败返回 null，调用方据此判断二进制 */
const decodeTextStrict = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

const hasNul = (bytes: Uint8Array): boolean => {
  const limit = Math.min(bytes.byteLength, 8000)
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) {
      return true
    }
  }
  return false
}

/** 把文本按固定宽度折行，宽度 0 表示不折；空输入不产生输出行 */
const wrapText = (text: string, width: number): string => {
  if (text === '') {
    return ''
  }
  if (width <= 0 || text.length <= width) {
    return `${text}\n`
  }
  const lines: string[] = []
  for (let index = 0; index < text.length; index += width) {
    lines.push(text.slice(index, index + width))
  }
  return `${lines.join('\n')}\n`
}

// ---------- sha512sum ----------

const sha512Usage = 'sha512sum [-bc] [file...]｜默认 "<hex>  <文件>"，-c 校验清单，-b 用 * 分隔'

/** WebCrypto 算 SHA-512；浏览器 / Node 都支持，缺 crypto.subtle 时明确报错 */
const sha512Hex = async (bytes: Uint8Array): Promise<string> => {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new VmError(
      'ENOSYS',
      '当前环境不可用 WebCrypto，无法计算 SHA-512（页面需要 https 或 localhost）'
    )
  }
  // 复制一份，拿到确定以 ArrayBuffer 为底的视图（BufferSource 的类型要求）
  const digest = await subtle.digest('SHA-512', new Uint8Array(bytes))
  return hexOfBytes(new Uint8Array(digest))
}

/** -c：逐行校验清单，输出与 archive.ts 里的 sha256sum -c 一致 */
const checkSha512List = async (ctx: AppletContext, listFile: string): Promise<AppletResult> => {
  let raw: Uint8Array
  try {
    raw = readInputBytes(ctx, listFile)
  } catch (error) {
    return fail(`sha512sum: ${listFile}: ${describeError(error)}\n`)
  }
  const lines = DECODER.decode(raw).split('\n')
  const output: string[] = []
  let failures = 0
  for (const line of lines) {
    if (interrupted(ctx)) {
      return { code: 130, stdout: output.join(''), stderr: 'sha512sum: interrupted\n' }
    }
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    const match = /^([0-9a-fA-F]{128})\s+[* ]?(.+)$/.exec(trimmed)
    if (!match) {
      output.push(`${trimmed}: 格式不正确\n`)
      failures += 1
      continue
    }
    const expected = match[1].toLowerCase()
    const file = match[2].trim()
    try {
      const actual = await sha512Hex(readInputBytes(ctx, file))
      if (actual === expected) {
        output.push(`${file}: OK\n`)
      } else {
        output.push(`${file}: FAILED\n`)
        failures += 1
      }
    } catch {
      output.push(`${file}: FAILED open or read\n`)
      failures += 1
    }
  }
  if (failures > 0) {
    return {
      code: 1,
      stdout: output.join(''),
      stderr: `sha512sum: WARNING: ${failures} 个校验和不匹配\n`,
    }
  }
  return { code: 0, stdout: output.join('') }
}

const sha512sumApplet: Applet = {
  name: 'sha512sum',
  summary: '计算文件或标准输入的 SHA-512 校验和，-c 按清单校验',
  summaryEn: 'Print or verify SHA-512 checksums',
  usage: sha512Usage,
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${sha512Usage}\n`)
    }
    // -t（文本模式）是 GNU 的默认行为，接受但不改变输出
    const parsed = parseArgs(ctx.argv, { b: 'boolean', c: 'boolean', t: 'boolean' })
    if (parsed.error) {
      return usageError('sha512sum', parsed.error)
    }
    const files = parsed.operands.length > 0 ? parsed.operands : ['-']
    if (flagOn(parsed.flags, 'c')) {
      // 和 archive.ts 的 sha256sum -c 一样，只读第一份清单
      return checkSha512List(ctx, files[0])
    }
    const separator = flagOn(parsed.flags, 'b') ? '*' : ' '
    const output: string[] = []
    for (const file of files) {
      if (interrupted(ctx)) {
        return { code: 130, stdout: output.join(''), stderr: 'sha512sum: interrupted\n' }
      }
      let hex: string
      try {
        hex = await sha512Hex(readInputBytes(ctx, file))
      } catch (error) {
        return {
          code: 1,
          stdout: output.join(''),
          stderr: `sha512sum: ${file}: ${describeError(error)}\n`,
        }
      }
      output.push(`${hex} ${separator}${file}\n`)
    }
    return { code: 0, stdout: output.join('') }
  },
}

// ---------- strings ----------

type StringRadix = 'o' | 'd' | 'x'

const stringsUsage = 'strings [-a] [-n N] [-t o|d|x] [file...]｜抽出长度 ≥N 的可打印 ASCII 串'

/** 偏移前缀：GNU 右对齐到 7 列；-t o 用八进制、-t d 十进制、-t x 十六进制 */
const stringOffsetPrefix = (offset: number, radix: StringRadix): string => {
  const text =
    radix === 'o' ? offset.toString(8) : radix === 'd' ? String(offset) : offset.toString(16)
  return `${text.padStart(7, ' ')} `
}

/** 扫一段二进制里的可打印串；每 16KB 检查一次中断 */
const collectStrings = (
  bytes: Uint8Array,
  minLength: number,
  radix: StringRadix | null,
  ctx: AppletContext
): { lines: string[]; aborted: boolean } => {
  const lines: string[] = []
  let run = ''
  let runStart = 0
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if ((index & 0x3fff) === 0 && interrupted(ctx)) {
      return { lines, aborted: true }
    }
    const byte = bytes[index]
    if (isPrintableAscii(byte)) {
      if (run === '') {
        runStart = index
      }
      run += String.fromCharCode(byte)
      continue
    }
    if (run.length >= minLength) {
      lines.push(`${radix === null ? '' : stringOffsetPrefix(runStart, radix)}${run}\n`)
    }
    run = ''
  }
  if (run.length >= minLength) {
    lines.push(`${radix === null ? '' : stringOffsetPrefix(runStart, radix)}${run}\n`)
  }
  return { lines, aborted: false }
}

const stringsApplet: Applet = {
  name: 'strings',
  summary: '从二进制里抽出长度不少于 N（默认 4）的可打印 ASCII 串',
  summaryEn: 'Print sequences of printable ASCII characters from binary input',
  usage: stringsUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${stringsUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, { a: 'boolean', n: 'value', t: 'value' })
    if (parsed.error) {
      return usageError('strings', parsed.error)
    }
    const lengthText = flagText(parsed.flags, 'n')
    let minLength = 4
    if (lengthText !== null) {
      const value = parseByteCount(lengthText)
      if (value === null || value < 1) {
        return runtimeError('strings', `invalid minimum string length: '${lengthText}'`)
      }
      minLength = value
    }
    const radixText = flagText(parsed.flags, 't')
    let radix: StringRadix | null = null
    if (radixText !== null) {
      if (radixText !== 'o' && radixText !== 'd' && radixText !== 'x') {
        return runtimeError('strings', `invalid radix '${radixText}'（支持 o / d / x）`)
      }
      radix = radixText
    }
    // -a（扫全文件）本来就是默认行为，接受但无作用
    const files = parsed.operands.length > 0 ? parsed.operands : ['-']
    const output: string[] = []
    let errors = ''
    let code = 0
    for (const file of files) {
      let bytes: Uint8Array
      try {
        bytes = readInputBytes(ctx, file)
      } catch (error) {
        errors += `strings: ${file}: ${describeError(error)}\n`
        code = 1
        continue
      }
      const scan = collectStrings(bytes, minLength, radix, ctx)
      output.push(...scan.lines)
      if (scan.aborted) {
        return { code: 130, stdout: output.join(''), stderr: `${errors}strings: interrupted\n` }
      }
    }
    return { code, stdout: output.join(''), stderr: errors }
  },
}

// ---------- hexdump ----------

const hexdumpUsage = 'hexdump [-C] [-v] [-n N] [-s OFFSET] [file...]｜-C canonical，-v 不折叠重复行'

/**
 * ASCII 列：可打印字符原样，其余用 '.'。
 * GNU hexdump 对末行的 ASCII 列不补空格（只有十六进制区补齐），这里保持一致。
 */
const asciiColumn = (chunk: Uint8Array): string => {
  let text = ''
  for (const byte of chunk) {
    text += isPrintableAscii(byte) ? String.fromCharCode(byte) : '.'
  }
  return text
}

/** canonical（-C）：8 位十六进制偏移 + 两列 8 个字节 + |ASCII| */
const canonicalHexdumpLine = (offset: number, chunk: Uint8Array): string => {
  let first = ''
  let second = ''
  for (let index = 0; index < 8; index += 1) {
    first += index < chunk.byteLength ? `${hexByte(chunk[index])} ` : '   '
  }
  for (let index = 8; index < 16; index += 1) {
    second += index < chunk.byteLength ? `${hexByte(chunk[index])} ` : '   '
  }
  return `${offset.toString(16).padStart(8, '0')}  ${first} ${second} |${asciiColumn(chunk)}|\n`
}

/**
 * 默认格式：7 位十六进制偏移 + 两列 8 字节的十六进制 + |ASCII|。
 * 与 GNU hexdump 的默认格式（小端 16 位字、没有 ASCII 列）不同，
 * 这里按本文件的规范走「两列 8 字节 + 右侧 ASCII」。
 */
const wordHexdumpLine = (offset: number, chunk: Uint8Array): string => {
  const head = hexOfBytes(chunk.subarray(0, Math.min(8, chunk.byteLength)))
  const tail = hexOfBytes(chunk.subarray(8))
  const body = tail === '' ? head : `${head}  ${tail}`
  return `${offset.toString(16).padStart(7, '0')}  ${body}  |${asciiColumn(chunk)}|\n`
}

const hexdumpApplet: Applet = {
  name: 'hexdump',
  summary: '十六进制 + ASCII 的字节转储，-C 用 canonical 格式，-n / -s 取范围',
  summaryEn: 'Dump bytes in hex with ASCII; -C selects canonical format',
  usage: hexdumpUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${hexdumpUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, { C: 'boolean', v: 'boolean', n: 'value', s: 'value' })
    if (parsed.error) {
      return usageError('hexdump', parsed.error)
    }
    let skip = 0
    const skipText = flagText(parsed.flags, 's')
    if (skipText !== null) {
      const value = parseByteCount(skipText)
      if (value === null) {
        return runtimeError('hexdump', `invalid offset '${skipText}'`)
      }
      skip = value
    }
    let limit: number | null = null
    const limitText = flagText(parsed.flags, 'n')
    if (limitText !== null) {
      const value = parseByteCount(limitText)
      if (value === null) {
        return runtimeError('hexdump', `invalid byte count '${limitText}'`)
      }
      limit = value
    }
    const canonical = flagOn(parsed.flags, 'C')
    const verbose = flagOn(parsed.flags, 'v')
    const inputs = readAllInputs(ctx, parsed.operands, 'hexdump')
    const start = Math.min(skip, inputs.bytes.byteLength)
    const end =
      limit === null ? inputs.bytes.byteLength : Math.min(inputs.bytes.byteLength, start + limit)
    if (start >= end) {
      // 跳过整段或 -n 0：GNU 只打印收尾的地址行（跳过超出文件长度时按文件末尾算）
      const position = Math.min(skip, inputs.bytes.byteLength)
      const tail = position.toString(16).padStart(canonical ? 8 : 7, '0')
      return { code: inputs.errors ? 1 : 0, stdout: `${tail}\n`, stderr: inputs.errors }
    }
    const body = inputs.bytes.subarray(start, end)
    const lines: string[] = []
    let previous: Uint8Array | null = null
    let folded = false
    for (let offset = 0; offset < body.byteLength; offset += 16) {
      if ((offset & 0xffff) === 0 && interrupted(ctx)) {
        return {
          code: 130,
          stdout: lines.join(''),
          stderr: `${inputs.errors}hexdump: interrupted\n`,
        }
      }
      const chunk = body.subarray(offset, offset + 16)
      if (!verbose && previous !== null && chunk.byteLength === 16 && sameBytes(chunk, previous)) {
        if (!folded) {
          lines.push('*\n')
          folded = true
        }
        continue
      }
      folded = false
      previous = chunk.byteLength === 16 ? new Uint8Array(chunk) : null
      // -s 之后偏移仍然按文件里的绝对位置标（GNU hexdump 的行为）
      const position = start + offset
      lines.push(
        canonical ? canonicalHexdumpLine(position, chunk) : wordHexdumpLine(position, chunk)
      )
    }
    // 与 GNU 一致：末尾补一行「下一条记录的偏移」
    const address = start + body.byteLength
    lines.push(`${address.toString(16).padStart(canonical ? 8 : 7, '0')}\n`)
    return { code: inputs.errors ? 1 : 0, stdout: lines.join(''), stderr: inputs.errors }
  },
}

// ---------- xxd ----------

const xxdUsage = 'xxd [-p] [-l N] [-c N] [-s OFFSET] [file]｜-r 还原：xxd -r 输入.hex 输出.bin'

/** xxd 的 hex 区宽度：每两个字节一组（4 位十六进制），组间一个空格 */
const xxdHexWidth = (cols: number): number => {
  const groups = Math.ceil(cols / 2)
  return groups * 4 + (groups - 1)
}

/** 默认格式：`偏移: 4 位十六进制 4 位一组…  ASCII` */
const xxdLine = (offset: number, chunk: Uint8Array, cols: number): string => {
  const groups: string[] = []
  for (let index = 0; index < chunk.byteLength; index += 2) {
    const high = hexByte(chunk[index])
    const low = index + 1 < chunk.byteLength ? hexByte(chunk[index + 1]) : ''
    groups.push(`${high}${low}`)
  }
  let ascii = ''
  for (const byte of chunk) {
    ascii += isPrintableAscii(byte) ? String.fromCharCode(byte) : '.'
  }
  const hexText = groups.join(' ').padEnd(xxdHexWidth(cols), ' ')
  return `${offset.toString(16).padStart(8, '0')}: ${hexText}  ${ascii}\n`
}

/** -p 纯 hex 里只留十六进制字符 */
const decodePlainHex = (text: string): Uint8Array | null => {
  const cleaned = text.replace(/\s+/g, '')
  if (cleaned === '') {
    return new Uint8Array(0)
  }
  if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
    return null
  }
  const out = new Uint8Array(cleaned.length / 2)
  for (let index = 0; index < cleaned.length; index += 2) {
    out[index / 2] = Number.parseInt(cleaned.slice(index, index + 2), 16)
  }
  return out
}

/**
 * 解析 xxd 自己的默认格式：`偏移: hex…  ASCII`。
 * hex 区与 ASCII 区之间是两个以上空格，因此只取第一段就够，不会被
 * 恰好长得像十六进制的 ASCII 内容骗到。偏移列不参与还原（忽略定位）。
 */
const decodeXxdText = (text: string): Uint8Array | null => {
  const out: number[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed === '*') {
      continue
    }
    const body = trimmed.replace(/^[0-9a-fA-F]+:\s*/, '')
    const [hexPart = ''] = body.split(/ {2,}/)
    for (const token of hexPart.split(/\s+/)) {
      if (token === '') {
        continue
      }
      if (!/^[0-9a-fA-F]+$/.test(token) || token.length % 2 !== 0) {
        return null
      }
      for (let index = 0; index < token.length; index += 2) {
        out.push(Number.parseInt(token.slice(index, index + 2), 16))
      }
    }
  }
  return new Uint8Array(out)
}

/** -r：从 hex 文本还原本地文件（stdout 只有文本通道，必须给输出文件） */
const reverseXxd = (ctx: AppletContext, plain: boolean, operands: string[]): AppletResult => {
  if (operands.length !== 2) {
    return fail(
      'xxd: -r 需要两个参数：xxd -r 输入.hex 输出.bin（还原结果可能是二进制，只能写入文件）\n'
    )
  }
  const [source, target] = operands
  let raw: Uint8Array
  try {
    raw = readInputBytes(ctx, source)
  } catch (error) {
    return fail(`xxd: ${source}: ${describeError(error)}\n`)
  }
  const bytes = plain ? decodePlainHex(DECODER.decode(raw)) : decodeXxdText(DECODER.decode(raw))
  if (bytes === null) {
    return fail(`xxd: ${source}: 不是有效的 hex 数据（-p 用连续十六进制，否则用 xxd 默认格式）\n`)
  }
  try {
    ctx.fs.write(resolvePath(ctx.cwd, target), bytes)
  } catch (error) {
    return fail(`xxd: ${target}: ${describeError(error)}\n`)
  }
  return ok('')
}

const xxdApplet: Applet = {
  name: 'xxd',
  summary: '十六进制转储，-p 纯 hex，-r 从 hex 还原到文件',
  summaryEn: 'Hex dump with ASCII, or reverse hex text back into a file',
  usage: xxdUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${xxdUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, {
      p: 'boolean',
      r: 'boolean',
      l: 'value',
      c: 'value',
      s: 'value',
    })
    if (parsed.error) {
      return usageError('xxd', parsed.error)
    }
    const plain = flagOn(parsed.flags, 'p')
    if (flagOn(parsed.flags, 'r')) {
      return reverseXxd(ctx, plain, parsed.operands)
    }
    if (parsed.operands.length > 1) {
      return usageError('xxd', `extra operand '${parsed.operands[1]}'`)
    }
    let cols = plain ? 30 : 16
    const colsText = flagText(parsed.flags, 'c')
    if (colsText !== null) {
      const value = parseByteCount(colsText)
      if (value === null || value < 1) {
        return runtimeError('xxd', `invalid number of columns: '${colsText}'`)
      }
      cols = value
    }
    let skip = 0
    const skipText = flagText(parsed.flags, 's')
    if (skipText !== null) {
      const value = parseByteCount(skipText)
      if (value === null) {
        return runtimeError('xxd', `invalid seek offset: '${skipText}'`)
      }
      skip = value
    }
    let limit: number | null = null
    const limitText = flagText(parsed.flags, 'l')
    if (limitText !== null) {
      const value = parseByteCount(limitText)
      if (value === null) {
        return runtimeError('xxd', `invalid length: '${limitText}'`)
      }
      limit = value
    }
    const file = parsed.operands[0] ?? '-'
    let bytes: Uint8Array
    try {
      bytes = readInputBytes(ctx, file)
    } catch (error) {
      return fail(`xxd: ${file}: ${describeError(error)}\n`)
    }
    const start = Math.min(skip, bytes.byteLength)
    const end = limit === null ? bytes.byteLength : Math.min(bytes.byteLength, start + limit)
    const body = bytes.subarray(start, end)
    const lines: string[] = []
    if (plain) {
      // -p：连续十六进制，每行 cols 个字节
      const hex = hexOfBytes(body)
      const wrap = cols * 2
      for (let index = 0; index < hex.length; index += wrap) {
        lines.push(`${hex.slice(index, index + wrap)}\n`)
      }
      return ok(lines.join(''))
    }
    for (let offset = 0; offset < body.byteLength; offset += cols) {
      if ((offset & 0xffff) === 0 && interrupted(ctx)) {
        return { code: 130, stdout: lines.join(''), stderr: 'xxd: interrupted\n' }
      }
      const chunk = body.subarray(offset, offset + cols)
      lines.push(xxdLine(start + offset, chunk, cols))
    }
    return ok(lines.join(''))
  },
}

// ---------- column ----------

const columnUsage = 'column [-t] [-s SEP] [-o OUTSEP] [file...]｜-t 按列对齐'

/** 按字符（码点）宽度算，中文按 1 列，够用且和 -o 的输出稳定 */
const cellWidth = (text: string): number => [...text].length

const splitColumns = (line: string, separator: string | null): string[] => {
  if (separator !== null) {
    return line.split(separator).map((cell) => cell.trim())
  }
  const trimmed = line.trim()
  return trimmed === '' ? [] : trimmed.split(/\s+/)
}

const columnApplet: Applet = {
  name: 'column',
  summary: '把文本排成对齐的列（-t），-s 指定分隔符、-o 指定输出分隔符',
  summaryEn: 'Format text into aligned columns',
  usage: columnUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${columnUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, { t: 'boolean', s: 'value', o: 'value' })
    if (parsed.error) {
      return usageError('column', parsed.error)
    }
    const separator = flagText(parsed.flags, 's')
    const outSeparator = flagText(parsed.flags, 'o') ?? '  '
    const sources = parsed.operands.length > 0 ? parsed.operands : ['-']
    const lines: string[] = []
    let errors = ''
    for (const operand of sources) {
      let text: string
      try {
        text = readDecoded(ctx, operand)
      } catch (error) {
        errors += `column: ${operand}: ${describeError(error)}\n`
        continue
      }
      // 末尾换行不产生空行；中间的空白行保留成空行
      const parts = text.split('\n')
      if (parts.at(-1) === '') {
        parts.pop()
      }
      lines.push(...parts)
    }
    if (!flagOn(parsed.flags, 't')) {
      return {
        code: errors ? 1 : 0,
        stdout: lines.length ? `${lines.join('\n')}\n` : '',
        stderr: errors,
      }
    }
    // GNU column -t 会丢掉空行，这里跟着做
    const rows = lines
      .map((line) => splitColumns(line, separator))
      .filter((row) => row.some((cell) => cell !== ''))
    let columnCount = 0
    for (const row of rows) {
      columnCount = Math.max(columnCount, row.length)
    }
    const widths: number[] = []
    for (let index = 0; index < columnCount; index += 1) {
      widths.push(0)
    }
    for (const row of rows) {
      for (let index = 0; index < row.length - 1; index += 1) {
        widths[index] = Math.max(widths[index], cellWidth(row[index]))
      }
    }
    const output = rows.map((row) =>
      row
        .map((cell, index) => {
          if (index === row.length - 1) {
            return cell
          }
          return `${cell}${' '.repeat(Math.max(0, widths[index] - cellWidth(cell)))}`
        })
        .join(outSeparator)
    )
    return {
      code: errors ? 1 : 0,
      stdout: output.length ? `${output.join('\n')}\n` : '',
      stderr: errors,
    }
  },
}

// ---------- fold ----------

const foldUsage = 'fold [-w N] [-s] [file...]｜默认宽度 80，-s 尽量在空格处折'

/** 折一行；-s 时在宽度内找最后一个空格，找不到就硬折（空格留在行尾） */
const foldLine = (line: string, width: number, breakSpaces: boolean): string[] => {
  const chars = [...line]
  const out: string[] = []
  let start = 0
  while (chars.length - start > width) {
    let end = start + width
    if (breakSpaces) {
      for (let index = end - 1; index > start; index -= 1) {
        if (chars[index] === ' ' || chars[index] === '\t') {
          end = index + 1
          break
        }
      }
    }
    out.push(chars.slice(start, end).join(''))
    start = end
  }
  out.push(chars.slice(start).join(''))
  return out
}

const foldApplet: Applet = {
  name: 'fold',
  summary: '按宽度折行，-s 尽量在空格处断开',
  summaryEn: 'Wrap each input line to fit the given width',
  usage: foldUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${foldUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, { w: 'value', s: 'boolean' })
    if (parsed.error) {
      return usageError('fold', parsed.error)
    }
    let width = 80
    const widthText = flagText(parsed.flags, 'w')
    if (widthText !== null) {
      const value = parseByteCount(widthText)
      if (value === null || value < 1) {
        return runtimeError('fold', `invalid number of columns: '${widthText}'`)
      }
      width = value
    }
    const breakSpaces = flagOn(parsed.flags, 's')
    const sources = parsed.operands.length > 0 ? parsed.operands : ['-']
    const output: string[] = []
    let errors = ''
    for (const operand of sources) {
      let text: string
      try {
        text = readDecoded(ctx, operand)
      } catch (error) {
        errors += `fold: ${operand}: ${describeError(error)}\n`
        continue
      }
      if (interrupted(ctx)) {
        return {
          code: 130,
          stdout: output.join(''),
          stderr: `${errors}fold: interrupted\n`,
        }
      }
      const parts = text.split('\n')
      if (parts.at(-1) === '') {
        parts.pop()
      }
      for (const line of parts) {
        output.push(...foldLine(line, width, breakSpaces))
      }
    }
    return {
      code: errors ? 1 : 0,
      stdout: output.length ? `${output.join('\n')}\n` : '',
      stderr: errors,
    }
  },
}

// ---------- expand / unexpand ----------

const expandUsage = 'expand [-t N] [-i] [file...]｜默认制表位 8，-i 只转行首空白'

const unexpandUsage = 'unexpand [-t N] [-a] [file...]｜默认只转行首，-a 全部转换'

/** 制表位推进：当前列 column，制表宽 tabSize，返回下一个制表位 */
const nextTabStop = (column: number, tabSize: number): number =>
  column + tabSize - (column % tabSize)

/** tab → 空格：按列号计算补齐数量，-i 只处理行首连续空白 */
const expandText = (text: string, tabSize: number, initialOnly: boolean): string => {
  const parts = text.split('\n')
  if (parts.at(-1) === '') {
    parts.pop()
  }
  const out: string[] = []
  for (const line of parts) {
    let column = 0
    let output = ''
    let leading = true
    for (const char of line) {
      if (char === '\t') {
        const stop = nextTabStop(column, tabSize)
        if (!initialOnly || leading) {
          output += ' '.repeat(stop - column)
        } else {
          output += '\t'
        }
        column = stop
        continue
      }
      output += char
      column += 1
      if (char !== ' ') {
        leading = false
      }
    }
    out.push(output)
  }
  return out.length ? `${out.join('\n')}\n` : ''
}

/**
 * 空格 → tab：列号每到制表位时，把攒下的空格换成一个 tab。
 * 只有 -a 时才能转换非行首的空白（GNU 的默认行为）。
 */
const unexpandText = (text: string, tabSize: number, all: boolean): string => {
  const parts = text.split('\n')
  if (parts.at(-1) === '') {
    parts.pop()
  }
  const out: string[] = []
  for (const line of parts) {
    let column = 0
    let spaces = 0
    let output = ''
    let leading = true
    for (const char of line) {
      const convert = all || leading
      if (char === ' ') {
        spaces += 1
        column += 1
        if (convert && column % tabSize === 0) {
          output += '\t'
          spaces = 0
        }
        continue
      }
      if (spaces > 0) {
        output += ' '.repeat(spaces)
        spaces = 0
      }
      if (char === '\t') {
        output += '\t'
        column = nextTabStop(column, tabSize)
        continue
      }
      output += char
      column += 1
      if (char !== ' ') {
        leading = false
      }
    }
    if (spaces > 0) {
      output += ' '.repeat(spaces)
    }
    out.push(output)
  }
  return out.length ? `${out.join('\n')}\n` : ''
}

/** expand / unexpand 共用的 -t 解析与逐文件处理 */
const tabConvert = (command: 'expand' | 'unexpand', ctx: AppletContext): AppletResult => {
  if (wantsHelp(ctx.argv)) {
    return ok(`${command === 'expand' ? expandUsage : unexpandUsage}\n`)
  }
  const parsed = parseArgs(ctx.argv, { t: 'value', i: 'boolean', a: 'boolean' })
  if (parsed.error) {
    return usageError(command, parsed.error)
  }
  let tabSize = 8
  const tabText = flagText(parsed.flags, 't')
  if (tabText !== null) {
    // GNU 支持 -t 1,4,8 这样的多制表位；这里只支持单一的制表位宽度
    const value = parseByteCount(tabText)
    if (value === null || value < 1) {
      return runtimeError(command, `invalid tab size: '${tabText}'`)
    }
    tabSize = value
  }
  const initialOnly = flagOn(parsed.flags, 'i')
  const all = flagOn(parsed.flags, 'a')
  const sources = parsed.operands.length > 0 ? parsed.operands : ['-']
  const output: string[] = []
  let errors = ''
  for (const operand of sources) {
    let text: string
    try {
      text = readDecoded(ctx, operand)
    } catch (error) {
      errors += `${command}: ${operand}: ${describeError(error)}\n`
      continue
    }
    if (interrupted(ctx)) {
      return { code: 130, stdout: output.join(''), stderr: `${errors}${command}: interrupted\n` }
    }
    output.push(
      command === 'expand'
        ? expandText(text, tabSize, initialOnly)
        : unexpandText(text, tabSize, all)
    )
  }
  return { code: errors ? 1 : 0, stdout: output.join(''), stderr: errors }
}

const expandApplet: Applet = {
  name: 'expand',
  summary: '把制表符换成空格，-t 指定制表位（默认 8），-i 只转行首空白',
  summaryEn: 'Convert tabs to spaces',
  usage: expandUsage,
  run: (ctx: AppletContext): AppletResult => tabConvert('expand', ctx),
}

const unexpandApplet: Applet = {
  name: 'unexpand',
  summary: '把空格换成制表符，-t 指定制表位（默认 8），-a 转换所有空白',
  summaryEn: 'Convert spaces to tabs',
  usage: unexpandUsage,
  run: (ctx: AppletContext): AppletResult => tabConvert('unexpand', ctx),
}

// ---------- numfmt ----------

type NumfmtMode = 'si' | 'iec'
type RoundMode = 'up' | 'down' | 'nearest'

// 大写 K 是本文件的约定（GNU numfmt 在英文 locale 下输出小写 1.0k）
const SI_UNITS = ['', 'K', 'M', 'G', 'T', 'P', 'E']
const IEC_UNITS = ['', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei']

const numfmtUsage =
  'numfmt [--to=si|iec] [--from=si|iec] [--suffix=S] [--padding=N] [--round=up|down|nearest] [数字...]'

/** stdin 按行取数字，忽略空行 */
const splitInputLines = (text: string): string[] => {
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') {
      lines.push(trimmed)
    }
  }
  return lines
}

/** 按 to 模式做缩放：不足一个单位时原样输出，否则保留一位小数 */
const scaleNumber = (value: number, mode: NumfmtMode, round: RoundMode): string => {
  const base = mode === 'si' ? 1000 : 1024
  const units = mode === 'si' ? SI_UNITS : IEC_UNITS
  let scaled = value
  let unit = 0
  while (Math.abs(scaled) >= base && unit < units.length - 1) {
    scaled /= base
    unit += 1
  }
  if (unit === 0) {
    return String(value)
  }
  const tenths = scaled * 10
  const rounded =
    round === 'up' ? Math.ceil(tenths) : round === 'down' ? Math.floor(tenths) : Math.round(tenths)
  return `${(rounded / 10).toFixed(1)}${units[unit]}`
}

/** 按 from 模式解析 `1K` / `1.5Ki` 这样的带单位数字 */
const parseScaledNumber = (text: string, mode: NumfmtMode): number | null => {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([A-Za-z]*)$/.exec(text.trim())
  if (!match) {
    return null
  }
  const value = Number.parseFloat(match[1])
  const suffix = match[2].toLowerCase()
  if (suffix === '') {
    return value
  }
  const base = mode === 'si' ? 1000 : 1024
  const units = mode === 'si' ? SI_UNITS : IEC_UNITS
  // iec 同时接受 K 与 Ki 两种写法
  const index = units.findIndex(
    (unit) =>
      unit !== '' &&
      (unit.toLowerCase() === suffix || unit.toLowerCase().replace(/i$/, '') === suffix)
  )
  if (index < 0) {
    return null
  }
  return value * base ** index
}

/**
 * 每个数字一行输出。--to 缩放、--from 反解；没给数字时读 stdin 的每一行。
 * 这个命令的「做不到」按 GNU 语义退出 1，非法数字退出 2。
 */
const numfmtApplet: Applet = {
  name: 'numfmt',
  summary: '数字与人类可读单位互转（si 1000 进制 / iec 1024 进制）',
  summaryEn: 'Convert numbers to and from human-readable units (si / iec)',
  usage: numfmtUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${numfmtUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, {
      to: 'value',
      from: 'value',
      suffix: 'value',
      padding: 'value',
      round: 'value',
      // 下面这些 GNU numfmt 的选项这一版做不到，明确报「不支持」
      field: 'value',
      delimiter: 'value',
      grouping: 'value',
      format: 'value',
      invalid: 'value',
      header: 'value',
      'zero-terminated': 'boolean',
      'to-unit': 'value',
      'from-unit': 'value',
      debug: 'boolean',
    })
    if (parsed.error) {
      return usageError('numfmt', parsed.error)
    }
    const unsupported = [
      'field',
      'delimiter',
      'grouping',
      'format',
      'invalid',
      'header',
      'zero-terminated',
      'to-unit',
      'from-unit',
      'debug',
    ]
    const blocked = unsupported.find((name) => parsed.flags[name] !== undefined)
    if (blocked !== undefined) {
      return fail(`numfmt: 不支持 --${blocked}\n`)
    }
    const toText = flagText(parsed.flags, 'to')
    if (toText !== null && toText !== 'si' && toText !== 'iec') {
      return fail(`numfmt: 不支持 --to=${toText}（只支持 si / iec）\n`)
    }
    const fromText = flagText(parsed.flags, 'from')
    if (fromText !== null && fromText !== 'si' && fromText !== 'iec') {
      return fail(`numfmt: 不支持 --from=${fromText}（只支持 si / iec）\n`)
    }
    const roundText = flagText(parsed.flags, 'round') ?? 'nearest'
    if (roundText !== 'up' && roundText !== 'down' && roundText !== 'nearest') {
      return fail(`numfmt: 不支持 --round=${roundText}（只支持 up / down / nearest）\n`)
    }
    const suffix = flagText(parsed.flags, 'suffix')
    let padding: number | null = null
    const paddingText = flagText(parsed.flags, 'padding')
    if (paddingText !== null) {
      if (!/^-?\d+$/.test(paddingText.trim())) {
        return fail(`numfmt: invalid padding value '${paddingText}'\n`)
      }
      padding = Number.parseInt(paddingText, 10)
    }
    const toMode: NumfmtMode | null = toText === null ? null : toText
    const fromMode: NumfmtMode | null = fromText === null ? null : fromText
    const roundMode: RoundMode = roundText
    const sources = parsed.operands.length > 0 ? parsed.operands : splitInputLines(ctx.stdin)
    const output: string[] = []
    for (const source of sources) {
      let value: number
      if (fromMode === null) {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(source.trim())) {
          return {
            code: 2,
            stdout: output.join(''),
            stderr: `numfmt: invalid number: '${source}'\n`,
          }
        }
        value = Number.parseFloat(source.trim())
      } else {
        const parsedValue = parseScaledNumber(source, fromMode)
        if (parsedValue === null) {
          return {
            code: 2,
            stdout: output.join(''),
            stderr: `numfmt: invalid number: '${source}'\n`,
          }
        }
        value = parsedValue
      }
      let body: string
      if (toMode === null) {
        // 没有 --to：只做 --from 的反解，结果按整数输出（与 GNU 一致）
        body = fromMode === null ? String(value) : String(Math.round(value))
      } else {
        body = scaleNumber(value, toMode, roundMode)
      }
      if (suffix !== null) {
        body += suffix
      }
      if (padding !== null) {
        body = padding >= 0 ? body.padStart(padding) : body.padEnd(-padding)
      }
      output.push(`${body}\n`)
    }
    return { code: 0, stdout: output.join('') }
  },
}

// ---------- cmp ----------

const cmpUsage = 'cmp [-s] [-l] [-b] <file1> <file2>｜-s 静默，-l 列出全部差异，-b 显示字节'

const cmpChar = (byte: number): string => (isPrintableAscii(byte) ? String.fromCharCode(byte) : '.')

/** -l 的差异行：`byte N: o1 o2 (十进制)`，-b 再补两个字符 */
const cmpDifferenceLine = (position: number, a: number, b: number, showBytes: boolean): string => {
  const octal = (value: number): string => value.toString(8).padStart(3, '0')
  const base = `byte ${position}: ${octal(a)} ${octal(b)} (${a} ${b})`
  return showBytes ? `${base} '${cmpChar(a)}' '${cmpChar(b)}'\n` : `${base}\n`
}

const cmpApplet: Applet = {
  name: 'cmp',
  summary: '逐字节比较两个文件，默认只报第一处差异',
  summaryEn: 'Compare two files byte by byte',
  usage: cmpUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${cmpUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, { s: 'boolean', l: 'boolean', b: 'boolean' })
    if (parsed.error) {
      return usageError('cmp', parsed.error)
    }
    if (parsed.operands.length < 2) {
      const message =
        parsed.operands.length === 0
          ? 'missing operand'
          : `missing operand after '${parsed.operands[0]}'`
      return usageError('cmp', message)
    }
    if (parsed.operands.length > 2) {
      return usageError('cmp', `extra operand '${parsed.operands[2]}'`)
    }
    const [first, second] = parsed.operands
    let left: Uint8Array
    let right: Uint8Array
    try {
      left = readInputBytes(ctx, first)
    } catch (error) {
      return fail(`cmp: ${first}: ${describeError(error)}\n`, 2)
    }
    try {
      right = readInputBytes(ctx, second)
    } catch (error) {
      return fail(`cmp: ${second}: ${describeError(error)}\n`, 2)
    }
    const silent = flagOn(parsed.flags, 's')
    const listing = flagOn(parsed.flags, 'l')
    const showBytes = flagOn(parsed.flags, 'b')
    const limit = Math.min(left.byteLength, right.byteLength)
    const differences: string[] = []
    let firstDiff = -1
    let diffLine = 1
    let line = 1
    for (let index = 0; index < limit; index += 1) {
      if ((index & 0x3fff) === 0 && interrupted(ctx)) {
        return { code: 130, stdout: differences.join(''), stderr: 'cmp: interrupted\n' }
      }
      const a = left[index]
      const b = right[index]
      if (a !== b) {
        if (firstDiff < 0) {
          firstDiff = index
          diffLine = line
        }
        if (listing && !silent) {
          differences.push(cmpDifferenceLine(index + 1, a, b, showBytes))
        } else {
          // 默认与 -s 只看第一处差异，不必扫完
          break
        }
      }
      if (a === 0x0a) {
        line += 1
      }
    }
    const eofProblem = left.byteLength !== right.byteLength
    if (silent) {
      return { code: firstDiff >= 0 || eofProblem ? 1 : 0 }
    }
    const shorter = left.byteLength < right.byteLength ? first : second
    const eofMessage = eofProblem
      ? `cmp: EOF on ${shorter} after byte ${limit}, line ${line}\n`
      : ''
    if (listing) {
      return {
        code: firstDiff >= 0 || eofProblem ? 1 : 0,
        stdout: differences.join(''),
        stderr: eofMessage,
      }
    }
    if (firstDiff >= 0) {
      return {
        code: 1,
        stdout: `${first} ${second} differ: byte ${firstDiff + 1}, line ${diffLine}\n`,
      }
    }
    if (eofProblem) {
      return { code: 1, stderr: eofMessage }
    }
    return ok('')
  },
}

// ---------- base32 ----------

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

const base32Usage = 'base32 [-d] [-w N] [-o 文件] [file...]｜RFC 4648，默认每 76 字符折行'

const encodeBase32 = (bytes: Uint8Array): string => {
  let text = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      text += BASE32_CHARS[(buffer >> bits) & 0x1f]
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) {
    text += BASE32_CHARS[(buffer << (5 - bits)) & 0x1f]
  }
  while (text.length % 8 !== 0) {
    text += '='
  }
  return text
}

/** RFC 4648 解码；容忍换行与大小写，其余字符一律视为非法 */
const decodeBase32 = (text: string): Uint8Array | null => {
  const cleaned = text.replace(/\s+/g, '').toUpperCase()
  if (cleaned === '') {
    return new Uint8Array(0)
  }
  if (!/^[A-Z2-7]*={0,6}$/.test(cleaned)) {
    return null
  }
  const body = cleaned.replace(/=+$/, '')
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of body) {
    const value = BASE32_CHARS.indexOf(char)
    if (value < 0) {
      return null
    }
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
    buffer &= (1 << bits) - 1
  }
  return new Uint8Array(out)
}

const base32Applet: Applet = {
  name: 'base32',
  summary: 'base32 编解码（RFC 4648），-d 解码，-o 写到文件',
  summaryEn: 'Base32 encode or decode; -o writes the result to a file',
  usage: base32Usage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${base32Usage}\n`)
    }
    const parsed = parseArgs(ctx.argv, { d: 'boolean', w: 'value', o: 'value' })
    if (parsed.error) {
      return usageError('base32', parsed.error)
    }
    const decode = flagOn(parsed.flags, 'd')
    const outText = flagText(parsed.flags, 'o')
    let width = 76
    const widthText = flagText(parsed.flags, 'w')
    if (widthText !== null) {
      const value = parseByteCount(widthText)
      if (value === null) {
        return runtimeError('base32', `invalid wrap size: '${widthText}'`)
      }
      width = value
    }
    let text = ''
    const sources = parsed.operands.length > 0 ? parsed.operands : ['-']
    for (const operand of sources) {
      try {
        text += readDecoded(ctx, operand)
      } catch (error) {
        return fail(`base32: ${operand}: ${describeError(error)}\n`)
      }
      if (interrupted(ctx)) {
        return { code: 130, stderr: 'base32: interrupted\n' }
      }
    }
    if (!decode) {
      const wrapped = wrapText(encodeBase32(new TextEncoder().encode(text)), width)
      if (outText !== null) {
        return writeBase32Out(ctx, outText, new TextEncoder().encode(wrapped))
      }
      return ok(wrapped)
    }
    const bytes = decodeBase32(text)
    if (bytes === null) {
      return fail('base32: invalid input\n')
    }
    if (outText !== null) {
      return writeBase32Out(ctx, outText, bytes)
    }
    const decoded = decodeTextStrict(bytes)
    if (decoded === null || hasNul(bytes)) {
      return fail(`base32: 解码结果是${BINARY_HINT}；用 -o 文件 保存\n`)
    }
    return ok(withNewline(decoded))
  },
}

const writeBase32Out = (ctx: AppletContext, target: string, bytes: Uint8Array): AppletResult => {
  try {
    ctx.fs.write(resolvePath(ctx.cwd, target), bytes)
  } catch (error) {
    return fail(`base32: ${target}: ${describeError(error)}\n`)
  }
  return ok('')
}

// ---------- od ----------

type OdLetter = 'x' | 'o' | 'u' | 'd' | 'c'

type OdType = {
  letter: OdLetter
  /** 元素字节数；c 固定 1 */
  size: number
  /** 末尾的 z：追加一段可打印字符 */
  chars: boolean
}

type OdAddressBase = 'd' | 'o' | 'x' | 'n'

const odUsage = 'od [-A d|o|x|n] [-t 类型] [-N N] [-j SKIP] [-v] [file...]｜默认 -A o -t o2'

/** 数值列的有效数字宽度（不含列间空白）；c 只占 1 列 */
const odDigitWidth = (type: OdType): number => {
  const bits = type.size * 8
  switch (type.letter) {
    case 'c':
      return 1
    case 'x':
      return type.size * 2
    case 'o':
      return Math.ceil(bits / 3)
    case 'u':
      return Math.ceil(bits * Math.log10(2))
    default:
      // 带符号的十进制要多留一列给负号
      return Math.ceil(bits * Math.log10(2)) + 1
  }
}

/**
 * 每列的固定宽度：数值列在有效宽度外多留一列当列间隔，字符列固定 4 列。
 * GNU od 是「按列宽右对齐、列与列之间不再补空格」的排版，这里照抄。
 */
const odColumnWidth = (type: OdType): number => (type.letter === 'c' ? 4 : odDigitWidth(type) + 1)

/** 0x00 / 0x07 这些控制字符按 GNU 的写法输出 */
const OD_CHAR_NAMES: Record<number, string> = {
  0: '\\0',
  7: '\\a',
  8: '\\b',
  9: '\\t',
  10: '\\n',
  11: '\\v',
  12: '\\f',
  13: '\\r',
}

const odCharText = (byte: number): string => {
  if (OD_CHAR_NAMES[byte] !== undefined) {
    return OD_CHAR_NAMES[byte]
  }
  return isPrintableAscii(byte)
    ? String.fromCharCode(byte)
    : `\\${byte.toString(8).padStart(3, '0')}`
}

/** 小端读取 size 字节（超出范围的字节按 0 补齐，与 GNU 的末组补零一致） */
const readOdValue = (chunk: Uint8Array, offset: number, size: number): number => {
  let value = 0
  for (let index = 0; index < size; index += 1) {
    const byte = offset + index < chunk.byteLength ? chunk[offset + index] : 0
    value += byte * 2 ** (8 * index)
  }
  return value
}

const odFieldText = (type: OdType, chunk: Uint8Array, offset: number): string => {
  if (type.letter === 'c') {
    return odCharText(chunk[offset])
  }
  const width = odDigitWidth(type)
  const raw = readOdValue(chunk, offset, type.size)
  switch (type.letter) {
    case 'x':
      return raw.toString(16).padStart(width, '0')
    case 'o':
      return raw.toString(8).padStart(width, '0')
    case 'u':
      return String(raw).padStart(width, ' ')
    default: {
      const limit = 2 ** (type.size * 8)
      const signed = raw >= limit / 2 ? raw - limit : raw
      return String(signed).padStart(width, ' ')
    }
  }
}

const odOffsetText = (offset: number, base: OdAddressBase): string | null => {
  switch (base) {
    case 'n':
      return null
    case 'd':
      // 与 GNU 一致：十进制地址也是零填充到 7 列
      return String(offset).padStart(7, '0')
    case 'x':
      return offset.toString(16).padStart(6, '0')
    default:
      return offset.toString(8).padStart(7, '0')
  }
}

/** -t 不写宽度时的默认字节数：数值类型 4，c 是 1 */
const OD_DEFAULT_SIZE: Record<OdLetter, number> = { x: 4, o: 4, u: 4, d: 4, c: 1 }

/** 解析 -t：`x1` / `c` / `d1` / `u1` / `o1`，可以连着写多个（x1c），末尾 z 加字符列 */
const parseOdTypes = (spec: string): OdType[] | null => {
  const types: OdType[] = []
  let index = 0
  while (index < spec.length) {
    const letter = spec[index] as OdLetter
    if (!'xoduc'.includes(letter)) {
      return null
    }
    index += 1
    let sizeText = ''
    while (index < spec.length && spec[index] >= '0' && spec[index] <= '9') {
      sizeText += spec[index]
      index += 1
    }
    const size = sizeText === '' ? OD_DEFAULT_SIZE[letter] : Number.parseInt(sizeText, 10)
    if (letter === 'c') {
      if (size !== 1) {
        return null
      }
    } else if (size !== 1 && size !== 2 && size !== 4) {
      // 8 字节（d8 / o8 …）这一版没做，按不支持处理
      return null
    }
    let chars = false
    if (index < spec.length && spec[index] === 'z') {
      chars = true
      index += 1
    }
    types.push({ letter, size, chars })
  }
  return types.length > 0 ? types : null
}

/** 一行的数据类型：16 字节一组，元素按 size 切分 */
const OD_LINE_BYTES = 16

const odBlockLines = (types: OdType[], block: Uint8Array, address: string | null): string[] => {
  // 多个 -t 时 GNU 用最宽的那列统一排版，这里也取最大值
  let columnWidth = 0
  for (const type of types) {
    columnWidth = Math.max(columnWidth, odColumnWidth(type))
  }
  return types.map((type, typeIndex) => {
    const size = type.letter === 'c' ? 1 : type.size
    let body = ''
    for (let offset = 0; offset < block.byteLength; offset += size) {
      // 列与列之间不额外补空格：宽度里已经包含了一列间隔
      body += odFieldText(type, block, offset).padStart(columnWidth, ' ')
    }
    if (type.chars) {
      let chars = ''
      for (const byte of block) {
        chars += isPrintableAscii(byte) ? String.fromCharCode(byte) : '.'
      }
      // GNU od 把 z 列对齐到「整行都有数据」时的位置，末行也要补空白
      body = body.padEnd(columnWidth * Math.floor(OD_LINE_BYTES / size), ' ')
      body += `  >${chars}<`
    }
    // 第一条 -t 打地址，后面的行把地址列空出来（GNU 的多类型排版）
    const prefix = address === null ? '' : typeIndex === 0 ? address : ' '.repeat(address.length)
    return `${prefix}${body}\n`
  })
}

const odApplet: Applet = {
  name: 'od',
  summary: '八进制 / 十六进制 / 字符转储，-t 选类型，-A 选地址进制',
  summaryEn: 'Dump bytes in octal, hex, decimal or characters',
  usage: odUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${odUsage}\n`)
    }
    // 注意：多个 -t 会被 parseArgs 覆盖，只保留最后一个（GNU 会全部输出）
    const parsed = parseArgs(ctx.argv, {
      A: 'value',
      t: 'value',
      N: 'value',
      j: 'value',
      v: 'boolean',
    })
    if (parsed.error) {
      return usageError('od', parsed.error)
    }
    const addressText = flagText(parsed.flags, 'A') ?? 'o'
    if (addressText !== 'd' && addressText !== 'o' && addressText !== 'x' && addressText !== 'n') {
      return usageError('od', `invalid address base '${addressText}'（支持 d / o / x / n）`)
    }
    const addressBase = addressText
    const typeText = flagText(parsed.flags, 't') ?? 'o2'
    const types = parseOdTypes(typeText)
    if (types === null) {
      return fail(
        `od: 不支持 -t ${typeText}（支持 x1 / o1 / d1 / u1 / c，可加 z，也支持 2 / 4 字节宽度）\n`,
        2
      )
    }
    let skip = 0
    const skipText = flagText(parsed.flags, 'j')
    if (skipText !== null) {
      const value = parseByteCount(skipText)
      if (value === null) {
        return runtimeError('od', `invalid skip value '${skipText}'`)
      }
      skip = value
    }
    let limit: number | null = null
    const limitText = flagText(parsed.flags, 'N')
    if (limitText !== null) {
      const value = parseByteCount(limitText)
      if (value === null) {
        return runtimeError('od', `invalid byte count '${limitText}'`)
      }
      limit = value
    }
    const verbose = flagOn(parsed.flags, 'v')
    const inputs = readAllInputs(ctx, parsed.operands, 'od')
    const start = Math.min(skip, inputs.bytes.byteLength)
    const end =
      limit === null ? inputs.bytes.byteLength : Math.min(inputs.bytes.byteLength, start + limit)
    const body = inputs.bytes.subarray(start, end)
    const lines: string[] = []
    let previous: Uint8Array | null = null
    let folded = false
    for (let offset = 0; offset < body.byteLength; offset += OD_LINE_BYTES) {
      if ((offset & 0xffff) === 0 && interrupted(ctx)) {
        return { code: 130, stdout: lines.join(''), stderr: `${inputs.errors}od: interrupted\n` }
      }
      const block = body.subarray(offset, offset + OD_LINE_BYTES)
      if (!verbose && previous !== null && block.byteLength === 16 && sameBytes(block, previous)) {
        if (!folded) {
          lines.push('*\n')
          folded = true
        }
        continue
      }
      folded = false
      previous = block.byteLength === 16 ? new Uint8Array(block) : null
      // -j 跳过之后地址仍然从文件的绝对位置开始标（GNU od 的行为）
      const address = odOffsetText(start + offset, addressBase)
      // 块内元素按 size 对齐：这里按 16 字节整块切，元素不会跨行
      lines.push(...odBlockLines(types, block, address))
    }
    const tail = odOffsetText(start + body.byteLength, addressBase)
    if (tail !== null) {
      lines.push(`${tail}\n`)
    }
    return { code: inputs.errors ? 1 : 0, stdout: lines.join(''), stderr: inputs.errors }
  },
}

// ---------- 注册表 ----------

export const EXTRAS_TEXT_APPLETS: Applet[] = [
  sha512sumApplet,
  stringsApplet,
  hexdumpApplet,
  xxdApplet,
  columnApplet,
  foldApplet,
  expandApplet,
  unexpandApplet,
  numfmtApplet,
  cmpApplet,
  base32Applet,
  odApplet,
]
