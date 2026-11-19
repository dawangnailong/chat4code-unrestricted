import type { Applet, AppletContext, AppletResult } from '../types.js'
import { ERRNO_TEXT, VmError } from '../types.js'
import { interrupted, readInputBytes } from './helpers.js'

/**
 * jq 子集：JSON 过滤、格式化与字段提取。
 *
 * 浏览器里没有真正的 jq 二进制，这里用 TypeScript 手写一个小实现：
 * tokenizer + Pratt 解析器 + 流式求值器，值模型直接复用 JS 的 JSON 类型。
 * 覆盖日常最常用的路径访问、管道、变量、对象/数组构造与标准函数，
 * 不支持的语法（reduce / foreach / 带参数的 def / 赋值运算符）会明确报错退出 3，
 * 而不是给出看起来对的错结果。
 *
 * 语义上尽量贴近 jq 1.7：`null | .foo` 得到 null、类型不匹配才报错；
 * 退出码沿用本 VM 的约定（未知选项 2、语法错误 3、输入 JSON 非法 4、运行期错误 5、中断 130）。
 */

/** jq 的值模型：与 JSON 的六种类型一一对应（数字统一为 number） */
export type JqValue = null | boolean | number | string | JqValue[] | JqObject

/** jq 对象：字符串键到 jq 值 */
export type JqObject = { [key: string]: JqValue }

// ---------- 错误类型 ----------

/** 过滤器语法错误（退出码 3） */
class JqSyntaxError extends Error {
  readonly position: number

  constructor(message: string, position: number) {
    super(message)
    this.name = 'JqSyntaxError'
    this.position = position
  }
}

/** 过滤器中引用了不存在的函数（jq 里属于编译错误，退出码 3） */
class JqCompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JqCompileError'
  }
}

/** 运行期错误（退出码 5），能被 try / ? 捕获 */
class JqRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JqRuntimeError'
  }
}

/** 输入不是合法 JSON（退出码 4） */
class JqInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JqInputError'
  }
}

/** 被 Ctrl+C / 超时打断（退出码 130） */
class JqAbortError extends Error {
  constructor() {
    super('aborted')
    this.name = 'JqAbortError'
  }
}

// ---------- 值工具 ----------

/** 建一个不带原型的对象：避免 `__proto__` 之类键污染原型链 */
const makeObject = (entries?: Iterable<[string, JqValue]>): JqObject => {
  const out = Object.create(null) as JqObject
  if (entries) {
    for (const [key, value] of entries) {
      out[key] = value
    }
  }
  return out
}

/** 是否是 jq 对象（不是数组、不是 null） */
const isObject = (value: JqValue): value is JqObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 类型名，用于 type 函数与错误文案 */
const typeName = (value: JqValue): string => {
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'boolean') {
    return 'boolean'
  }
  if (typeof value === 'number') {
    return 'number'
  }
  if (typeof value === 'string') {
    return 'string'
  }
  return Array.isArray(value) ? 'array' : 'object'
}

/** jq 的真假：只有 false 与 null 是假 */
const isTruthy = (value: JqValue): boolean => value !== false && value !== null

/** 数字转 JSON 文本；jq 不加多余的 0，1e21 写成 1e+21 */
const formatNumber = (value: number): string => {
  if (Number.isNaN(value)) {
    return 'null'
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? '1.7976931348623157e+308' : '-1.7976931348623157e+308'
  }
  if (Object.is(value, -0)) {
    return '-0'
  }
  return String(value)
}

/** 字符串转 JSON 文本：只转义必须转义的字符，非 ASCII 原样保留 */
const escapeString = (value: string): string => {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '"') {
      out += '\\"'
    } else if (char === '\\') {
      out += '\\\\'
    } else if (char === '\b') {
      out += '\\b'
    } else if (char === '\f') {
      out += '\\f'
    } else if (char === '\n') {
      out += '\\n'
    } else if (char === '\r') {
      out += '\\r'
    } else if (char === '\t') {
      out += '\\t'
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else {
      out += char
    }
  }
  return `"${out}"`
}

/** 按 jq 的风格打印一个值；sortKeys 递归排序对象键，compact 输出紧凑格式 */
const formatValue = (
  value: JqValue,
  compact: boolean,
  sortKeys: boolean,
  indent: string
): string => {
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'number') {
    return formatNumber(value)
  }
  if (typeof value === 'string') {
    return escapeString(value)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]'
    }
    if (compact) {
      return `[${value.map((item) => formatValue(item, true, sortKeys, '')).join(',')}]`
    }
    const inner = `${indent}  `
    const body = value.map((item) => `${inner}${formatValue(item, false, sortKeys, inner)}`)
    return `[\n${body.join(',\n')}\n${indent}]`
  }
  const keys = sortKeys ? Object.keys(value).sort() : Object.keys(value)
  if (keys.length === 0) {
    return '{}'
  }
  if (compact) {
    const body = keys.map(
      (key) => `${escapeString(key)}:${formatValue(value[key], true, sortKeys, '')}`
    )
    return `{${body.join(',')}}`
  }
  const inner = `${indent}  `
  const body = keys.map(
    (key) => `${inner}${escapeString(key)}: ${formatValue(value[key], false, sortKeys, inner)}`
  )
  return `{\n${body.join(',\n')}\n${indent}}`
}

/** 紧凑 JSON 文本（tostring / tojson / 字符串插值用） */
const toText = (value: JqValue): string => formatValue(value, true, false, '')

/** jq 错误文案里的值描述：number (1)、string ("a") */
const describeValue = (value: JqValue): string => {
  const text = toText(value)
  const clipped = text.length > 40 ? `${text.slice(0, 37)}...` : text
  return `${typeName(value)} (${clipped})`
}

/** 抛出运行期错误 */
const raise = (message: string): never => {
  throw new JqRuntimeError(message)
}

/** 值比较：null < false < true < number < string < array < object */
const typeRank = (value: JqValue): number => {
  if (value === null) {
    return 0
  }
  if (value === false) {
    return 1
  }
  if (value === true) {
    return 2
  }
  if (typeof value === 'number') {
    return 3
  }
  if (typeof value === 'string') {
    return 4
  }
  return Array.isArray(value) ? 5 : 6
}

/** 比较两个值，返回负数 / 0 / 正数 */
const compareValues = (left: JqValue, right: JqValue): number => {
  if (left === right) {
    return 0
  }
  const leftRank = typeRank(left)
  const rightRank = typeRank(right)
  if (leftRank !== rightRank) {
    return leftRank - rightRank
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : 1
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const size = Math.min(left.length, right.length)
    for (let index = 0; index < size; index += 1) {
      const result = compareValues(left[index], right[index])
      if (result !== 0) {
        return result
      }
    }
    return left.length - right.length
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    const keyResult = compareValues(leftKeys, rightKeys)
    if (keyResult !== 0) {
      return keyResult
    }
    for (const key of leftKeys) {
      const result = compareValues(left[key], right[key])
      if (result !== 0) {
        return result
      }
    }
    return 0
  }
  return 0
}

/** 深度相等（== 与 unique / index 系列用） */
const deepEqual = (left: JqValue, right: JqValue): boolean => compareValues(left, right) === 0

/** 按 jq 规则排序一个数组 */
const sortValues = (values: JqValue[]): JqValue[] => [...values].sort(compareValues)

// ---------- JSON 输入解析 ----------

const DECODER = new TextDecoder()

/** 文本里的行列号（用于输入解析错误的提示） */
const jsonPosition = (text: string, index: number): { line: number; column: number } => {
  const before = text.slice(0, index)
  const line = before.split('\n').length
  const column = index - before.lastIndexOf('\n')
  return { line, column }
}

/**
 * 解析一个 JSON 流（jq 允许一次输入里连续放多个 JSON 值）。
 * 只接受标准 JSON；空输入或纯空白返回空数组。
 */
const parseJsonStream = (text: string): JqValue[] => {
  let pos = 0
  const values: JqValue[] = []

  const fail = (message: string): never => {
    const where = jsonPosition(text, pos)
    throw new JqInputError(`${message} at line ${where.line}, column ${where.column}`)
  }

  const skipSpace = (): void => {
    while (pos < text.length && /[ \t\r\n]/.test(text[pos])) {
      pos += 1
    }
  }

  const parseString = (): string => {
    pos += 1
    let out = ''
    for (;;) {
      const char = text[pos]
      if (char === undefined) {
        fail('Unterminated string')
      }
      if (char === '"') {
        pos += 1
        return out
      }
      if (char === '\\') {
        pos += 1
        const escape = text[pos]
        if (escape === undefined) {
          fail('Unterminated string')
        }
        pos += 1
        if (escape === 'u') {
          const hex = text.slice(pos, pos + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            fail('Invalid unicode escape')
          }
          out += String.fromCharCode(Number.parseInt(hex, 16))
          pos += 4
        } else if (escape === 'n') {
          out += '\n'
        } else if (escape === 't') {
          out += '\t'
        } else if (escape === 'r') {
          out += '\r'
        } else if (escape === 'b') {
          out += '\b'
        } else if (escape === 'f') {
          out += '\f'
        } else {
          out += escape
        }
        continue
      }
      out += char
      pos += 1
    }
  }

  const parseObjectValue = (): JqValue => {
    pos += 1
    const out = makeObject()
    skipSpace()
    if (text[pos] === '}') {
      pos += 1
      return out
    }
    for (;;) {
      skipSpace()
      if (text[pos] !== '"') {
        return fail('Object keys must be strings')
      }
      const key = parseString()
      skipSpace()
      if (text[pos] !== ':') {
        return fail(`Expected ':' after object key`)
      }
      pos += 1
      out[key] = parseValue()
      skipSpace()
      if (text[pos] === ',') {
        pos += 1
        continue
      }
      if (text[pos] === '}') {
        pos += 1
        return out
      }
      return fail(`Expected ',' or '}' in object`)
    }
  }

  const parseArrayValue = (): JqValue => {
    pos += 1
    const out: JqValue[] = []
    skipSpace()
    if (text[pos] === ']') {
      pos += 1
      return out
    }
    for (;;) {
      out.push(parseValue())
      skipSpace()
      if (text[pos] === ',') {
        pos += 1
        continue
      }
      if (text[pos] === ']') {
        pos += 1
        return out
      }
      return fail(`Expected ',' or ']' in array`)
    }
  }

  const parseValue = (): JqValue => {
    skipSpace()
    const char = text[pos]
    if (char === undefined) {
      return fail('Unexpected end of JSON input')
    }
    if (char === '{') {
      return parseObjectValue()
    }
    if (char === '[') {
      return parseArrayValue()
    }
    if (char === '"') {
      return parseString()
    }
    if (text.startsWith('true', pos)) {
      pos += 4
      return true
    }
    if (text.startsWith('false', pos)) {
      pos += 5
      return false
    }
    if (text.startsWith('null', pos)) {
      pos += 4
      return null
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(pos))
    if (match) {
      pos += match[0].length
      return Number(match[0])
    }
    return fail(`Invalid JSON text: unexpected '${char}'`)
  }

  skipSpace()
  while (pos < text.length) {
    values.push(parseValue())
    skipSpace()
  }
  return values
}

