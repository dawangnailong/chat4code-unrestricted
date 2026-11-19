import type { NanovmFS } from '../fs.js'
import { baseName, resolvePath } from '../fs.js'
import type { ShellApi, ToolchainIO } from '../types.js'

/**
 * 内置 make：GNU make 的常用子集，跑在 NanoVM Slim 的虚拟文件系统里。
 *
 * 能力范围：
 * - 命令行：-f / -C / -n / -B / -s / -k / -j / -e / --no-print-directory / -h / -v / --。
 * - 变量：= := ?= += !=，export / unexport，环境变量与 -e 优先级。
 * - 规则：单冒号 / 双冒号、order-only 依赖、模式规则（%.o: %.c）、.PHONY、.DEFAULT_GOAL，
 *   显式规则只写依赖时借用模式规则的配方（GNU 的隐式规则查找）。
 * - include / -include，注释、TAB 配方、反斜杠续行。
 * - 展开：$(VAR) ${VAR} $(VAR:%.c=%.o) $$ 自动变量，以及常用内置函数。
 * - 执行：时间戳比较、依赖递归构建、循环依赖断开、-k 继续、中断返回 130。
 *
 * 已知缺口：$(call) / $(eval) 不做展开（原样输出）；并行构建（-j）只警告并按串行跑；
 * 目标专属变量、静态模式规则（targets: %.o: %.c）、二次展开、vpath、.ONESHELL 未实现；
 * 命令行变量赋值（make FOO=bar）会被当成目标；GNU 的默认变量（CC / RM / CFLAGS 等）不预置；
 * MAKEFLAGS 只导出开关字母，子 make 不解析它。
 *
 * 同步性说明：make 的变量展开里可能含 $(shell ...)，而 shell.run 是异步的，
 * 所以这里把「解析 + 展开」整体设计成 async：赋值、include、规则都在解析阶段 await，
 * 执行阶段再按行 await 展开。这样不需要先收集 $(shell) 再批量替换。
 */

/** make 的上下文：ToolchainIO 加上子命令执行 */
export type MakeIO = ToolchainIO & { shell: ShellApi }

/** 变量风格：递归展开（=）或立即展开（:=） */
type VariableFlavor = 'recursive' | 'simple'

type Variable = {
  value: string
  flavor: VariableFlavor
}

/** 配方中的一行；反斜杠续行已经合并成一条 */
type RecipeLine = {
  text: string
  /** Makefile 里的起始行号，报错用 */
  line: number
  /** Makefile 名称，报错用 */
  file: string
}

/** 一条规则；同一目标的多条单冒号规则在注册时合并成一个 Rule */
type Rule = {
  targets: string[]
  prereqs: string[]
  orderOnly: string[]
  recipe: RecipeLine[]
  doubleColon: boolean
  isPattern: boolean
  file: string
  line: number
}

/** 命令行开关 */
type MakeOptions = {
  alwaysMake: boolean
  dryRun: boolean
  silent: boolean
  keepGoing: boolean
  envOverride: boolean
}

/** 一次 make 调用的全部可变态 */
type MakeState = {
  vars: Map<string, Variable>
  /** 需要 export 给配方的变量名 */
  exported: Set<string>
  /** 单冒号规则，按目标合并 */
  rules: Map<string, Rule>
  /** 双冒号规则：每个目标可以有多条独立规则 */
  doubleRules: Map<string, Rule[]>
  patterns: Rule[]
  phony: Set<string>
  suffixes: string[]
  makefileList: string[]
  /** .DEFAULT_GOAL 显式指定 */
  defaultGoal: string | null
  /** 第一个出现的普通目标 */
  firstGoal: string | null
  cmdGoals: string[]
  /** MAKEFLAGS 的值 */
  flags: string
  env: Record<string, string>
  fs: NanovmFS
  shell: ShellApi
  io: MakeIO
  curdir: string
  options: MakeOptions
}

/** 展开上下文：自动变量、foreach 的局部变量、展开深度 */
type ExpandEnv = {
  auto: Record<string, string>
  locals?: Map<string, string>
  depth: number
}

/** 解析 / 执行阶段的致命错误：message 是完整文案（不含换行） */
class MakeAbort extends Error {
  readonly code: number

  /** true 表示 message 已经是最终文案，不再加 `make: *** ` 前缀 */
  readonly formatted: boolean

  constructor(message: string, code = 2, formatted = false) {
    super(message)
    this.name = 'MakeAbort'
    this.code = code
    this.formatted = formatted
  }
}

const DEFAULT_MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile']

/** 递归展开的深度上限，防止 `A = $(A)` 这类自引用卡死 */
const MAX_EXPAND_DEPTH = 40

/** include 的递归上限 */
const MAX_INCLUDE_DEPTH = 16

/** 展开时没有自动变量的空上下文 */
const BASE_ENV: ExpandEnv = { auto: {}, depth: 0 }

/** 已实现的内置函数名 */
const FUNCTION_NAMES = new Set([
  'wildcard',
  'patsubst',
  'subst',
  'notdir',
  'dir',
  'basename',
  'suffix',
  'addprefix',
  'addsuffix',
  'filter',
  'filter-out',
  'sort',
  'strip',
  'firstword',
  'word',
  'words',
  'shell',
  'foreach',
  'if',
  'or',
  'and',
])

const HELP_TEXT = [
  '用法：make [选项] [目标...]',
  '',
  '选项：',
  '  -f 文件, --file=文件     指定 Makefile（可重复，取第一个存在的）',
  '  -C 目录                  先切换目录再读取 Makefile（可重复，逐层进入）',
  '  -n, --just-print         只打印配方，不执行',
  '  -B, --always-make        忽略时间戳，强制重建所有目标',
  '  -s, --silent, --quiet    不回显配方命令行',
  '  -k, --keep-going         某个目标失败后继续构建其它目标',
  '  -j[N]                    并行构建（NanoVM 内置 make 不支持，按串行执行）',
  '  -e                       环境变量优先于 Makefile 里的同名变量',
  '  --no-print-directory     不打印进入 / 离开目录（保留参数，本实现忽略）',
  '  -h, --help               显示本帮助',
  '  -v, --version            显示版本',
  '',
  '支持：变量（= := ?= += !=）、export / unexport、include / -include、.PHONY、',
  '.DEFAULT_GOAL、order-only 依赖（|）、模式规则（%.o: %.c）、常用内置函数与自动变量。',
  '',
].join('\n')

// ---------- 通用工具 ----------