// ---------- 词法分析 ----------

/** 字符串字面量的一段：普通文本，或 `\(...)` 插值里的过滤器源码 */
type StringPart = { kind: 'text'; text: string } | { kind: 'interp'; source: string }

type Token =
  | { kind: 'eof'; pos: number }
  | { kind: 'op'; text: string; pos: number }
  | { kind: 'ident'; text: string; pos: number }
  | { kind: 'var'; text: string; pos: number }
  | { kind: 'number'; text: string; value: number; pos: number }
  | { kind: 'string'; parts: StringPart[]; pos: number }

/** 多字符运算符，按长度优先匹配 */
const OPERATORS = [
  '==',
  '!=',
  '<=',
  '>=',
  '//',
  '|',
  ',',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ':',
  ';',
  '?',
  '.',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
] as const

/** 简单转义表 */
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

/** 词法分析：失败抛 JqSyntaxError */
const tokenize = (source: string): Token[] => {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1
      continue
    }
    // jq 允许用 # 写注释
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') {
        index += 1
      }
      continue
    }
    if (char === '"') {
      const start = index
      index += 1
      let buffer = ''
      const parts: StringPart[] = []
      for (;;) {
        const current = source[index]
        if (current === undefined) {
          throw new JqSyntaxError('unterminated string literal', start)
        }
        if (current === '"') {
          index += 1
          break
        }
        if (current !== '\\') {
          buffer += current
          index += 1
          continue
        }
        const next = source[index + 1]
        if (next === undefined) {
          throw new JqSyntaxError('unterminated string literal', start)
        }
        if (next === '(') {
          if (buffer !== '') {
            parts.push({ kind: 'text', text: buffer })
            buffer = ''
          }
          let depth = 1
          let cursor = index + 2
          const bodyStart = cursor
          while (cursor < source.length && depth > 0) {
            const inner = source[cursor]
            if (inner === '"') {
              cursor += 1
              while (cursor < source.length && source[cursor] !== '"') {
                cursor += source[cursor] === '\\' ? 2 : 1
              }
              cursor += 1
              continue
            }
            if (inner === '(') {
              depth += 1
            } else if (inner === ')') {
              depth -= 1
              if (depth === 0) {
                break
              }
            }
            cursor += 1
          }
          if (depth !== 0) {
            throw new JqSyntaxError('unterminated string interpolation', start)
          }
          parts.push({ kind: 'interp', source: source.slice(bodyStart, cursor) })
          index = cursor + 1
          continue
        }
        if (next === 'u') {
          const hex = source.slice(index + 2, index + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new JqSyntaxError('invalid unicode escape', index)
          }
          buffer += String.fromCharCode(Number.parseInt(hex, 16))
          index += 6
          continue
        }
        buffer += SIMPLE_ESCAPES[next] ?? next
        index += 2
      }
      if (buffer !== '') {
        parts.push({ kind: 'text', text: buffer })
      }
      tokens.push({ kind: 'string', parts, pos: start })
      continue
    }
    if (char === '$') {
      let cursor = index + 1
      while (cursor < source.length && /[A-Za-z0-9_]/.test(source[cursor])) {
        cursor += 1
      }
      if (cursor === index + 1) {
        throw new JqSyntaxError('expected a variable name after $', index)
      }
      tokens.push({ kind: 'var', text: source.slice(index + 1, cursor), pos: index })
      index = cursor
      continue
    }
    if (char === '.' && source[index + 1] === '.') {
      throw new JqSyntaxError('不支持 .. 运算符，请用 recurse', index)
    }
    if (char >= '0' && char <= '9') {
      const match = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index))
      if (!match) {
        throw new JqSyntaxError('invalid number literal', index)
      }
      tokens.push({ kind: 'number', text: match[0], value: Number(match[0]), pos: index })
      index += match[0].length
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      let cursor = index + 1
      while (cursor < source.length && /[A-Za-z0-9_]/.test(source[cursor])) {
        cursor += 1
      }
      tokens.push({ kind: 'ident', text: source.slice(index, cursor), pos: index })
      index = cursor
      continue
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index))
    if (operator) {
      tokens.push({ kind: 'op', text: operator, pos: index })
      index += operator.length
      continue
    }
    throw new JqSyntaxError(`unexpected character '${char}'`, index)
  }
  tokens.push({ kind: 'eof', pos: source.length })
  return tokens
}

// ---------- 语法树 ----------

type Ast =
  | { kind: 'identity' }
  | { kind: 'literal'; value: JqValue }
  | { kind: 'string'; parts: StringAstPart[] }
  | { kind: 'variable'; name: string }
  | { kind: 'field'; target: Ast; name: string }
  | { kind: 'index'; target: Ast; key: Ast }
  | { kind: 'slice'; target: Ast; start: Ast | null; end: Ast | null }
  | { kind: 'iterate'; target: Ast }
  | { kind: 'optional'; body: Ast }
  | { kind: 'pipe'; left: Ast; right: Ast }
  | { kind: 'comma'; left: Ast; right: Ast }
  | { kind: 'alternative'; left: Ast; right: Ast }
  | { kind: 'binary'; operator: BinaryOperator; left: Ast; right: Ast }
  | { kind: 'unary'; operator: '-'; body: Ast }
  | { kind: 'bind'; source: Ast; name: string; body: Ast }
  | { kind: 'if'; branches: Array<{ condition: Ast; branch: Ast }>; elseBranch: Ast | null }
  | { kind: 'try'; body: Ast; handler: Ast | null }
  | { kind: 'call'; name: string; args: Ast[] }
  | { kind: 'array'; body: Ast | null }
  | { kind: 'object'; entries: Array<{ key: Ast; value: Ast }> }

type StringAstPart = { kind: 'text'; text: string } | { kind: 'expr'; ast: Ast }

type BinaryOperator =
  | 'and'
  | 'or'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'

/** 用户自定义函数（只支持无参数版本） */
type UserFunction = { params: string[]; body: Ast }

/** 一个编译好的过滤器：定义 + 表达式 */
type Program = { functions: Map<string, UserFunction>; body: Ast }

// ---------- 语法分析 ----------

type ParserState = { tokens: Token[]; index: number }

/** 运算符优先级，数字越大结合越紧（jq：| < , < // < or < and < 比较 < 加减 < 乘除） */
const PRECEDENCE = {
  pipe: 1,
  comma: 2,
  alternative: 3,
  or: 4,
  and: 5,
  compare: 6,
  additive: 7,
  multiplicative: 8,
} as const

const tokenAt = (state: ParserState): Token => state.tokens[state.index]

const advance = (state: ParserState): Token => {
  const token = tokenAt(state)
  if (token.kind !== 'eof') {
    state.index += 1
  }
  return token
}

/** 错误的可读令牌描述 */
const describeToken = (token: Token): string => {
  switch (token.kind) {
    case 'eof':
      return 'end of filter'
    case 'op':
      return `'${token.text}'`
    case 'ident':
      return `'${token.text}'`
    case 'var':
      return `'$${token.text}'`
    case 'number':
      return `number ${token.text}`
    case 'string':
      return 'string literal'
  }
}

const syntaxError = (state: ParserState, message: string): never => {
  throw new JqSyntaxError(message, tokenAt(state).pos)
}

const expectOp = (state: ParserState, text: string): void => {
  const token = tokenAt(state)
  if (token.kind === 'op' && token.text === text) {
    advance(state)
    return
  }
  syntaxError(state, `syntax error: expected '${text}' but found ${describeToken(token)}`)
}

const expectIdent = (state: ParserState, text: string): void => {
  const token = tokenAt(state)
  if (token.kind === 'ident' && token.text === text) {
    advance(state)
    return
  }
  syntaxError(state, `syntax error: expected '${text}' but found ${describeToken(token)}`)
}

/** 二元运算符的优先级；不是运算符返回 null */
const binaryPrecedence = (token: Token): number | null => {
  if (token.kind === 'op') {
    switch (token.text) {
      case '|':
        return PRECEDENCE.pipe
      case ',':
        return PRECEDENCE.comma
      case '//':
        return PRECEDENCE.alternative
      case '==':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
        return PRECEDENCE.compare
      case '+':
      case '-':
        return PRECEDENCE.additive
      case '*':
      case '/':
      case '%':
        return PRECEDENCE.multiplicative
      default:
        return null
    }
  }
  if (token.kind === 'ident') {
    if (token.text === 'or') {
      return PRECEDENCE.or
    }
    if (token.text === 'and') {
      return PRECEDENCE.and
    }
  }
  return null
}

/** 用运算符文本拼出语法树节点 */
const makeBinary = (operator: string, left: Ast, right: Ast): Ast => {
  if (operator === '|') {
    return { kind: 'pipe', left, right }
  }
  if (operator === ',') {
    return { kind: 'comma', left, right }
  }
  if (operator === '//') {
    return { kind: 'alternative', left, right }
  }
  return { kind: 'binary', operator: operator as BinaryOperator, left, right }
}

const parseExpression = (state: ParserState, minPrecedence: number, stopAtComma = false): Ast => {
  let left = parseUnary(state)
  for (;;) {
    const token = tokenAt(state)
    // `expr as $x | ...`：绑定语句在管道这一层结合
    if (token.kind === 'ident' && token.text === 'as') {
      if (minPrecedence > 1) {
        break
      }
      advance(state)
      const nameToken = tokenAt(state)
      if (nameToken.kind !== 'var') {
        return syntaxError(state, `syntax error: expected a variable after 'as'`)
      }
      advance(state)
      expectOp(state, '|')
      const body = parseExpression(state, PRECEDENCE.pipe, false)
      left = { kind: 'bind', source: left, name: nameToken.text, body }
      continue
    }
    const precedence = binaryPrecedence(token)
    if (precedence === null || precedence < minPrecedence) {
      break
    }
    if (stopAtComma && token.kind === 'op' && token.text === ',') {
      break
    }
    const operatorText = token.kind === 'op' || token.kind === 'ident' ? token.text : ''
    advance(state)
    const right = parseExpression(state, precedence + 1, stopAtComma)
    left = makeBinary(operatorText, left, right)
  }
  return left
}

const parseBracket = (state: ParserState, target: Ast): Ast => {
  expectOp(state, '[')
  const token = tokenAt(state)
  if (token.kind === 'op' && token.text === ']') {
    advance(state)
    return { kind: 'iterate', target }
  }
  if (token.kind === 'op' && token.text === ':') {
    advance(state)
    let end: Ast | null = null
    const afterEnd = tokenAt(state)
    if (!(afterEnd.kind === 'op' && afterEnd.text === ']')) {
      end = parseExpression(state, 0)
    }
    expectOp(state, ']')
    return { kind: 'slice', target, start: null, end }
  }
  const first = parseExpression(state, 0)
  const separator = tokenAt(state)
  if (separator.kind === 'op' && separator.text === ':') {
    advance(state)
    let end: Ast | null = null
    const afterEnd = tokenAt(state)
    if (!(afterEnd.kind === 'op' && afterEnd.text === ']')) {
      end = parseExpression(state, 0)
    }
    expectOp(state, ']')
    return { kind: 'slice', target, start: first, end }
  }
  expectOp(state, ']')
  return { kind: 'index', target, key: first }
}

const parsePostfix = (state: ParserState, base: Ast): Ast => {
  let value = base
  for (;;) {
    const token = tokenAt(state)
    if (token.kind === 'op' && token.text === '.') {
      advance(state)
      const next = tokenAt(state)
      if (next.kind === 'ident' && next.pos === token.pos + 1) {
        advance(state)
        value = { kind: 'field', target: value, name: next.text }
        continue
      }
      if (next.kind === 'op' && next.text === '[' && next.pos === token.pos + 1) {
        value = parseBracket(state, value)
        continue
      }
      return syntaxError(state, `syntax error: expected a field name right after '.'`)
    }
    if (token.kind === 'op' && token.text === '[') {
      value = parseBracket(state, value)
      continue
    }
    if (token.kind === 'op' && token.text === '?') {
      advance(state)
      value = { kind: 'optional', body: value }
      continue
    }
    return value
  }
}

const parseStringToken = (token: { parts: StringPart[] }): Ast => {
  const parts: StringAstPart[] = []
  for (const part of token.parts) {
    if (part.kind === 'text') {
      parts.push({ kind: 'text', text: part.text })
    } else {
      parts.push({ kind: 'expr', ast: parseFilterSource(part.source) })
    }
  }
  return { kind: 'string', parts }
}

const parseArrayLiteral = (state: ParserState): Ast => {
  expectOp(state, '[')
  const token = tokenAt(state)
  if (token.kind === 'op' && token.text === ']') {
    advance(state)
    return { kind: 'array', body: null }
  }
  const body = parseExpression(state, 0)
  expectOp(state, ']')
  return { kind: 'array', body }
}

const parseObjectLiteral = (state: ParserState): Ast => {
  expectOp(state, '{')
  const entries: Array<{ key: Ast; value: Ast }> = []
  const closing = tokenAt(state)
  if (closing.kind === 'op' && closing.text === '}') {
    advance(state)
    return { kind: 'object', entries }
  }
  for (;;) {
    const token = tokenAt(state)
    let key: Ast
    let shorthandName: string | null = null
    if (token.kind === 'ident') {
      advance(state)
      key = { kind: 'literal', value: token.text }
      shorthandName = token.text
    } else if (token.kind === 'string') {
      advance(state)
      key = parseStringToken(token)
    } else if (token.kind === 'op' && token.text === '(') {
      advance(state)
      key = parseExpression(state, 0)
      expectOp(state, ')')
    } else {
      return syntaxError(state, `syntax error: unexpected ${describeToken(token)} in object`)
    }
    const afterKey = tokenAt(state)
    let value: Ast
    if (afterKey.kind === 'op' && (afterKey.text === ',' || afterKey.text === '}')) {
      if (shorthandName === null) {
        return syntaxError(state, `syntax error: expected ':' after object key`)
      }
      value = { kind: 'field', target: { kind: 'identity' }, name: shorthandName }
    } else {
      expectOp(state, ':')
      value = parseExpression(state, PRECEDENCE.pipe, true)
    }
    entries.push({ key, value })
    const separator = tokenAt(state)
    if (separator.kind === 'op' && separator.text === ',') {
      advance(state)
      continue
    }
    if (separator.kind === 'op' && separator.text === '}') {
      advance(state)
      return { kind: 'object', entries }
    }
    return syntaxError(state, `syntax error: expected ',' or '}' in object`)
  }
}

const parseIf = (state: ParserState): Ast => {
  expectIdent(state, 'if')
  const branches: Array<{ condition: Ast; branch: Ast }> = []
  const condition = parseExpression(state, 0)
  expectIdent(state, 'then')
  const branch = parseExpression(state, 0)
  branches.push({ condition, branch })
  for (;;) {
    const token = tokenAt(state)
    if (token.kind === 'ident' && token.text === 'elif') {
      advance(state)
      const nextCondition = parseExpression(state, 0)
      expectIdent(state, 'then')
      const nextBranch = parseExpression(state, 0)
      branches.push({ condition: nextCondition, branch: nextBranch })
      continue
    }
    if (token.kind === 'ident' && token.text === 'else') {
      advance(state)
      const elseBranch = parseExpression(state, 0)
      expectIdent(state, 'end')
      return { kind: 'if', branches, elseBranch }
    }
    if (token.kind === 'ident' && token.text === 'end') {
      advance(state)
      return { kind: 'if', branches, elseBranch: null }
    }
    return syntaxError(state, `syntax error: expected 'end' but found ${describeToken(token)}`)
  }
}

const parseTry = (state: ParserState): Ast => {
  expectIdent(state, 'try')
  const body = parseExpression(state, 0)
  const token = tokenAt(state)
  if (token.kind === 'ident' && token.text === 'catch') {
    advance(state)
    const handler = parseExpression(state, 0)
    return { kind: 'try', body, handler }
  }
  return { kind: 'try', body, handler: null }
}

const parseCall = (state: ParserState, name: string): Ast => {
  const token = tokenAt(state)
  if (!(token.kind === 'op' && token.text === '(')) {
    return { kind: 'call', name, args: [] }
  }
  advance(state)
  const args: Ast[] = []
  const closing = tokenAt(state)
  if (closing.kind === 'op' && closing.text === ')') {
    advance(state)
    return { kind: 'call', name, args }
  }
  for (;;) {
    args.push(parseExpression(state, 0))
    const separator = tokenAt(state)
    if (separator.kind === 'op' && separator.text === ';') {
      advance(state)
      continue
    }
    break
  }
  expectOp(state, ')')
  return { kind: 'call', name, args }
}

const parsePrimary = (state: ParserState): Ast => {
  const token = tokenAt(state)
  if (token.kind === 'number') {
    advance(state)
    return { kind: 'literal', value: token.value }
  }
  if (token.kind === 'string') {
    advance(state)
    return parseStringToken(token)
  }
  if (token.kind === 'var') {
    advance(state)
    return { kind: 'variable', name: token.text }
  }
  if (token.kind === 'op') {
    if (token.text === '.') {
      advance(state)
      const next = tokenAt(state)
      if (next.kind === 'ident' && next.pos === token.pos + 1) {
        advance(state)
        return { kind: 'field', target: { kind: 'identity' }, name: next.text }
      }
      if (next.kind === 'op' && next.text === '[' && next.pos === token.pos + 1) {
        return parseBracket(state, { kind: 'identity' })
      }
      return { kind: 'identity' }
    }
    if (token.text === '(') {
      advance(state)
      const inner = parseExpression(state, 0)
      expectOp(state, ')')
      return inner
    }
    if (token.text === '[') {
      return parseArrayLiteral(state)
    }
    if (token.text === '{') {
      return parseObjectLiteral(state)
    }
    return syntaxError(state, `syntax error: unexpected ${describeToken(token)}`)
  }
  if (token.kind === 'ident') {
    if (token.text === 'null' || token.text === 'true' || token.text === 'false') {
      advance(state)
      return { kind: 'literal', value: token.text === 'null' ? null : token.text === 'true' }
    }
    if (token.text === 'if') {
      return parseIf(state)
    }
    if (token.text === 'try') {
      return parseTry(state)
    }
    if (token.text === 'def') {
      return syntaxError(state, '不支持 def：自定义函数只能写在过滤器开头')
    }
    if (token.text === 'reduce' || token.text === 'foreach' || token.text === 'label') {
      return syntaxError(state, `不支持 ${token.text}：NanoVM 的 jq 子集未实现该语法`)
    }
    advance(state)
    return parseCall(state, token.text)
  }
  return syntaxError(state, `syntax error: unexpected ${describeToken(token)}`)
}

const parseUnary = (state: ParserState): Ast => {
  const token = tokenAt(state)
  if (token.kind === 'op' && token.text === '-') {
    advance(state)
    return { kind: 'unary', operator: '-', body: parsePostfix(state, parsePrimary(state)) }
  }
  return parsePostfix(state, parsePrimary(state))
}

/** 编译一个过滤器源码（字符串插值里也走这里） */
const parseFilterSource = (source: string): Ast => {
  const state: ParserState = { tokens: tokenize(source), index: 0 }
  const body = parseExpression(state, 0)
  const trailing = tokenAt(state)
  if (trailing.kind !== 'eof') {
    syntaxError(state, `syntax error: unexpected ${describeToken(trailing)}`)
  }
  return body
}