/** 去掉行尾的 CR（Windows 换行的 Makefile） */
const stripCR = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)

/** 取第一个空白分隔的词 */
const firstWord = (text: string): string => {
  const match = /^\S+/.exec(text)
  return match === null ? '' : match[0]
}

/** 按顶层分隔符切分：$() / ${} 里的内容不参与切分 */
const splitTopLevel = (text: string, separator: string): string[] => {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === '$' && (text[index + 1] === '(' || text[index + 1] === '{')) {
      current += `$${text[index + 1] ?? ''}`
      depth += 1
      index += 2
      continue
    }
    if (depth > 0 && (char === ')' || char === '}')) {
      depth -= 1
      current += char
      index += 1
      continue
    }
    if (depth === 0 && char === separator) {
      parts.push(current)
      current = ''
      index += 1
      continue
    }
    current += char
    index += 1
  }
  parts.push(current)
  return parts
}

/** 按空白切分，$() 里的空格不切 */
const splitWords = (text: string): string[] => {
  const words: string[] = []
  let current = ''
  let depth = 0
  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === '$' && (text[index + 1] === '(' || text[index + 1] === '{')) {
      current += `$${text[index + 1] ?? ''}`
      depth += 1
      index += 2
      continue
    }
    if (depth > 0 && (char === ')' || char === '}')) {
      depth -= 1
      current += char
      index += 1
      continue
    }
    if (depth === 0 && /\s/.test(char)) {
      if (current !== '') {
        words.push(current)
        current = ''
      }
      index += 1
      continue
    }
    current += char
    index += 1
  }
  if (current !== '') {
    words.push(current)
  }
  return words
}

/** 去重但保留首次出现的顺序 */
const dedupe = (words: string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const word of words) {
    if (seen.has(word)) {
      continue
    }
    seen.add(word)
    out.push(word)
  }
  return out
}

/** 顶层字符定位：跳过 $() / ${} 内部，返回第一个命中的下标，找不到返回 -1 */
const findTopLevel = (text: string, target: string, from = 0): number => {
  let depth = 0
  let index = from
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === '$' && (text[index + 1] === '(' || text[index + 1] === '{')) {
      depth += 1
      index += 2
      continue
    }
    if (depth > 0 && (char === ')' || char === '}')) {
      depth -= 1
      index += 1
      continue
    }
    if (depth === 0 && char === target) {
      return index
    }
    index += 1
  }
  return -1
}