/** 编译完整过滤器：开头的 def 收集进函数表，其余是主表达式 */
const parseProgram = (source: string): Program => {
  const state: ParserState = { tokens: tokenize(source), index: 0 }
  const functions = new Map<string, UserFunction>()
  for (;;) {
    const token = tokenAt(state)
    if (!(token.kind === 'ident' && token.text === 'def')) {
      break
    }
    advance(state)
    const nameToken = tokenAt(state)
    if (nameToken.kind !== 'ident') {
      return syntaxError(state, `syntax error: expected a function name after 'def'`)
    }
    advance(state)
    const paramsToken = tokenAt(state)
    if (paramsToken.kind === 'op' && paramsToken.text === '(') {
      return syntaxError(state, '不支持带参数的 def：NanoVM 的 jq 子集只支持 `def f: ...;`')
    }
    expectOp(state, ':')
    const body = parseExpression(state, 0)
    expectOp(state, ';')
    functions.set(nameToken.text, { params: [], body })
  }
  const body = parseExpression(state, 0)
  const trailing = tokenAt(state)
  if (trailing.kind !== 'eof') {
    return syntaxError(state, `syntax error: unexpected ${describeToken(trailing)}`)
  }
  return { functions, body }
}

// ---------- 求值 ----------

type EvalContext = {
  applet: AppletContext
  /** 当前输入来源的名字，用于错误文案（at <stdin>:0） */
  label: string
  /** 已求值的节点数，用来周期性检查中断 */
  steps: number
}

type Env = {
  vars: Map<string, JqValue>
  functions: Map<string, UserFunction>
  context: EvalContext
}

/** 每 512 个节点检查一次 Ctrl+C / 超时 */
const tick = (env: Env): void => {
  env.context.steps += 1
  if (env.context.steps % 512 === 0 && interrupted(env.context.applet)) {
    throw new JqAbortError()
  }
}

/** 对象键值访问：对象缺失返回 null，类型不对报错 */
const indexValue = (target: JqValue, key: JqValue): JqValue => {
  if (target === null) {
    return null
  }
  if (typeof key === 'string') {
    if (isObject(target)) {
      return Object.prototype.hasOwnProperty.call(target, key) ? target[key] : null
    }
    return raise(`Cannot index ${typeName(target)} with ${escapeString(key)}`)
  }
  if (typeof key === 'number') {
    if (Array.isArray(target)) {
      if (!Number.isInteger(key)) {
        return raise(`Cannot index array with number ${formatNumber(key)}`)
      }
      const position = key < 0 ? target.length + key : key
      return position >= 0 && position < target.length ? target[position] : null
    }
    return raise(`Cannot index ${typeName(target)} with number`)
  }
  return raise(`Cannot index ${typeName(target)} with ${typeName(key)}`)
}

/** `.[]`：数组逐项、对象逐值，其他类型报错 */
const iterateValue = (target: JqValue): JqValue[] => {
  if (Array.isArray(target)) {
    return target
  }
  if (isObject(target)) {
    return Object.keys(target).map((key) => target[key])
  }
  return raise(`Cannot iterate over ${describeValue(target)}`)
}

/** `.[a:b]`：数组与字符串切片，负数从尾部算 */
const sliceValue = (target: JqValue, start: JqValue, end: JqValue): JqValue => {
  if (target === null) {
    return null
  }
  if (!Array.isArray(target) && typeof target !== 'string') {
    return raise(`Cannot index ${typeName(target)} with object`)
  }
  const items: JqValue[] = typeof target === 'string' ? Array.from(target) : target
  const resolve = (bound: JqValue, fallback: number): number => {
    if (bound === null) {
      return fallback
    }
    if (typeof bound !== 'number' || !Number.isInteger(bound)) {
      return raise(`Array index must be a number`)
    }
    if (bound < 0) {
      return Math.max(items.length + bound, 0)
    }
    return Math.min(bound, items.length)
  }
  const from = resolve(start, 0)
  const to = resolve(end, items.length)
  const sliced = from <= to ? items.slice(from, to) : []
  return typeof target === 'string' ? sliced.join('') : sliced
}

/** 加法：数字、字符串、数组、对象、null 各有规则 */
const addValues = (left: JqValue, right: JqValue): JqValue => {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left + right
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left + right
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return [...left, ...right]
  }
  if (isObject(left) && isObject(right)) {
    const out = makeObject()
    for (const key of Object.keys(left)) {
      out[key] = left[key]
    }
    for (const key of Object.keys(right)) {
      out[key] = right[key]
    }
    return out
  }
  return raise(`${describeValue(left)} and ${describeValue(right)} cannot be added`)
}

/** 对象深合并（`*` 用） */
const mergeObjects = (left: JqObject, right: JqObject): JqObject => {
  const out = makeObject()
  for (const key of Object.keys(left)) {
    out[key] = left[key]
  }
  for (const key of Object.keys(right)) {
    const existing = out[key]
    const incoming = right[key]
    out[key] =
      isObject(existing) && isObject(incoming) ? mergeObjects(existing, incoming) : incoming
  }
  return out
}

/** 乘法：数字、字符串重复、对象深合并 */
const multiplyValues = (left: JqValue, right: JqValue): JqValue => {
  if (typeof left === 'number' && typeof right === 'number') {
    return left * right
  }
  if (typeof left === 'string' && typeof right === 'number') {
    return right <= 0 ? '' : left.repeat(Math.floor(right))
  }
  if (isObject(left) && isObject(right)) {
    return mergeObjects(left, right)
  }
  return raise(`${describeValue(left)} and ${describeValue(right)} cannot be multiplied`)
}

/** 减法：数字相减，数组做差集 */
const subtractValues = (left: JqValue, right: JqValue): JqValue => {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.filter(
      (item) => !right.some((candidate) => deepEqual(item, candidate))
    ) as JqValue[]
  }
  return raise(`${describeValue(left)} and ${describeValue(right)} cannot be subtracted`)
}

/** 除法：数字相除（除数为 0 报错），字符串按分隔符切分 */
const divideValues = (left: JqValue, right: JqValue): JqValue => {
  if (typeof left === 'number' && typeof right === 'number') {
    if (right === 0) {
      return raise(
        `number (${formatNumber(left)}) and number (0) cannot be divided because the divisor is zero`
      )
    }
    return left / right
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left.split(right)
  }
  return raise(`${describeValue(left)} and ${describeValue(right)} cannot be divided`)
}

/** 取模：除数为 0 报错 */
const modValues = (left: JqValue, right: JqValue): JqValue => {
  if (typeof left === 'number' && typeof right === 'number') {
    if (right === 0) {
      return raise(
        `number (${formatNumber(left)}) and number (0) cannot be divided (remainder) because the divisor is zero`
      )
    }
    return left % right
  }
  return raise(`${describeValue(left)} and ${describeValue(right)} cannot be divided`)
}

/** 字符串插值求值 */
const evalString = (parts: StringAstPart[], input: JqValue, env: Env): JqValue[] => {
  let builders: string[] = ['']
  for (const part of parts) {
    if (part.kind === 'text') {
      const text = part.text
      builders = builders.map((prefix) => prefix + text)
      continue
    }
    const values = evalAst(part.ast, input, env)
    const next: string[] = []
    for (const prefix of builders) {
      for (const value of values) {
        next.push(prefix + (typeof value === 'string' ? value : toText(value)))
      }
    }
    builders = next
  }
  return builders
}

/** if / elif / else 求值：条件按结果流逐个分支 */
const evalIf = (
  branches: Array<{ condition: Ast; branch: Ast }>,
  index: number,
  elseBranch: Ast | null,
  input: JqValue,
  env: Env
): JqValue[] => {
  if (index >= branches.length) {
    return elseBranch === null ? [input] : evalAst(elseBranch, input, env)
  }
  const out: JqValue[] = []
  for (const condition of evalAst(branches[index].condition, input, env)) {
    if (isTruthy(condition)) {
      out.push(...evalAst(branches[index].branch, input, env))
    } else {
      out.push(...evalIf(branches, index + 1, elseBranch, input, env))
    }
  }
  return out
}

/** 二元运算：两侧各自按同一个输入求值，再做笛卡尔积 */
const evalBinary = (ast: Extract<Ast, { kind: 'binary' }>, input: JqValue, env: Env): JqValue[] => {
  const out: JqValue[] = []
  for (const left of evalAst(ast.left, input, env)) {
    for (const right of evalAst(ast.right, input, env)) {
      switch (ast.operator) {
        case 'and':
          out.push(isTruthy(left) && isTruthy(right))
          break
        case 'or':
          out.push(isTruthy(left) || isTruthy(right))
          break
        case '==':
          out.push(compareValues(left, right) === 0)
          break
        case '!=':
          out.push(compareValues(left, right) !== 0)
          break
        case '<':
          out.push(compareValues(left, right) < 0)
          break
        case '<=':
          out.push(compareValues(left, right) <= 0)
          break
        case '>':
          out.push(compareValues(left, right) > 0)
          break
        case '>=':
          out.push(compareValues(left, right) >= 0)
          break
        case '+':
          out.push(addValues(left, right))
          break
        case '-':
          out.push(subtractValues(left, right))
          break
        case '*':
          out.push(multiplyValues(left, right))
          break
        case '/':
          out.push(divideValues(left, right))
          break
        case '%':
          out.push(modValues(left, right))
          break
      }
    }
  }
  return out
}

/** 对象构造：键与值的结果流做笛卡尔积 */
const evalObject = (
  entries: Array<{ key: Ast; value: Ast }>,
  input: JqValue,
  env: Env
): JqValue[] => {
  let builders: JqObject[] = [makeObject()]
  for (const entry of entries) {
    const keys = evalAst(entry.key, input, env)
    const values = evalAst(entry.value, input, env)
    const next: JqObject[] = []
    for (const builder of builders) {
      for (const key of keys) {
        if (typeof key !== 'string' && typeof key !== 'number') {
          return raise(`Cannot use ${describeValue(key)} as object key`)
        }
        for (const value of values) {
          const clone = makeObject(Object.keys(builder).map((name) => [name, builder[name]]))
          clone[String(key)] = value
          next.push(clone)
        }
      }
    }
    builders = next
  }
  return builders
}

/** 函数调用：先查用户定义，再查内置函数表 */
const evalCall = (ast: Extract<Ast, { kind: 'call' }>, input: JqValue, env: Env): JqValue[] => {
  const user = env.functions.get(ast.name)
  if (user) {
    if (user.params.length !== ast.args.length) {
      throw new JqCompileError(`${ast.name}/${ast.args.length} is not defined`)
    }
    return evalAst(user.body, input, env)
  }
  const candidates = BUILTINS.get(ast.name)
  const builtin = candidates?.find((candidate) => candidate.arity === ast.args.length)
  if (!builtin) {
    throw new JqCompileError(`${ast.name}/${ast.args.length} is not defined`)
  }
  return builtin.run({ context: env.context, env, input, args: ast.args })
}

/** 主求值器：表达式 + 输入 → 结果流 */
const evalAst = (ast: Ast, input: JqValue, env: Env): JqValue[] => {
  tick(env)
  switch (ast.kind) {
    case 'identity':
      return [input]
    case 'literal':
      return [ast.value]
    case 'string':
      return evalString(ast.parts, input, env)
    case 'variable': {
      const value = env.vars.get(ast.name)
      if (value === undefined) {
        throw new JqCompileError(`$${ast.name} is not defined`)
      }
      return [value]
    }
    case 'field':
      return evalAst(ast.target, input, env).map((target) => indexValue(target, ast.name))
    case 'index': {
      const out: JqValue[] = []
      for (const target of evalAst(ast.target, input, env)) {
        for (const key of evalAst(ast.key, input, env)) {
          out.push(indexValue(target, key))
        }
      }
      return out
    }
    case 'slice': {
      const out: JqValue[] = []
      for (const target of evalAst(ast.target, input, env)) {
        const starts = ast.start === null ? [null] : evalAst(ast.start, input, env)
        const ends = ast.end === null ? [null] : evalAst(ast.end, input, env)
        for (const start of starts) {
          for (const end of ends) {
            out.push(sliceValue(target, start, end))
          }
        }
      }
      return out
    }
    case 'iterate': {
      const out: JqValue[] = []
      for (const target of evalAst(ast.target, input, env)) {
        out.push(...iterateValue(target))
      }
      return out
    }
    case 'optional': {
      try {
        return evalAst(ast.body, input, env)
      } catch (error) {
        if (error instanceof JqRuntimeError) {
          return []
        }
        throw error
      }
    }
    case 'pipe': {
      const out: JqValue[] = []
      for (const value of evalAst(ast.left, input, env)) {
        out.push(...evalAst(ast.right, value, env))
      }
      return out
    }
    case 'comma':
      return [...evalAst(ast.left, input, env), ...evalAst(ast.right, input, env)]
    case 'alternative': {
      const left = evalAst(ast.left, input, env).filter((value) => isTruthy(value))
      return left.length > 0 ? left : evalAst(ast.right, input, env)
    }
    case 'binary':
      return evalBinary(ast, input, env)
    case 'unary':
      return evalAst(ast.body, input, env).map((value) => {
        if (typeof value !== 'number') {
          return raise(`${describeValue(value)} cannot be negated`)
        }
        return -value
      })
    case 'bind': {
      const out: JqValue[] = []
      for (const value of evalAst(ast.source, input, env)) {
        const scope: Env = { ...env, vars: new Map(env.vars).set(ast.name, value) }
        out.push(...evalAst(ast.body, input, scope))
      }
      return out
    }
    case 'if':
      return evalIf(ast.branches, 0, ast.elseBranch, input, env)
    case 'try': {
      try {
        return evalAst(ast.body, input, env)
      } catch (error) {
        if (!(error instanceof JqRuntimeError)) {
          throw error
        }
        return ast.handler === null ? [] : evalAst(ast.handler, error.message, env)
      }
    }
    case 'call':
      return evalCall(ast, input, env)
    case 'array':
      return ast.body === null ? [[]] : [evalAst(ast.body, input, env)]
    case 'object':
      return evalObject(ast.entries, input, env)
  }
}

// ---------- 内置函数 ----------

type BuiltinCall = { context: EvalContext; env: Env; input: JqValue; args: Ast[] }

type Builtin = { arity: number; run: (call: BuiltinCall) => JqValue[] }

const BUILTINS = new Map<string, Builtin[]>()

const define = (name: string, arity: number, run: Builtin['run']): void => {
  const list = BUILTINS.get(name) ?? []
  list.push({ arity, run })
  BUILTINS.set(name, list)
}

/** 对输入跑一个参数过滤器，结果按原样返回 */
const argValues = (call: BuiltinCall): JqValue[] =>
  call.args.length > 0 ? evalAst(call.args[0], call.input, call.env) : []

/** 参数过滤器的第一个结果，没有则 null */
const argValue = (call: BuiltinCall): JqValue => {
  const values = argValues(call)
  return values.length > 0 ? values[0] : null
}

/** 参数必须是字符串 */
const argText = (call: BuiltinCall): string => {
  const value = argValue(call)
  if (typeof value !== 'string') {
    return raise(`${describeValue(value)} is not a string`)
  }
  return value
}

/** 第 index 个参数必须是字符串 */
const argTextAt = (call: BuiltinCall, index: number): string => {
  const values = evalAst(call.args[index], call.input, call.env)
  const value = values.length > 0 ? values[0] : null
  if (typeof value !== 'string') {
    return raise(`${describeValue(value)} is not a string`)
  }
  return value
}

/** 输入必须是数字 */
const numberInput = (input: JqValue, action: string): number => {
  if (typeof input !== 'number') {
    return raise(`${describeValue(input)} cannot be ${action}`)
  }
  return input
}

/** 输入必须是数组 */
const arrayInput = (input: JqValue): JqValue[] => {
  if (!Array.isArray(input)) {
    return raise(`Cannot iterate over ${describeValue(input)}`)
  }
  return input
}

/** 输入必须是字符串 */
const stringInput = (input: JqValue): string => {
  if (typeof input !== 'string') {
    return raise(`${describeValue(input)} is not a string`)
  }
  return input
}

/** 对数组每个元素跑一次过滤器，取第一个结果作为排序键 */
const keyedValues = (
  values: JqValue[],
  filter: Ast,
  env: Env
): Array<{ key: JqValue; value: JqValue }> =>
  values.map((value) => {
    const results = evalAst(filter, value, env)
    return { key: results.length > 0 ? results[0] : null, value }
  })

/** 稳定排序：键相同保留原顺序 */
const sortKeyed = (
  pairs: Array<{ key: JqValue; value: JqValue }>
): Array<{ key: JqValue; value: JqValue }> => {
  return pairs
    .map((pair, order) => ({ pair, order }))
    .sort((left, right) => {
      const result = compareValues(left.pair.key, right.pair.key)
      return result !== 0 ? result : left.order - right.order
    })
    .map((entry) => entry.pair)
}

/** to_entries 的实现：对象 → [{key, value}] */
const toEntries = (input: JqValue): JqValue[] => {
  if (!isObject(input)) {
    return raise(`Cannot use to_entries on ${typeName(input)}`)
  }
  return [
    Object.keys(input).map((key) =>
      makeObject([
        ['key', key],
        ['value', input[key]],
      ])
    ),
  ]
}

/** from_entries：接受 key / Key / name / Name 与 value / Value */
const fromEntries = (input: JqValue): JqValue => {
  if (!Array.isArray(input)) {
    return raise(`Cannot use from_entries on ${typeName(input)}`)
  }
  const out = makeObject()
  for (const item of input) {
    if (!isObject(item)) {
      return raise(`Cannot use from_entries on ${typeName(item)}`)
    }
    const key = item.key ?? item.Key ?? item.name ?? item.Name
    const value = 'value' in item ? item.value : item.Value
    if (typeof key !== 'string' && typeof key !== 'number') {
      return raise('Cannot use from_entries: entry has no key')
    }
    out[String(key)] = value ?? null
  }
  return out
}

/** 深度包含判断（contains） */
const containsValue = (haystack: JqValue, needle: JqValue): boolean => {
  if (Array.isArray(needle)) {
    if (!Array.isArray(haystack)) {
      return false
    }
    return needle.every((item) => haystack.some((candidate) => containsValue(candidate, item)))
  }
  if (isObject(needle)) {
    if (!isObject(haystack)) {
      return false
    }
    return Object.keys(needle).every(
      (key) =>
        Object.prototype.hasOwnProperty.call(haystack, key) &&
        containsValue(haystack[key], needle[key])
    )
  }
  if (typeof needle === 'string' && typeof haystack === 'string') {
    return haystack.includes(needle)
  }
  return deepEqual(haystack, needle)
}

/** 路径收集：paths（含中间节点）与 leaf_paths（只要叶子） */
const collectPaths = (
  value: JqValue,
  prefix: JqValue[],
  out: JqValue[],
  leavesOnly: boolean
): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const path: JqValue[] = [...prefix, index]
      const leaf = !Array.isArray(item) && !isObject(item)
      if (!leavesOnly || leaf) {
        out.push(path)
      }
      collectPaths(item, path, out, leavesOnly)
    })
    return
  }
  if (isObject(value)) {
    for (const key of Object.keys(value)) {
      const item = value[key]
      const path: JqValue[] = [...prefix, key]
      const leaf = !Array.isArray(item) && !isObject(item)
      if (!leavesOnly || leaf) {
        out.push(path)
      }
      collectPaths(item, path, out, leavesOnly)
    }
  }
}

/** recurse：先自己，再所有后代 */
const collectRecurse = (value: JqValue, out: JqValue[]): void => {
  out.push(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRecurse(item, out)
    }
    return
  }
  if (isObject(value)) {
    for (const key of Object.keys(value)) {
      collectRecurse(value[key], out)
    }
  }
}

/** 正则：剥离开头内联标志 (?i)(?g)，合并 flags */
const compileRegex = (pattern: string, flags: string): RegExp => {
  let source = pattern
  let effective = flags
  for (;;) {
    const inline = /^\(\?([A-Za-z]+)\)/.exec(source)
    if (!inline) {
      break
    }
    effective += inline[1]
    source = source.slice(inline[0].length)
  }
  let normalized = ''
  for (const letter of 'gims') {
    if (effective.includes(letter) && !normalized.includes(letter)) {
      normalized += letter
    }
  }
  try {
    return new RegExp(source, normalized)
  } catch {
    return raise(`Invalid regular expression: ${pattern}`)
  }
}