/** 去掉非配方行里的注释；`\#` 是转义的字面井号 */
const stripComment = (line: string): string => {
  let depth = 0
  let index = 0
  while (index < line.length) {
    const char = line[index] ?? ''
    if (char === '\\' && line[index + 1] === '#') {
      index += 2
      continue
    }
    if (char === '$' && (line[index + 1] === '(' || line[index + 1] === '{')) {
      depth += 1
      index += 2
      continue
    }
    if (depth > 0 && (char === ')' || char === '}')) {
      depth -= 1
      index += 1
      continue
    }
    if (depth === 0 && char === '#') {
      return line.slice(0, index).replace(/\\#/g, '#')
    }
    index += 1
  }
  return line.replace(/\\#/g, '#')
}

/** 模式匹配：返回 stem；不匹配返回 null。只认第一个 % */
const matchPattern = (pattern: string, word: string): string | null => {
  const percent = pattern.indexOf('%')
  if (percent < 0) {
    return pattern === word ? '' : null
  }
  const prefix = pattern.slice(0, percent)
  const suffix = pattern.slice(percent + 1)
  if (word.length < prefix.length + suffix.length) {
    return null
  }
  if (!word.startsWith(prefix) || !word.endsWith(suffix)) {
    return null
  }
  return word.slice(prefix.length, word.length - suffix.length)
}

/** 把模式里的 % 替换成 stem（只替换第一个） */
const replacePercent = (pattern: string, stem: string): string => {
  const percent = pattern.indexOf('%')
  if (percent < 0) {
    return pattern
  }
  return `${pattern.slice(0, percent)}${stem}${pattern.slice(percent + 1)}`
}

/** patsubst 的单复数：pattern 不匹配时返回 null */
const patternReplace = (pattern: string, replacement: string, word: string): string | null => {
  const stem = matchPattern(pattern, word)
  if (stem === null) {
    return null
  }
  return replacePercent(replacement, stem)
}

const hasGlobChar = (word: string): boolean => /[*?[]/.test(word)

/** 绝对路径转回相对 CURDIR 的形式 */
const toRelative = (curdir: string, path: string): string => {
  if (path === curdir) {
    return '.'
  }
  const prefix = curdir === '/' ? '/' : `${curdir}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** 用 fs.glob 展开通配符，结果保持相对 CURDIR */
const globRelative = (state: MakeState, pattern: string): string[] =>
  state.fs.glob(resolvePath(state.curdir, pattern)).map((match) => toRelative(state.curdir, match))

/** 规则 / 依赖里的通配符展开；没有命中就保留原词（GNU 对依赖是这么做的） */
const expandWildcards = (state: MakeState, words: string[]): string[] => {
  const out: string[] = []
  for (const word of words) {
    if (!hasGlobChar(word)) {
      out.push(word)
      continue
    }
    const matches = globRelative(state, word)
    if (matches.length === 0) {
      out.push(word)
      continue
    }
    out.push(...matches)
  }
  return out
}

/** $(dir ...) 的语义：保留结尾斜杠，没有目录时是 ./ */
const dirWithSlash = (word: string): string => {
  const slash = word.lastIndexOf('/')
  return slash < 0 ? './' : word.slice(0, slash + 1)
}

/** 自动变量 $(@D) 用：目录部分，没有目录时是 . */
const dirPart = (word: string): string => {
  const slash = word.lastIndexOf('/')
  return slash <= 0 ? '.' : word.slice(0, slash)
}

/** $(basename ...)：去掉最后一个后缀 */
const fileBasename = (word: string): string => {
  const slash = word.lastIndexOf('/')
  const dot = word.lastIndexOf('.')
  return dot <= slash ? word : word.slice(0, dot)
}

/** $(suffix ...)：最后一个后缀，没有则空 */
const fileSuffix = (word: string): string => {
  const slash = word.lastIndexOf('/')
  const dot = word.lastIndexOf('.')
  return dot <= slash ? '' : word.slice(dot)
}

/** shell 输出转成 make 值：内部换行变空格，去掉尾部换行 */
const normalizeShellStdout = (text: string): string => text.replace(/\r?\n/g, ' ').trim()

// ---------- 变量查找与展开 ----------

/** 内置变量 */
const builtinVariable = (state: MakeState, name: string): string | null => {
  switch (name) {
    case 'MAKE':
      return 'make'
    case 'CURDIR':
      return state.curdir
    case 'MAKEFILE_LIST':
      return state.makefileList.join(' ')
    case 'SHELL':
      return '/bin/sh'
    case 'MAKEFLAGS':
      return state.flags
    case 'MAKECMDGOALS':
      return state.cmdGoals.join(' ')
    default:
      return null
  }
}

/**
 * 变量解析顺序：foreach 局部变量 → 自动变量 →（-e 时）环境变量 → Makefile 变量
 * → 内置变量 → 环境变量。找不到返回 null（展开成空串）。
 */
const findVariable = (state: MakeState, name: string, env: ExpandEnv): Variable | null => {
  const local = env.locals?.get(name)
  if (local !== undefined) {
    return { value: local, flavor: 'simple' }
  }
  const auto = env.auto[name]
  if (auto !== undefined) {
    return { value: auto, flavor: 'simple' }
  }
  if (state.options.envOverride) {
    const fromEnv = state.env[name]
    if (fromEnv !== undefined) {
      return { value: fromEnv, flavor: 'simple' }
    }
  }
  const defined = state.vars.get(name)
  if (defined !== undefined) {
    return defined
  }
  const builtin = builtinVariable(state, name)
  if (builtin !== null) {
    return { value: builtin, flavor: 'simple' }
  }
  const fromEnv = state.env[name]
  if (fromEnv !== undefined) {
    // 环境变量按 GNU 的习惯当递归变量处理
    return { value: fromEnv, flavor: 'recursive' }
  }
  return null
}

const lookupAndExpand = async (state: MakeState, name: string, env: ExpandEnv): Promise<string> => {
  const variable = findVariable(state, name, env)
  if (variable === null) {
    return ''
  }
  if (variable.flavor === 'simple') {
    return variable.value
  }
  return expandText(state, variable.value, env)
}

/** 配方环境的公共部分：io.env + export 的变量 + MAKELEVEL / MAKE / MAKEFLAGS 等 */
const makeShellEnv = async (state: MakeState): Promise<Record<string, string>> => {
  const env: Record<string, string> = { ...state.env }
  for (const name of state.exported) {
    // 走完整的变量解析：-e 时环境变量优先，导出的是生效后的值
    const variable = findVariable(state, name, BASE_ENV)
    if (variable === null) {
      continue
    }
    env[name] =
      variable.flavor === 'simple'
        ? variable.value
        : await expandText(state, variable.value, BASE_ENV)
  }
  const level = Number.parseInt(state.env.MAKELEVEL ?? '0', 10)
  env.MAKELEVEL = String(Number.isFinite(level) ? level + 1 : 1)
  env.MAKE = 'make'
  env.MAKEFLAGS = state.flags
  env.MAKECMDGOALS = state.cmdGoals.join(' ')
  env.SHELL = '/bin/sh'
  return env
}

/** 执行一条 $(shell ...) / != 的右值命令；stderr 直接转给 make 的 stderr */
const runShellCommand = async (
  state: MakeState,
  command: string
): Promise<{ code: number; stdout: string }> => {
  const env = await makeShellEnv(state)
  const result = await state.shell.run(command, {
    cwd: state.curdir,
    env,
    silent: true,
  })
  if (result.stderr !== '') {
    state.io.stderr(result.stderr)
  }
  return { code: result.code, stdout: result.stdout }
}

/** 读取 $(...) 的内容，返回 body 与右括号下标 */
const readReference = (
  text: string,
  start: number,
  open: '(' | '{'
): { body: string; end: number } => {
  const close = open === '(' ? ')' : '}'
  let depth = 0
  let index = start
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === '$' && (text[index + 1] === '(' || text[index + 1] === '{')) {
      depth += 1
      index += 2
      continue
    }
    if (char === close && depth === 0) {
      return { body: text.slice(start, index), end: index }
    }
    if (depth > 0 && (char === ')' || char === '}')) {
      depth -= 1
      index += 1
      continue
    }
    index += 1
  }
  // 括号没闭合时按到行尾处理，尽量不吞掉调用方的输出
  return { body: text.slice(start), end: text.length }
}

const expandText = async (state: MakeState, text: string, env: ExpandEnv): Promise<string> => {
  if (env.depth > MAX_EXPAND_DEPTH) {
    return ''
  }
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char !== '$') {
      out += char
      index += 1
      continue
    }
    const next = text[index + 1]
    if (next === undefined) {
      out += '$'
      break
    }
    if (next === '$') {
      // $$ 交给 shell 自己解释
      out += '$'
      index += 2
      continue
    }
    if (next === '(' || next === '{') {
      const reference = readReference(text, index + 2, next)
      out += await evaluateReference(state, reference.body, {
        auto: env.auto,
        locals: env.locals,
        depth: env.depth + 1,
      })
      index = reference.end + 1
      continue
    }
    const variable = findVariable(state, next, env)
    out += variable === null ? '' : await resolveVariable(state, variable, env)
    index += 2
  }
  return out
}

const resolveVariable = async (
  state: MakeState,
  variable: Variable,
  env: ExpandEnv
): Promise<string> => {
  if (variable.flavor === 'simple') {
    return variable.value
  }
  return expandText(state, variable.value, env)
}

/** 展开 $(...) / ${...} 的内容：内置函数、替换引用、普通变量 */
const evaluateReference = async (
  state: MakeState,
  body: string,
  env: ExpandEnv
): Promise<string> => {
  const trimmed = body.trim()
  if (trimmed === '') {
    return ''
  }
  const word = firstWord(trimmed)
  if (FUNCTION_NAMES.has(word)) {
    return applyFunction(state, word, trimmed.slice(word.length).trim(), env)
  }
  if (word === 'call') {
    // $(call ...) 不支持：按契约原样输出，交给 shell 或调用方
    return `$(${body})`
  }
  const colon = findTopLevel(body, ':')
  if (colon >= 0) {
    const equals = findTopLevel(body, '=', colon + 1)
    if (equals > colon) {
      const name = body.slice(0, colon).trim()
      const from = body.slice(colon + 1, equals).trim()
      const to = body.slice(equals + 1).trim()
      const value = await lookupAndExpand(state, name, env)
      return splitWords(value)
        .map((item) => patternReplace(from, to, item) ?? item)
        .join(' ')
    }
  }
  return lookupAndExpand(state, trimmed, env)
}

/** 内置函数实现；参数按顶层逗号切分后逐个展开 */
const applyFunction = async (
  state: MakeState,
  name: string,
  argText: string,
  env: ExpandEnv
): Promise<string> => {
  const args = splitTopLevel(argText, ',')
  const arg = (index: number): string => (args[index] ?? '').trim()
  const expand = async (index: number): Promise<string> =>
    expandText(state, arg(index), { auto: env.auto, locals: env.locals, depth: env.depth + 1 })
  switch (name) {
    case 'wildcard': {
      const patterns = splitWords(await expand(0))
      return patterns.flatMap((pattern) => globRelative(state, pattern)).join(' ')
    }
    case 'patsubst': {
      const pattern = await expand(0)
      const replacement = await expand(1)
      const words = splitWords(await expand(2))
      return words.map((item) => patternReplace(pattern, replacement, item) ?? item).join(' ')
    }
    case 'subst': {
      const from = await expand(0)
      const to = await expand(1)
      const text = await expand(2)
      return from === '' ? text : text.split(from).join(to)
    }
    case 'notdir':
      return splitWords(await expand(0))
        .map((item) => baseName(item))
        .join(' ')
    case 'dir':
      return splitWords(await expand(0))
        .map(dirWithSlash)
        .join(' ')
    case 'basename':
      return splitWords(await expand(0))
        .map(fileBasename)
        .join(' ')
    case 'suffix':
      return splitWords(await expand(0))
        .map(fileSuffix)
        .join(' ')
    case 'addprefix': {
      const prefix = await expand(0)
      return splitWords(await expand(1))
        .map((item) => `${prefix}${item}`)
        .join(' ')
    }
    case 'addsuffix': {
      const suffix = await expand(0)
      return splitWords(await expand(1))
        .map((item) => `${item}${suffix}`)
        .join(' ')
    }
    case 'filter': {
      const patterns = splitWords(await expand(0))
      return splitWords(await expand(1))
        .filter((item) => patterns.some((pattern) => matchPattern(pattern, item) !== null))
        .join(' ')
    }
    case 'filter-out': {
      const patterns = splitWords(await expand(0))
      return splitWords(await expand(1))
        .filter((item) => !patterns.some((pattern) => matchPattern(pattern, item) !== null))
        .join(' ')
    }
    case 'sort': {
      const words = dedupe(splitWords(await expand(0)))
      return words.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)).join(' ')
    }
    case 'strip': {
      const text = await expand(0)
      return text.split(/\s+/).filter(Boolean).join(' ')
    }
    case 'firstword':
      return splitWords(await expand(0))[0] ?? ''
    case 'word': {
      const position = Number.parseInt(await expand(0), 10)
      const words = splitWords(await expand(1))
      if (!Number.isFinite(position) || position < 1) {
        return ''
      }
      return words[position - 1] ?? ''
    }
    case 'words':
      return String(splitWords(await expand(0)).length)
    case 'shell': {
      const command = (await expandText(state, argText, env)).trim()
      if (command === '') {
        return ''
      }
      const result = await runShellCommand(state, command)
      return normalizeShellStdout(result.stdout)
    }
    case 'foreach': {
      const loopName = arg(0)
      const words = splitWords(await expand(1))
      const body = args[2] ?? ''
      const parts: string[] = []
      for (const word of words) {
        const locals = new Map<string, string>(env.locals)
        locals.set(loopName, word)
        parts.push(await expandText(state, body, { auto: env.auto, locals, depth: env.depth + 1 }))
      }
      return parts.join(' ')
    }
    case 'if': {
      const condition = (await expand(0)).trim()
      return expandText(state, arg(condition === '' ? 2 : 1), {
        auto: env.auto,
        locals: env.locals,
        depth: env.depth + 1,
      })
    }
    case 'or': {
      for (const index of args.keys()) {
        const value = (await expand(index)).trim()
        if (value !== '') {
          return value
        }
      }
      return ''
    }
    case 'and': {
      let last = ''
      for (const index of args.keys()) {
        const value = (await expand(index)).trim()
        if (value === '') {
          return ''
        }
        last = value
      }
      return last
    }
    default:
      return ''
  }
}

// ---------- Makefile 解析 ----------

/** 规则行里第一个顶层冒号，跳过 $() 内部；找不到返回 -1 */
const findRuleColon = (text: string): number => findTopLevel(text, ':')

/** 拆 order-only：`normal | order-only` */
const splitOrderOnly = (text: string): { normal: string; orderOnly: string } => {
  const bar = findTopLevel(text, '|')
  if (bar < 0) {
    return { normal: text, orderOnly: '' }
  }
  return { normal: text.slice(0, bar), orderOnly: text.slice(bar + 1) }
}

/** 变量赋值：A = b / := / ?= / += / != / ::= */
const ASSIGNMENT_RE = /^([A-Za-z_.][A-Za-z0-9_.-]*)\s*(::=|:=|\?=|\+=|!=|=)\s*([\s\S]*)$/

/** export / unexport / override / private 前缀 */
const KEYWORD_RE = /^(export|unexport|override|private)\b/

/** include / -include / sinclude */
const INCLUDE_RE = /^(-include|sinclude|include)\s+([\s\S]*)$/

/** 把变量的值赋进去；exported 表示这次赋值同时要导出 */
const applyAssignment = async (
  state: MakeState,
  name: string,
  operator: string,
  rawValue: string,
  exported: boolean
): Promise<void> => {
  const value = rawValue.trim()
  if (name === '.DEFAULT_GOAL') {
    const expanded = value === '' ? '' : await expandText(state, value, BASE_ENV)
    state.defaultGoal = expanded.trim() === '' ? null : expanded.trim()
  }
  switch (operator) {
    case '=':
      state.vars.set(name, { value, flavor: 'recursive' })
      break
    case ':=':
    case '::=':
      state.vars.set(name, {
        value: await expandText(state, value, BASE_ENV),
        flavor: 'simple',
      })
      break
    case '?=': {
      if (findVariable(state, name, BASE_ENV) === null) {
        state.vars.set(name, { value, flavor: 'recursive' })
      }
      break
    }
    case '+=': {
      const existing = state.vars.get(name)
      if (existing === undefined) {
        state.vars.set(name, { value, flavor: 'recursive' })
        break
      }
      const addition =
        existing.flavor === 'simple' ? await expandText(state, value, BASE_ENV) : value
      existing.value = existing.value === '' ? addition : `${existing.value} ${addition}`
      break
    }
    case '!=': {
      const command = (await expandText(state, value, BASE_ENV)).trim()
      const output = command === '' ? '' : (await runShellCommand(state, command)).stdout
      state.vars.set(name, { value: normalizeShellStdout(output), flavor: 'simple' })
      break
    }
    default:
      break
  }
  if (exported) {
    state.exported.add(name)
  }
}

/** 注册规则：模式规则单独存，单冒号按目标合并，双冒号按目标追加 */
const registerRule = (state: MakeState, rule: Rule): void => {
  for (const target of rule.targets) {
    if (target === '') {
      continue
    }
    if (target.includes('%')) {
      state.patterns.push({ ...rule, targets: [target], isPattern: true })
      continue
    }
    if (state.firstGoal === null && !target.startsWith('.')) {
      state.firstGoal = target
    }
    const single: Rule = {
      ...rule,
      targets: [target],
      prereqs: [...rule.prereqs],
      orderOnly: [...rule.orderOnly],
    }
    if (rule.doubleColon) {
      const list = state.doubleRules.get(target) ?? []
      list.push(single)
      state.doubleRules.set(target, list)
      continue
    }
    const existing = state.rules.get(target)
    if (existing === undefined) {
      state.rules.set(target, single)
      continue
    }
    existing.prereqs.push(...single.prereqs)
    existing.orderOnly.push(...single.orderOnly)
    if (single.recipe.length > 0) {
      if (existing.recipe.length > 0) {
        state.io.stderr(
          `${rule.file}:${rule.line}: warning: overriding recipe for target '${target}'\n`
        )
      }
      existing.recipe = single.recipe
    }
  }
}

/** 解析一行非配方内容，返回应当继续接收配方行的规则（变量 / include 不打断配方） */
const parseLine = async (
  state: MakeState,
  content: string,
  file: string,
  line: number,
  depth: number,
  current: Rule | null
): Promise<Rule | null> => {
  // 1. export / unexport / override / private 前缀
  let rest = content
  let exportMode: 'none' | 'export' | 'unexport' = 'none'
  for (;;) {
    const keyword = KEYWORD_RE.exec(rest)
    if (keyword === null || keyword.index !== 0) {
      break
    }
    const word = keyword[1] ?? ''
    rest = rest.slice(keyword[0].length).trim()
    if (word === 'export') {
      exportMode = 'export'
    } else if (word === 'unexport') {
      exportMode = 'unexport'
    }
    if (rest === '') {
      // 单独的 export 表示「导出全部」，本实现不支持，忽略
      return current
    }
  }

  // 2. include / -include / sinclude（支持变量展开与多个文件）
  const includeMatch = INCLUDE_RE.exec(rest)
  if (includeMatch !== null) {
    const optional = (includeMatch[1] ?? '') !== 'include'
    const listText = await expandText(state, includeMatch[2] ?? '', BASE_ENV)
    for (const name of splitWords(listText)) {
      const target = resolvePath(state.curdir, name)
      const text = state.fs.isDirectory(target) ? null : state.fs.readText(target)
      if (text === null) {
        if (optional) {
          continue
        }
        state.io.stderr(`make: ${name}: No such file or directory\n`)
        throw new MakeAbort(`No rule to make target '${name}'.  Stop.`)
      }
      state.makefileList.push(name)
      await parseMakefile(state, text, name, depth + 1)
    }
    return current
  }

  // 3. 变量赋值
  const assignment = ASSIGNMENT_RE.exec(rest)
  if (assignment !== null) {
    const name = assignment[1] ?? ''
    const operator = assignment[2] ?? '='
    const value = assignment[3] ?? ''
    await applyAssignment(state, name, operator, value, exportMode === 'export')
    if (exportMode === 'unexport') {
      state.exported.delete(name)
    }
    return current
  }

  // 4. export A B / unexport A B（没有赋值的写法）
  if (exportMode !== 'none') {
    for (const name of splitWords(await expandText(state, rest, BASE_ENV))) {
      if (exportMode === 'export') {
        state.exported.add(name)
      } else {
        state.exported.delete(name)
      }
    }
    return current
  }

  // 5. 规则
  const colon = findRuleColon(rest)
  if (colon < 0) {
    throw new MakeAbort(`${file}:${line}: *** missing separator.  Stop.`, 2, true)
  }
  const doubleColon = rest[colon + 1] === ':'
  const targetsText = rest.slice(0, colon).trim()
  const prereqText = rest.slice(colon + (doubleColon ? 2 : 1)).trim()
  if (targetsText === '') {
    throw new MakeAbort(`${file}:${line}: *** missing separator.  Stop.`, 2, true)
  }
  const targets = expandWildcards(state, splitWords(await expandText(state, targetsText, BASE_ENV)))
  const split = splitOrderOnly(prereqText)
  const prereqs = expandWildcards(
    state,
    splitWords(await expandText(state, split.normal, BASE_ENV))
  )
  const orderOnly = expandWildcards(
    state,
    splitWords(await expandText(state, split.orderOnly, BASE_ENV))
  )
  const rule: Rule = {
    targets,
    prereqs,
    orderOnly,
    recipe: [],
    doubleColon,
    isPattern: targets.some((target) => target.includes('%')),
    file,
    line,
  }

  // 特殊目标
  if (targets.includes('.PHONY')) {
    for (const name of prereqs) {
      state.phony.add(name)
    }
    return rule
  }
  if (targets.includes('.SUFFIXES')) {
    state.suffixes = [...prereqs]
    return rule
  }
  if (targets.includes('.DEFAULT_GOAL')) {
    return rule
  }
  registerRule(state, rule)
  return rule
}

/** 读一个 Makefile：处理配方行、续行、注释与各类指令 */
const parseMakefile = async (
  state: MakeState,
  text: string,
  file: string,
  depth: number
): Promise<void> => {
  if (depth > MAX_INCLUDE_DEPTH) {
    state.io.stderr(`make: include 嵌套过深，已忽略 ${file}\n`)
    return
  }
  const lines = text.split('\n')
  let current: Rule | null = null
  let index = 0
  while (index < lines.length) {
    const raw = stripCR(lines[index] ?? '')
    const lineNumber = index + 1

    // 配方行：必须 TAB 开头
    if (raw.startsWith('\t')) {
      if (current === null) {
        throw new MakeAbort(
          `${file}:${lineNumber}: *** recipe commences before first target.  Stop.`,
          2,
          true
        )
      }
      let body = raw.slice(1)
      // 配方续行：行尾反斜杠与下一行拼起来，下一行的前导 TAB 去掉
      while (/\\\s*$/.test(body) && index + 1 < lines.length) {
        body = body.replace(/\\\s*$/, '')
        index += 1
        body += stripCR(lines[index] ?? '').replace(/^[ \t]+/, '')
      }
      current.recipe.push({ text: body, line: lineNumber, file })
      index += 1
      continue
    }

    // 非配方行：先把反斜杠续行合并成一行（GNU 在这里填一个空格）
    let joined = raw
    while (/\\\s*$/.test(joined) && index + 1 < lines.length) {
      joined = joined.replace(/\\\s*$/, '')
      index += 1
      joined += ` ${stripCR(lines[index] ?? '').trimStart()}`
    }
    index += 1

    const content = stripComment(joined).trim()
    if (content === '') {
      // 空行结束配方；纯注释行不结束
      if (raw.trim() === '') {
        current = null
      }
      continue
    }
    current = await parseLine(state, content, file, lineNumber, depth, current)
  }
}

// ---------- 构建 ----------

/** 一条规则在具体目标上的实例（模式规则的 % 已经替换成 stem） */
type CompiledRule = {
  recipe: RecipeLine[]
  normal: string[]
  orderOnly: string[]
  stem: string
}

type BuildOutcome = {
  status: 'updated' | 'unchanged' | 'skipped' | 'failed'
  /** 目标自身或子树是否真的重建过 */
  rebuilt: boolean
}

/** 展开后的单行配方前缀 */
type RecipePrefix = {
  command: string
  silent: boolean
  ignore: boolean
  force: boolean
}

/** 解析配方行前缀：@ 静默、- 忽略错误、+ 强制执行（-n 下也跑） */
const parseRecipePrefix = (text: string): RecipePrefix => {
  let index = 0
  let silent = false
  let ignore = false
  let force = false
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === '@') {
      silent = true
    } else if (char === '-') {
      ignore = true
    } else if (char === '+') {
      force = true
    } else {
      break
    }
    index += 1
  }
  return { command: text.slice(index).trim(), silent, ignore, force }
}

/** 显式目标里 $* 的取值：按 .SUFFIXES（缺省时任意后缀）去掉后缀 */
const defaultStem = (state: MakeState, name: string): string => {
  const base = baseName(name)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) {
    return ''
  }
  const suffix = base.slice(dot)
  if (state.suffixes.length === 0 || state.suffixes.includes(suffix)) {
    return base.slice(0, dot)
  }
  return ''
}

/** 自动变量表：$@ $< $^ $? $* $+ 以及它们的 D / F 变体 */
const autoVariables = (
  target: string,
  prereqs: string[],
  stem: string,
  newer: string[]
): Record<string, string> => {
  const auto: Record<string, string> = {
    '@': target,
    '<': prereqs[0] ?? '',
    '^': dedupe(prereqs).join(' '),
    '+': prereqs.join(' '),
    '?': newer.join(' '),
    '*': stem,
  }
  for (const key of ['@', '<', '^', '*']) {
    const value = auto[key] ?? ''
    auto[`${key}D`] = splitWords(value).map(dirPart).join(' ')
    auto[`${key}F`] = splitWords(value)
      .map((word) => baseName(word))
      .join(' ')
  }
  return auto
}

const compileRule = (rule: Rule, stem: string): CompiledRule => ({
  recipe: rule.recipe,
  normal: rule.isPattern ? rule.prereqs.map((item) => replacePercent(item, stem)) : rule.prereqs,
  orderOnly: rule.isPattern
    ? rule.orderOnly.map((item) => replacePercent(item, stem))
    : rule.orderOnly,
  stem,
})

/** 找可用的模式规则：按出现顺序取第一条匹配的 */
const findPatternRule = (state: MakeState, name: string): { rule: Rule; stem: string } | null => {
  for (const rule of state.patterns) {
    for (const pattern of rule.targets) {
      const stem = matchPattern(pattern, name)
      if (stem !== null) {
        return { rule, stem }
      }
    }
  }
  return null
}

/** 构建器：负责目标决策、递归依赖与配方执行 */
class MakeExecutor {
  private readonly state: MakeState
  private readonly goals: string[]
  private readonly results = new Map<string, BuildOutcome>()
  private shellEnv: Record<string, string> | null = null

  constructor(state: MakeState, goals: string[]) {
    this.state = state
    this.goals = goals
  }

  /** 依次构建命令行给出的目标，返回退出码 */
  async run(): Promise<number> {
    this.assertNotAborted()
    let exitCode = 0
    for (const goal of this.goals) {
      this.assertNotAborted()
      const outcome = await this.build(goal, null, [])
      if (outcome.status === 'failed') {
        exitCode = 2
        this.state.io.stderr(`make: Target '${goal}' not remade because of errors.\n`)
        continue
      }
      if (outcome.rebuilt) {
        continue
      }
      const stat = this.statOf(goal)
      const phony = this.state.phony.has(goal)
      if (stat !== null && stat.kind === 'file' && !phony) {
        this.state.io.stdout(`make: '${goal}' is up to date.\n`)
      } else {
        this.state.io.stdout(`make: Nothing to be done for '${goal}'.\n`)
      }
    }
    return exitCode
  }

  private assertNotAborted(): void {
    if (this.state.io.signal?.aborted) {
      throw new MakeAbort('Interrupt.', 130)
    }
  }

  private statOf(name: string): ReturnType<NanovmFS['stat']> {
    return this.state.fs.stat(resolvePath(this.state.curdir, name))
  }

  /** 目标对应的规则实例；没有规则返回空数组 */
  private planFor(name: string): CompiledRule[] {
    const explicit = this.state.rules.get(name)
    if (explicit !== undefined) {
      if (explicit.recipe.length > 0) {
        return [compileRule(explicit, defaultStem(this.state, name))]
      }
      // 显式规则只给了依赖、没给配方时，借用模式规则的配方与依赖（GNU 的隐式规则查找）
      const borrowed = findPatternRule(this.state, name)
      if (borrowed !== null) {
        const pattern = compileRule(borrowed.rule, borrowed.stem)
        return [
          {
            recipe: pattern.recipe,
            normal: [...explicit.prereqs, ...pattern.normal],
            orderOnly: [...explicit.orderOnly, ...pattern.orderOnly],
            stem: borrowed.stem,
          },
        ]
      }
      return [compileRule(explicit, defaultStem(this.state, name))]
    }
    const doubles = this.state.doubleRules.get(name)
    if (doubles !== undefined) {
      return doubles.map((rule) => compileRule(rule, defaultStem(this.state, name)))
    }
    const matched = findPatternRule(this.state, name)
    if (matched !== null) {
      return [compileRule(matched.rule, matched.stem)]
    }
    return []
  }

  /** 依次构建依赖；-k 时某个依赖失败也继续构建后面的依赖 */
  private async buildPrerequisites(
    prereqs: string[],
    name: string,
    chain: string[]
  ): Promise<{ failed: boolean; rebuilt: boolean }> {
    let failed = false
    let rebuilt = false
    for (const prereq of prereqs) {
      const outcome = await this.build(prereq, name, chain)
      if (outcome.status === 'failed') {
        failed = true
        if (!this.state.options.keepGoing) {
          break
        }
        continue
      }
      if (outcome.rebuilt) {
        rebuilt = true
      }
    }
    return { failed, rebuilt }
  }

  /** 递归构建一个目标 */
  private async build(name: string, parent: string | null, chain: string[]): Promise<BuildOutcome> {
    this.assertNotAborted()
    const cached = this.results.get(name)
    if (cached !== undefined) {
      return cached
    }
    if (chain.includes(name)) {
      const dependent = chain[chain.length - 1] ?? name
      this.state.io.stderr(`make: Circular ${name} <- ${dependent} dependency dropped.\n`)
      return { status: 'skipped', rebuilt: false }
    }
    const plans = this.planFor(name)
    if (plans.length === 0) {
      const stat = this.statOf(name)
      if ((stat !== null && stat.kind === 'file') || this.state.phony.has(name)) {
        const outcome: BuildOutcome = { status: 'unchanged', rebuilt: false }
        this.results.set(name, outcome)
        return outcome
      }
      const neededBy = parent === null ? '' : `, needed by '${parent}'`
      throw new MakeAbort(`No rule to make target '${name}'${neededBy}.  Stop.`)
    }

    const nextChain = [...chain, name]
    let rebuilt = false
    let failed = false
    for (const plan of plans) {
      const orderResult = await this.buildPrerequisites(plan.orderOnly, name, nextChain)
      if (orderResult.failed) {
        failed = true
        break
      }
      const prereqResult = await this.buildPrerequisites(plan.normal, name, nextChain)
      if (prereqResult.failed) {
        failed = true
        break
      }
      if (prereqResult.rebuilt) {
        rebuilt = true
      }
      const targetStat = this.statOf(name)
      const phony = this.state.phony.has(name)
      const newer = plan.normal.filter((prereq) => {
        const stat = this.statOf(prereq)
        if (stat === null) {
          // 依赖没有对应文件（phony / 聚合目标）：每次都重建
          return true
        }
        if (targetStat === null) {
          return true
        }
        return stat.mtime > targetStat.mtime
      })
      const needsBuild = this.state.options.alwaysMake || phony || targetStat === null
      if (!needsBuild && newer.length === 0) {
        continue
      }
      if (plan.recipe.length === 0) {
        continue
      }
      const result = await this.executeRecipe(name, plan, newer)
      if (result === 'failed') {
        failed = true
        break
      }
      rebuilt = true
    }
    const status = failed ? 'failed' : rebuilt ? 'updated' : 'unchanged'
    const outcome: BuildOutcome = { status, rebuilt }
    this.results.set(name, outcome)
    return outcome
  }

  /** 逐行执行配方；返回 failed 表示 -k 下要继续构建其它目标 */
  private async executeRecipe(
    name: string,
    plan: CompiledRule,
    newer: string[]
  ): Promise<'ok' | 'failed'> {
    const auto = autoVariables(name, plan.normal, plan.stem, newer)
    const env = await this.environment()
    for (const line of plan.recipe) {
      this.assertNotAborted()
      const text = await expandText(this.state, line.text, { auto, depth: 0 })
      const parsed = parseRecipePrefix(text)
      if (parsed.command === '') {
        continue
      }
      const quiet = parsed.silent || this.state.options.silent
      if (!quiet) {
        this.state.io.stdout(`${parsed.command}\n`)
      }
      if (this.state.options.dryRun && !parsed.force) {
        continue
      }
      const result = await this.state.shell.run(parsed.command, {
        cwd: this.state.curdir,
        env,
        silent: true,
      })
      if (result.aborted) {
        throw new MakeAbort('Interrupt.', 130)
      }
      // shell.run 的输出走返回值收集，这里统一写进 make 自己的输出缓冲
      this.state.io.stdout(result.stdout)
      this.state.io.stderr(result.stderr)
      if (result.code !== 0 && !parsed.ignore) {
        this.state.io.stderr(`make: *** [${name}:${line.line}] Error ${result.code}\n`)
        if (this.state.options.keepGoing) {
          return 'failed'
        }
        throw new MakeAbort('', 2, true)
      }
    }
    return 'ok'
  }

  private async environment(): Promise<Record<string, string>> {
    if (this.shellEnv === null) {
      this.shellEnv = await makeShellEnv(this.state)
    }
    return this.shellEnv
  }
}

// ---------- 命令行 ----------

type ParsedCommandLine = {
  options: MakeOptions
  makefiles: string[]
  chdirs: string[]
  goals: string[]
  parallel: boolean
  help: boolean
  version: boolean
}

const parseArgs = (argv: string[]): ParsedCommandLine => {
  const options: MakeOptions = {
    alwaysMake: false,
    dryRun: false,
    silent: false,
    keepGoing: false,
    envOverride: false,
  }
  const makefiles: string[] = []
  const chdirs: string[] = []
  const goals: string[] = []
  let parallel = false
  let help = false
  let version = false
  let index = 0

  const takeValue = (option: string): string => {
    index += 1
    const value = argv[index]
    if (value === undefined) {
      throw new MakeAbort(`make: option requires an argument -- '${option}'`, 2, true)
    }
    return value
  }

  while (index < argv.length) {
    const arg = argv[index] ?? ''
    if (arg === '--') {
      goals.push(...argv.slice(index + 1))
      break
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const equals = body.indexOf('=')
      const name = equals >= 0 ? body.slice(0, equals) : body
      const attached = equals >= 0 ? body.slice(equals + 1) : null
      const value = (): string => attached ?? takeValue(name)
      switch (name) {
        case 'help':
          help = true
          break
        case 'version':
          version = true
          break
        case 'just-print':
        case 'dry-run':
        case 'recon':
          options.dryRun = true
          break
        case 'always-make':
          options.alwaysMake = true
          break
        case 'silent':
        case 'quiet':
          options.silent = true
          break
        case 'keep-going':
          options.keepGoing = true
          break
        case 'no-print-directory':
          break
        case 'file':
        case 'makefile':
        case 'fragment':
          makefiles.push(value())
          break
        case 'directory':
          chdirs.push(value())
          break
        case 'jobs':
          parallel = true
          break
        default:
          throw new MakeAbort(`make: unrecognized option '${arg}'`, 2, true)
      }
      index += 1
      continue
    }
    if (arg.length > 1 && arg.startsWith('-')) {
      let cursor = 1
      while (cursor < arg.length) {
        const flag = arg[cursor] ?? ''
        cursor += 1
        switch (flag) {
          case 'n':
            options.dryRun = true
            break
          case 'B':
            options.alwaysMake = true
            break
          case 's':
            options.silent = true
            break
          case 'k':
            options.keepGoing = true
            break
          case 'e':
            options.envOverride = true
            break
          case 'h':
            help = true
            break
          case 'v':
            version = true
            break
          case 'f': {
            const rest = arg.slice(cursor)
            if (rest !== '') {
              makefiles.push(rest)
              cursor = arg.length
            } else {
              makefiles.push(takeValue('f'))
            }
            break
          }
          case 'C': {
            const rest = arg.slice(cursor)
            if (rest !== '') {
              chdirs.push(rest)
              cursor = arg.length
            } else {
              chdirs.push(takeValue('C'))
            }
            break
          }
          case 'j':
            // -jN：并行不支持，只记一次警告，后面按串行跑
            parallel = true
            cursor = arg.length
            break
          default:
            throw new MakeAbort(`make: invalid option -- '${flag}'`, 2, true)
        }
      }
      index += 1
      continue
    }
    goals.push(arg)
    index += 1
  }

  return { options, makefiles, chdirs, goals, parallel, help, version }
}

/** -C 逐层切换目录，返回最终工作目录 */
const applyChdirs = (io: MakeIO, dirs: string[]): string => {
  let cwd = io.cwd
  for (const dir of dirs) {
    const next = resolvePath(cwd, dir)
    if (!io.fs.isDirectory(next)) {
      throw new MakeAbort(`${dir}: No such file or directory.  Stop.`)
    }
    cwd = next
  }
  return cwd
}

/** 按 -f / 默认顺序找 Makefile，返回名字（相对 cwd） */
const locateMakefile = (io: MakeIO, cwd: string, candidates: string[]): string => {
  const names = candidates.length > 0 ? candidates : DEFAULT_MAKEFILES
  for (const name of names) {
    const target = resolvePath(cwd, name)
    if (io.fs.exists(target) && !io.fs.isDirectory(target)) {
      return name
    }
  }
  if (candidates.length > 0) {
    for (const name of candidates) {
      io.stderr(`make: ${name}: No such file or directory\n`)
    }
    throw new MakeAbort(`No rule to make target '${candidates[0] ?? 'Makefile'}'.  Stop.`)
  }
  throw new MakeAbort('No targets specified and no makefile found.  Stop.')
}

/** MAKEFLAGS 的值：只放开关字母，目标放在 MAKECMDGOALS 里 */
const buildFlags = (options: MakeOptions): string => {
  let letters = ''
  if (options.alwaysMake) {
    letters += 'B'
  }
  if (options.dryRun) {
    letters += 'n'
  }
  if (options.silent) {
    letters += 's'
  }
  if (options.keepGoing) {
    letters += 'k'
  }
  if (options.envOverride) {
    letters += 'e'
  }
  return letters === '' ? '' : `-${letters}`
}

const createState = (io: MakeIO, cwd: string, parsed: ParsedCommandLine): MakeState => ({
  vars: new Map<string, Variable>(),
  exported: new Set<string>(),
  rules: new Map<string, Rule>(),
  doubleRules: new Map<string, Rule[]>(),
  patterns: [],
  phony: new Set<string>(),
  suffixes: [],
  makefileList: [],
  defaultGoal: null,
  firstGoal: null,
  cmdGoals: [],
  flags: buildFlags(parsed.options),
  env: io.env,
  fs: io.fs,
  shell: io.shell,
  io,
  curdir: cwd,
  options: parsed.options,
})

/** 没给目标时用 .DEFAULT_GOAL，其次第一个普通目标 */
const resolveDefaultGoal = (state: MakeState): string[] => {
  const goal = state.defaultGoal ?? state.firstGoal
  return goal === null ? [] : [goal]
}

const runMakeInner = async (argv: string[], io: MakeIO): Promise<number> => {
  const parsed = parseArgs(argv)
  if (parsed.help) {
    io.stdout(HELP_TEXT)
    return 0
  }
  if (parsed.version) {
    io.stdout('GNU make 4.x (NanoVM 内置)\n')
    return 0
  }
  if (parsed.parallel) {
    io.stderr('make: 不支持并行构建（-j），已按串行执行\n')
  }
  if (io.signal?.aborted) {
    io.stderr('make: *** Interrupt.\n')
    return 130
  }
  const cwd = applyChdirs(io, parsed.chdirs)
  const makefile = locateMakefile(io, cwd, parsed.makefiles)
  const state = createState(io, cwd, parsed)
  const text = io.fs.readText(resolvePath(cwd, makefile)) ?? ''
  state.makefileList.push(makefile)
  await parseMakefile(state, text, makefile, 0)
  const goals = parsed.goals.length > 0 ? parsed.goals : resolveDefaultGoal(state)
  if (goals.length === 0) {
    throw new MakeAbort('No targets.  Stop.')
  }
  state.cmdGoals = goals
  return new MakeExecutor(state, goals).run()
}

/** GNU make 兼容的构建器：Makefile 解析与配方执行 */
export const runMake = async (argv: string[], io: MakeIO): Promise<number> => {
  try {
    return await runMakeInner(argv, io)
  } catch (error) {
    if (error instanceof MakeAbort) {
      if (error.message !== '') {
        io.stderr(error.formatted ? `${error.message}\n` : `make: *** ${error.message}\n`)
      }
      return error.code
    }
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`make: ${message}\n`)
    return 1
  }
}