/** 正则里命名捕获组的名字（按出现顺序） */
const captureNames = (pattern: string): string[] => {
  const names: string[] = []
  const matcher = /\?<([A-Za-z_][A-Za-z0-9_]*)>/g
  let match = matcher.exec(pattern)
  while (match) {
    names.push(match[1])
    match = matcher.exec(pattern)
  }
  return names
}

/** UTF-16 下标 → 码点下标（jq 的 offset 按码点算） */
const codepointIndex = (text: string, index: number): number =>
  index <= 0 ? 0 : Array.from(text.slice(0, index)).length

/** 一次匹配转成 jq 的 match 对象 */
const matchToValue = (text: string, match: RegExpExecArray, names: string[]): JqValue => {
  const captures: JqValue[] = []
  for (let group = 1; group < match.length; group += 1) {
    const groupText = match[group]
    captures.push(
      makeObject([
        [
          'offset',
          groupText === undefined
            ? -1
            : codepointIndex(text, match.index + matchedOffset(text, match, group)),
        ],
        ['length', groupText === undefined ? 0 : Array.from(groupText).length],
        ['string', groupText ?? null],
        ['name', names[group - 1] ?? null],
      ])
    )
  }
  return makeObject([
    ['offset', codepointIndex(text, match.index)],
    ['length', Array.from(match[0]).length],
    ['string', match[0]],
    ['captures', captures],
  ])
}

/** 找到某个捕获组在整段文本里的偏移（用 exec 的 indices 不可用时退化为 0） */
const matchedOffset = (text: string, match: RegExpExecArray, group: number): number => {
  const groupText = match[group]
  if (groupText === undefined) {
    return 0
  }
  const relative = match[0].indexOf(groupText)
  if (relative >= 0) {
    return relative
  }
  const absolute = text.indexOf(groupText, match.index)
  return absolute >= 0 ? absolute - match.index : 0
}

/** 命名捕获对象（capture / 替换模板用） */
const namedCaptures = (match: RegExpExecArray, names: string[]): JqObject => {
  const out = makeObject()
  for (let group = 1; group < match.length; group += 1) {
    const name = names[group - 1]
    if (!name) {
      continue
    }
    const value = match[group]
    out[name] = value === undefined ? null : value
  }
  return out
}

// length / 类型 / 基础
define('length', 0, ({ input }) => {
  if (input === null) {
    return [0]
  }
  if (typeof input === 'string') {
    return [Array.from(input).length]
  }
  if (Array.isArray(input)) {
    return [input.length]
  }
  if (isObject(input)) {
    return [Object.keys(input).length]
  }
  return raise(`${describeValue(input)} has no length`)
})

define('utf8bytelength', 0, ({ input }) => {
  if (typeof input !== 'string') {
    return raise(`${describeValue(input)} is not a string`)
  }
  return [new TextEncoder().encode(input).length]
})

define('keys', 0, ({ input }) => {
  if (Array.isArray(input)) {
    return [input.map((_, index) => index)]
  }
  if (isObject(input)) {
    return [Object.keys(input).sort()]
  }
  return raise(`${describeValue(input)} has no keys`)
})

define('keys_unsorted', 0, ({ input }) => {
  if (Array.isArray(input)) {
    return [input.map((_, index) => index)]
  }
  if (isObject(input)) {
    return [Object.keys(input)]
  }
  return raise(`${describeValue(input)} has no keys`)
})

define('values', 0, ({ input }) => (input === null ? [] : [input]))
define('type', 0, ({ input }) => [typeName(input)])
define('empty', 0, () => [])
define('not', 0, ({ input }) => [!isTruthy(input)])

define('add', 0, ({ input }) => {
  const values = arrayInput(input)
  if (values.length === 0) {
    return [null]
  }
  let total = values[0]
  for (const value of values.slice(1)) {
    total = addValues(total, value)
  }
  return [total]
})

define('min', 0, ({ input }) => {
  const values = arrayInput(input)
  return [values.length === 0 ? null : sortValues(values)[0]]
})

define('max', 0, ({ input }) => {
  const values = arrayInput(input)
  return [values.length === 0 ? null : (sortValues(values).at(-1) ?? null)]
})

define('sort', 0, ({ input }) => [sortValues(arrayInput(input))])

define('unique', 0, ({ input }) => {
  const values = sortValues(arrayInput(input))
  const out: JqValue[] = []
  for (const value of values) {
    if (out.length === 0 || !deepEqual(out.at(-1) ?? null, value)) {
      out.push(value)
    }
  }
  return [out]
})

define('reverse', 0, ({ input }) => {
  if (Array.isArray(input)) {
    return [[...input].reverse()]
  }
  if (typeof input === 'string') {
    return [Array.from(input).reverse().join('')]
  }
  return raise(`${describeValue(input)} cannot be reversed`)
})

define('flatten', 0, ({ input }) => {
  const values = arrayInput(input)
  const flat: JqValue[] = []
  const walk = (items: JqValue[]): void => {
    for (const item of items) {
      if (Array.isArray(item)) {
        walk(item)
      } else {
        flat.push(item)
      }
    }
  }
  walk(values)
  return [flat]
})

define('flatten', 1, (call) => {
  const values = arrayInput(call.input)
  const depth = argValue(call)
  if (typeof depth !== 'number' || depth < 0) {
    return raise(`flatten depth must be a non-negative number`)
  }
  const walk = (items: JqValue[], level: number): JqValue[] => {
    const out: JqValue[] = []
    for (const item of items) {
      if (Array.isArray(item) && level > 0) {
        out.push(...walk(item, level - 1))
      } else {
        out.push(item)
      }
    }
    return out
  }
  return [walk(values, Math.floor(depth))]
})

define('to_entries', 0, ({ input }) => toEntries(input))
define('from_entries', 0, ({ input }) => [fromEntries(input)])

define('with_entries', 1, (call) => {
  const entries = toEntries(call.input)[0]
  const mapped: JqValue[] = []
  for (const entry of arrayInput(entries)) {
    mapped.push(...evalAst(call.args[0], entry, call.env))
  }
  return [fromEntries(mapped)]
})

define('tostring', 0, ({ input }) => [typeof input === 'string' ? input : toText(input)])
define('tojson', 0, ({ input }) => [toText(input)])

define('tonumber', 0, ({ input }) => {
  if (typeof input === 'number') {
    return [input]
  }
  if (typeof input !== 'string') {
    return raise(`${describeValue(input)} cannot be parsed as a number`)
  }
  const trimmed = input.trim()
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return raise(`${describeValue(input)} cannot be parsed as a number`)
  }
  return [Number(trimmed)]
})

define('fromjson', 0, ({ input }) => {
  if (typeof input !== 'string') {
    return raise(`${describeValue(input)} cannot be parsed as JSON`)
  }
  const values = parseJsonStream(input)
  if (values.length !== 1) {
    return raise(`Cannot parse as JSON: ${escapeString(input)}`)
  }
  return [values[0]]
})

define('ascii_downcase', 0, ({ input }) => [
  stringInput(input).replace(/[A-Z]/g, (char) => char.toLowerCase()),
])
define('ascii_upcase', 0, ({ input }) => [
  stringInput(input).replace(/[a-z]/g, (char) => char.toUpperCase()),
])

define('explode', 0, ({ input }) => [
  Array.from(stringInput(input)).map((char) => char.codePointAt(0) ?? 0),
])

define('implode', 0, (call) => {
  const values = arrayInput(call.input)
  let out = ''
  for (const value of values) {
    if (typeof value !== 'number') {
      return raise(`implode requires an array of numbers, got ${describeValue(value)}`)
    }
    out += String.fromCodePoint(value)
  }
  return [out]
})

define('paths', 0, ({ input }) => {
  const out: JqValue[] = []
  collectPaths(input, [], out, false)
  return out
})

define('leaf_paths', 0, ({ input }) => {
  const out: JqValue[] = []
  collectPaths(input, [], out, true)
  return out
})

define('recurse', 0, ({ input }) => {
  const out: JqValue[] = []
  collectRecurse(input, out)
  return out
})

define('env', 0, ({ context }) => [makeObject(Object.entries(context.applet.env))])
define('now', 0, () => [Date.now() / 1000])
define('floor', 0, ({ input }) => [Math.floor(numberInput(input, 'floored'))])
define('ceil', 0, ({ input }) => [Math.ceil(numberInput(input, 'ceiled'))])
define('round', 0, ({ input }) => [Math.round(numberInput(input, 'rounded'))])
define('sqrt', 0, ({ input }) => [Math.sqrt(numberInput(input, 'sqrt'))])
define('fabs', 0, ({ input }) => [Math.abs(numberInput(input, 'fabs'))])
define('log', 0, ({ input }) => [Math.log(numberInput(input, 'log'))])

define('has', 1, (call) => {
  const keys = argValues(call)
  return keys.map((key) => {
    if (typeof key === 'string') {
      if (!isObject(call.input)) {
        return raise(`Cannot check whether ${typeName(call.input)} has a string key`)
      }
      return Object.prototype.hasOwnProperty.call(call.input, key)
    }
    if (typeof key === 'number') {
      if (!Array.isArray(call.input)) {
        return raise(`Cannot check whether ${typeName(call.input)} has a numeric key`)
      }
      return Number.isInteger(key) && key >= -call.input.length && key < call.input.length
    }
    return raise(`Cannot check whether ${typeName(call.input)} has a ${typeName(key)} key`)
  })
})

define('in', 1, (call) => {
  const containers = argValues(call)
  return containers.map((container) => {
    if (typeof call.input === 'string') {
      if (!isObject(container)) {
        return raise(`Cannot check whether ${typeName(container)} has a string key`)
      }
      return Object.prototype.hasOwnProperty.call(container, call.input)
    }
    if (typeof call.input === 'number') {
      if (!Array.isArray(container)) {
        return raise(`Cannot check whether ${typeName(container)} has a numeric key`)
      }
      return Number.isInteger(call.input) && call.input >= 0 && call.input < container.length
    }
    return raise(`Cannot check whether ${typeName(container)} has a ${typeName(call.input)} key`)
  })
})

define('map', 1, (call) => {
  const values = arrayInput(call.input)
  const out: JqValue[] = []
  for (const value of values) {
    out.push(...evalAst(call.args[0], value, call.env))
  }
  return [out]
})

define('map_values', 1, (call) => {
  if (Array.isArray(call.input)) {
    const out: JqValue[] = []
    for (const value of call.input) {
      out.push(...evalAst(call.args[0], value, call.env))
    }
    return [out]
  }
  if (isObject(call.input)) {
    const out = makeObject()
    for (const key of Object.keys(call.input)) {
      const results = evalAst(call.args[0], call.input[key], call.env)
      if (results.length > 0) {
        out[key] = results[0]
      }
    }
    return [out]
  }
  return raise(`Cannot iterate over ${describeValue(call.input)}`)
})

define('select', 1, (call) => {
  // jq 的 select(f) 等价 if f then . else empty end：条件每出一个真值就放行一次
  return evalAst(call.args[0], call.input, call.env)
    .filter((value) => isTruthy(value))
    .map(() => call.input)
})

define('sort_by', 1, (call) => {
  const pairs = keyedValues(arrayInput(call.input), call.args[0], call.env)
  return [sortKeyed(pairs).map((pair) => pair.value)]
})

define('group_by', 1, (call) => {
  const pairs = sortKeyed(keyedValues(arrayInput(call.input), call.args[0], call.env))
  const groups: JqValue[] = []
  let current: JqValue[] = []
  let lastKey: JqValue | undefined
  for (const pair of pairs) {
    if (current.length > 0 && lastKey !== undefined && deepEqual(lastKey, pair.key)) {
      current.push(pair.value)
      continue
    }
    if (current.length > 0) {
      groups.push(current)
    }
    current = [pair.value]
    lastKey = pair.key
  }
  if (current.length > 0) {
    groups.push(current)
  }
  return [groups]
})

define('unique_by', 1, (call) => {
  const pairs = sortKeyed(keyedValues(arrayInput(call.input), call.args[0], call.env))
  const out: JqValue[] = []
  let lastKey: JqValue | undefined
  for (const pair of pairs) {
    if (out.length === 0 || lastKey === undefined || !deepEqual(lastKey, pair.key)) {
      out.push(pair.value)
    }
    lastKey = pair.key
  }
  return [out]
})

define('min_by', 1, (call) => {
  const pairs = keyedValues(arrayInput(call.input), call.args[0], call.env)
  if (pairs.length === 0) {
    return [null]
  }
  let best = pairs[0]
  for (const pair of pairs.slice(1)) {
    if (compareValues(pair.key, best.key) < 0) {
      best = pair
    }
  }
  return [best.value]
})

define('max_by', 1, (call) => {
  const pairs = keyedValues(arrayInput(call.input), call.args[0], call.env)
  if (pairs.length === 0) {
    return [null]
  }
  let best = pairs[0]
  for (const pair of pairs.slice(1)) {
    if (compareValues(pair.key, best.key) >= 0) {
      best = pair
    }
  }
  return [best.value]
})

define('split', 1, (call) => [stringInput(call.input).split(argText(call))])
define('splits', 1, (call) => {
  const text = stringInput(call.input)
  const regex = compileRegex(argText(call), '')
  const parts = text.split(regex)
  while (parts.length > 0 && parts.at(-1) === '') {
    parts.pop()
  }
  return parts
})

define('join', 1, (call) => {
  const separator = argText(call)
  const values = arrayInput(call.input)
  const pieces = values.map((value) => {
    if (value === null) {
      return ''
    }
    if (typeof value === 'string') {
      return value
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return toText(value)
    }
    return raise(`Cannot join ${describeValue(value)}`)
  })
  return [pieces.join(separator)]
})

define('ltrimstr', 1, (call) => {
  const text = stringInput(call.input)
  const prefix = argText(call)
  return [text.startsWith(prefix) ? text.slice(prefix.length) : text]
})

define('rtrimstr', 1, (call) => {
  const text = stringInput(call.input)
  const suffix = argText(call)
  return [text.endsWith(suffix) ? text.slice(0, text.length - suffix.length) : text]
})

define('startswith', 1, (call) => [stringInput(call.input).startsWith(argText(call))])
define('endswith', 1, (call) => [stringInput(call.input).endsWith(argText(call))])

define('test', 1, (call) => [compileRegex(argText(call), '').test(stringInput(call.input))])
define('test', 2, (call) => [
  compileRegex(argText(call), argTextAt(call, 1)).test(stringInput(call.input)),
])

define('match', 1, (call) => {
  const text = stringInput(call.input)
  const pattern = argText(call)
  const regex = compileRegex(pattern, '')
  const names = captureNames(pattern)
  const match = regex.exec(text)
  return match ? [matchToValue(text, match, names)] : []
})

define('match', 2, (call) => {
  const text = stringInput(call.input)
  const pattern = argText(call)
  const flags = argTextAt(call, 1)
  const regex = compileRegex(pattern, flags)
  const names = captureNames(pattern)
  const out: JqValue[] = []
  if (regex.global) {
    let match = regex.exec(text)
    while (match) {
      out.push(matchToValue(text, match, names))
      match = regex.exec(text)
    }
    return out
  }
  const match = regex.exec(text)
  return match ? [matchToValue(text, match, names)] : []
})

define('capture', 1, (call) => {
  const text = stringInput(call.input)
  const pattern = argText(call)
  const regex = compileRegex(pattern, '')
  const names = captureNames(pattern)
  const match = regex.exec(text)
  return match ? [namedCaptures(match, names)] : []
})

define('capture', 2, (call) => {
  const text = stringInput(call.input)
  const pattern = argText(call)
  const flags = argTextAt(call, 1)
  const regex = compileRegex(pattern, flags)
  const names = captureNames(pattern)
  const match = regex.exec(text)
  return match ? [namedCaptures(match, names)] : []
})

/** gsub / sub 共用：替换模板作为过滤器，用捕获对象求值 */
const replaceMatches = (call: BuiltinCall, global: boolean): JqValue[] => {
  const text = stringInput(call.input)
  const pattern = argText(call)
  const flags = global ? 'g' : ''
  const regex = compileRegex(pattern, flags)
  const names = captureNames(pattern)
  const replacement = call.args[1]
  let out = ''
  let cursor = 0
  let match = regex.exec(text)
  while (match) {
    const captures = namedCaptures(match, names)
    const values = evalAst(replacement, captures, call.env)
    const piece = values.length > 0 ? values[0] : null
    if (typeof piece !== 'string') {
      return raise(`gsub replacement must be a string, got ${describeValue(piece)}`)
    }
    out += text.slice(cursor, match.index) + piece
    cursor = match.index + match[0].length
    if (match[0].length === 0) {
      regex.lastIndex += 1
    }
    match = regex.exec(text)
    if (!global) {
      break
    }
  }
  return [out + text.slice(cursor)]
}

define('sub', 2, (call) => replaceMatches(call, false))
define('gsub', 2, (call) => replaceMatches(call, true))

define('contains', 1, (call) => argValues(call).map((needle) => containsValue(call.input, needle)))
define('inside', 1, (call) =>
  argValues(call).map((haystack) => containsValue(haystack, call.input))
)

/** 数组里第一个深度相等元素的下标；字符串里第一次出现的码点下标 */
const findIndex = (input: JqValue, needle: JqValue, fromEnd: boolean): JqValue => {
  if (Array.isArray(input)) {
    const indices = input
      .map((item, index) => (deepEqual(item, needle) ? index : -1))
      .filter((index) => index >= 0)
    if (indices.length === 0) {
      return null
    }
    return fromEnd ? indices[indices.length - 1] : indices[0]
  }
  if (typeof input === 'string') {
    if (typeof needle !== 'string') {
      return raise(`Cannot search for ${describeValue(needle)} in a string`)
    }
    const index = fromEnd ? input.lastIndexOf(needle) : input.indexOf(needle)
    return index < 0 ? null : codepointIndex(input, index)
  }
  return raise(`Cannot search in ${describeValue(input)}`)
}

define('index', 1, (call) => [findIndex(call.input, argValue(call), false)])
define('rindex', 1, (call) => [findIndex(call.input, argValue(call), true)])

define('indices', 1, (call) => {
  const needle = argValue(call)
  if (Array.isArray(call.input)) {
    const out: JqValue[] = []
    call.input.forEach((item, index) => {
      if (deepEqual(item, needle)) {
        out.push(index)
      }
    })
    return [out]
  }
  if (typeof call.input === 'string') {
    if (typeof needle !== 'string') {
      return raise(`Cannot search for ${describeValue(needle)} in a string`)
    }
    const out: JqValue[] = []
    let index = call.input.indexOf(needle)
    while (index >= 0) {
      out.push(codepointIndex(call.input, index))
      index = call.input.indexOf(needle, index + 1)
    }
    return [out]
  }
  return raise(`Cannot search in ${describeValue(call.input)}`)
})

define('range', 1, (call) => {
  const end = argValue(call)
  if (typeof end !== 'number') {
    return raise('range bounds must be numeric')
  }
  return buildRange(0, end, 1)
})

define('range', 2, (call) => {
  const start = argValue({ ...call })
  const end = argValue({ ...call, args: [call.args[1]] })
  if (typeof start !== 'number' || typeof end !== 'number') {
    return raise('range bounds must be numeric')
  }
  return buildRange(start, end, 1)
})

define('range', 3, (call) => {
  const start = argValue(call)
  const end = argValue({ ...call, args: [call.args[1]] })
  const step = argValue({ ...call, args: [call.args[2]] })
  if (typeof start !== 'number' || typeof end !== 'number' || typeof step !== 'number') {
    return raise('range bounds must be numeric')
  }
  if (step === 0) {
    return raise('range step must not be zero')
  }
  return buildRange(start, end, step)
})

/** range 的数值生成 */
const buildRange = (start: number, end: number, step: number): JqValue[] => {
  const out: JqValue[] = []
  if (step > 0) {
    for (let value = start; value < end; value += step) {
      out.push(value)
    }
  } else {
    for (let value = start; value > end; value += step) {
      out.push(value)
    }
  }
  return out
}

define('pow', 2, (call) => {
  const base = argValue(call)
  const exponent = argValue({ ...call, args: [call.args[1]] })
  if (typeof base !== 'number' || typeof exponent !== 'number') {
    return raise(`pow requires numbers, got ${describeValue(base)} and ${describeValue(exponent)}`)
  }
  return [base ** exponent]
})

// ---------- 命令行 ----------

const JQ_VERSION = 'jq-1.7+nv'

const HELP_TEXT = `NanoVM jq 1.7（内置子集实现）

用法: jq [选项] <过滤器> [文件...]
  没有文件（或文件为 -）时读标准输入；多个文件按顺序拼接输入流。

选项:
  -r, --raw-output       字符串结果直接输出原文（不加引号）
  -j, --join-output      同 -r，但结果之间不换行
  -c, --compact-output   紧凑 JSON 输出
  -n, --null-input       不读输入，过滤器只以 null 运行一次
  -s, --slurp            把所有输入合并成一个数组
  -e, --exit-status      最后结果为 false/null 时退出码 1（没有任何结果时 4）
  -S, --sort-keys        递归排序对象键
      --arg name value   注入字符串变量 $name
      --argjson name json
                         注入 JSON 变量 $name
  -h, --help             显示本帮助
  -V, --version          显示版本

过滤器:
  . .foo .foo.bar .[0] .[-1] .[] .[1:3] .foo[] .foo?
  | , ( )   + - * / %   == != < <= > >=   and or not   //   ?
  if a then b elif c then d else e end   try a catch b
  as $x | ...   字符串插值 "\\(.name)"   数组 [a,b]   对象 {a: 1, "b": .c}
函数:
  length keys keys_unsorted values has in type empty not map map_values
  select add min max min_by max_by sort sort_by group_by unique unique_by
  reverse flatten range to_entries from_entries with_entries split join
  ltrimstr rtrimstr startswith endswith test match capture contains inside
  index rindex indices tostring tonumber tojson fromjson ascii_downcase
  ascii_upcase explode implode paths leaf_paths recurse env now floor ceil
  round sqrt fabs log pow sub gsub splits

不支持: reduce / foreach / label / 带参数的 def / 赋值运算符（= |= +=）。
`

type JqArgs =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; code: number; message: string }
  | {
      kind: 'run'
      options: {
        raw: boolean
        join: boolean
        compact: boolean
        nullInput: boolean
        slurp: boolean
        exitStatus: boolean
        sortKeys: boolean
      }
      filter: string
      files: string[]
      variables: Map<string, JqValue>
    }

const optionError = (message: string): JqArgs => ({
  kind: 'error',
  code: 2,
  message: `jq: ${message}\n`,
})

/** 解析 jq 自己的命令行：选项必须在过滤器之前 */
const parseJqArgs = (argv: string[]): JqArgs => {
  const options = {
    raw: false,
    join: false,
    compact: false,
    nullInput: false,
    slurp: false,
    exitStatus: false,
    sortKeys: false,
  }
  const variables = new Map<string, JqValue>()
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === '-' || !arg.startsWith('-')) {
      break
    }
    // `-.a` / `-1` 这类是过滤器，不是选项
    if (arg.length > 1 && arg[1] !== '-' && !/[A-Za-z]/.test(arg[1])) {
      break
    }
    if (arg === '--') {
      index += 1
      break
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const equals = body.indexOf('=')
      const name = equals >= 0 ? body.slice(0, equals) : body
      const inline = equals >= 0 ? body.slice(equals + 1) : null
      if (name === 'help') {
        return { kind: 'help' }
      }
      if (name === 'version') {
        return { kind: 'version' }
      }
      if (name === 'raw-output') {
        options.raw = true
        index += 1
        continue
      }
      if (name === 'join-output') {
        options.join = true
        options.raw = true
        index += 1
        continue
      }
      if (name === 'compact-output') {
        options.compact = true
        index += 1
        continue
      }
      if (name === 'null-input') {
        options.nullInput = true
        index += 1
        continue
      }
      if (name === 'slurp') {
        options.slurp = true
        index += 1
        continue
      }
      if (name === 'exit-status') {
        options.exitStatus = true
        index += 1
        continue
      }
      if (name === 'sort-keys') {
        options.sortKeys = true
        index += 1
        continue
      }
      if (name === 'arg' || name === 'argjson') {
        const variableName = inline ?? argv[index + 1]
        const variableValue = inline === null ? argv[index + 2] : argv[index + 1]
        if (variableName === undefined || variableValue === undefined) {
          return optionError(`Missing argument for --${name}`)
        }
        index += inline === null ? 3 : 2
        if (name === 'arg') {
          variables.set(variableName, variableValue)
          continue
        }
        let parsed: JqValue[] = []
        try {
          parsed = parseJsonStream(variableValue)
        } catch {
          return optionError('Invalid JSON text passed to --argjson')
        }
        if (parsed.length !== 1) {
          return optionError('Invalid JSON text passed to --argjson')
        }
        variables.set(variableName, parsed[0])
        continue
      }
      return optionError(`Unknown option ${arg}`)
    }
    const letters = arg.slice(1)
    let handled = true
    for (const letter of letters) {
      if (letter === 'r') {
        options.raw = true
      } else if (letter === 'j') {
        options.join = true
        options.raw = true
      } else if (letter === 'c') {
        options.compact = true
      } else if (letter === 'n') {
        options.nullInput = true
      } else if (letter === 's') {
        options.slurp = true
      } else if (letter === 'e') {
        options.exitStatus = true
      } else if (letter === 'S') {
        options.sortKeys = true
      } else if (letter === 'h') {
        return { kind: 'help' }
      } else if (letter === 'V') {
        return { kind: 'version' }
      } else {
        handled = false
        return optionError(`Unknown option -${letter}`)
      }
    }
    if (!handled) {
      return optionError(`Unknown option ${arg}`)
    }
    index += 1
  }
  if (index >= argv.length) {
    return { kind: 'error', code: 2, message: `jq: 缺少过滤器参数\n\n${HELP_TEXT}` }
  }
  return {
    kind: 'run',
    options,
    filter: argv[index],
    files: argv.slice(index + 1),
    variables,
  }
}

// ---------- 命令实现 ----------

/** 读取一个输入源：`-` 表示标准输入 */
const readSource = (context: AppletContext, path: string): string => {
  if (path === '-') {
    return context.stdin
  }
  return DECODER.decode(readInputBytes(context, path))
}

const runJq = (context: AppletContext): AppletResult => {
  const args = parseJqArgs(context.argv.slice(1))
  if (args.kind === 'help') {
    return { code: 0, stdout: HELP_TEXT }
  }
  if (args.kind === 'version') {
    return { code: 0, stdout: `${JQ_VERSION}\n` }
  }
  if (args.kind === 'error') {
    return { code: args.code, stderr: args.message }
  }

  let program: Program
  try {
    program = parseProgram(args.filter)
  } catch (error) {
    if (error instanceof JqSyntaxError) {
      const detail = /^(syntax error|不支持)/.test(error.message)
        ? error.message
        : `syntax error: ${error.message}`
      return {
        code: 3,
        stderr: `jq: error (at <stdin>:0): ${detail} (at filter offset ${error.position})\n`,
      }
    }
    throw error
  }

  /** 每个待求值的输入 + 来源名（错误文案用） */
  const items: Array<{ value: JqValue; label: string }> = []
  if (args.options.nullInput) {
    items.push({ value: null, label: '<stdin>' })
  } else {
    const sources = args.files.length > 0 ? args.files : ['-']
    for (const source of sources) {
      if (interrupted(context)) {
        return { code: 130 }
      }
      const label = source === '-' ? '<stdin>' : source
      let text: string
      try {
        text = readSource(context, source)
      } catch (error) {
        const reason =
          error instanceof VmError
            ? ERRNO_TEXT[error.code]
            : error instanceof Error
              ? error.message
              : String(error)
        return { code: 2, stderr: `jq: error: Could not open file ${source}: ${reason}\n` }
      }
      try {
        for (const value of parseJsonStream(text)) {
          items.push({ value, label })
        }
      } catch (error) {
        if (error instanceof JqInputError) {
          return { code: 4, stderr: `jq: error (at ${label}:0): ${error.message}\n` }
        }
        throw error
      }
    }
    if (args.options.slurp) {
      const slurped = items.map((item) => item.value)
      items.length = 0
      items.push({ value: slurped, label: sources[0] === '-' ? '<stdin>' : sources[0] })
    }
  }

  const evalContext: EvalContext = { applet: context, label: '<stdin>', steps: 0 }
  const env: Env = { vars: args.variables, functions: program.functions, context: evalContext }

  let stdout = ''
  let produced = false
  let lastValue: JqValue = null
  for (const item of items) {
    if (interrupted(context)) {
      return { code: 130, stdout }
    }
    evalContext.label = item.label
    let results: JqValue[]
    try {
      results = evalAst(program.body, item.value, env)
    } catch (error) {
      if (error instanceof JqAbortError) {
        return { code: 130, stdout }
      }
      if (error instanceof JqCompileError) {
        return {
          code: 3,
          stdout,
          stderr: `jq: error (at ${item.label}:0): ${error.message}\n`,
        }
      }
      if (error instanceof JqRuntimeError) {
        return {
          code: 5,
          stdout,
          stderr: `jq: error (at ${item.label}:0): ${error.message}\n`,
        }
      }
      if (error instanceof RangeError) {
        return {
          code: 5,
          stdout,
          stderr: `jq: error (at ${item.label}:0): 求值嵌套过深（可能是无限递归）\n`,
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { code: 5, stdout, stderr: `jq: error (at ${item.label}:0): ${message}\n` }
    }
    for (const value of results) {
      produced = true
      lastValue = value
      const text =
        args.options.raw && typeof value === 'string'
          ? value
          : formatValue(value, args.options.compact, args.options.sortKeys, '')
      stdout += args.options.join ? text : `${text}\n`
    }
  }

  if (args.options.exitStatus) {
    if (!produced) {
      return { code: 4, stdout }
    }
    const status = lastValue === false || lastValue === null ? 1 : 0
    return { code: status, stdout }
  }
  return { code: 0, stdout }
}

/** jq：JSON 过滤与格式化（子集） */
const jqApplet: Applet = {
  name: 'jq',
  summary: '过滤、格式化 JSON（jq 语法子集）',
  summaryEn: 'Filter and format JSON (jq subset)',
  usage: 'jq [options] <filter> [file...]',
  run: (context: AppletContext): AppletResult => runJq(context),
}

/** 扩展命令表：JSON 处理工具 */
export const EXTRAS_JQ_APPLETS: Applet[] = [jqApplet]
