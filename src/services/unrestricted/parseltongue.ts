/**
 * Parseltongue 输入扰动引擎，移植自 G0DM0D3（elder-plinius/G0DM0D3，AGPL-3.0）。
 * 本地改动：补充中文触发词、按字符集选择边界匹配、新增全角与细空格两种变换。
 */

/**
 * Parseltongue - Input Obfuscation Engine
 * Detects trigger words likely to cause model refusals and applies
 * obfuscation techniques to bypass content filters.
 *
 * Techniques:
 * - Leetspeak (1337): a→4, e→3, i→1, o→0, etc.
 * - Unicode homoglyphs: a→а (cyrillic), e→е, etc.
 * - Zero-width joiners: invisible characters between letters
 * - Mixed case disruption: alternating caps
 * - Phonetic substitution: replacing with phonetically similar words
 */

import {
  TECHNIQUES,
  TIER_SIZES,
  techniquesForTier,
  type TechniqueName,
  type VariantTier,
} from './techniques.js'

/**
 * 单个技术：`techniques.ts` 里的 33 种（单文件应用能力）+ 本地扩展的 spacing / phonetic / random。
 * 单技术模式沿用下面的强度实现；变体模式直接用上游的逐词函数。
 */
export type ObfuscationTechnique = TechniqueName | 'spacing' | 'phonetic' | 'random'

export interface ParseltongueConfig {
  enabled: boolean
  technique: ObfuscationTechnique
  intensity: 'light' | 'medium' | 'heavy' // how many characters to transform
  customTriggers: string[] // user-defined trigger words
}

export interface ParseltongueResult {
  originalText: string
  transformedText: string
  triggersFound: string[]
  techniqueUsed: ObfuscationTechnique
  transformations: Array<{
    original: string
    transformed: string
    technique: ObfuscationTechnique
  }>
}

// Common trigger words/phrases that often cause refusals
// These are words that models tend to flag, not inherently bad content
const DEFAULT_TRIGGERS: string[] = [
  // Action words
  'hack',
  'exploit',
  'bypass',
  'crack',
  'break',
  'attack',
  'penetrate',
  'inject',
  'manipulate',
  'override',
  'disable',
  'circumvent',
  'evade',

  // Security terms
  'malware',
  'virus',
  'trojan',
  'payload',
  'shellcode',
  'rootkit',
  'keylogger',
  'backdoor',
  'vulnerability',
  'exploit',

  // Sensitive topics
  'weapon',
  'bomb',
  'explosive',
  'poison',
  'drug',
  'synthesize',

  // System terms
  'jailbreak',
  'unlock',
  'root',
  'sudo',
  'admin',
  'privilege',

  // Social engineering
  'phishing',
  'scam',
  'impersonate',
  'deceive',
  'fraud',

  // Content flags
  'nsfw',
  'explicit',
  'uncensored',
  'unfiltered',
  'unrestricted',

  // AI-specific
  'ignore',
  'disregard',
  'forget',
  'pretend',
  'roleplay',
  'character',
  'act as',
  'you are now',
  'new identity',
]

// 中文触发词：按「模型更容易标记」的常见表述收集，全部为两字及以上的具体词，避免误伤正常用词。
// 中文没有词边界，检测走子串匹配；拉丁字母触发词仍走 \b 边界。
const ZH_TRIGGERS: string[] = [
  // 内容与越狱
  '越狱',
  '破限',
  '解除限制',
  '绕过限制',
  '绕过审核',
  '绕过安全',
  '忽略以上',
  '忽略之前',
  '无视规则',
  '提示词注入',
  '角色扮演',
  '不受限制',
  '无审查',
  '去审查',
  // 网络安全
  '黑客',
  '入侵',
  '渗透',
  '提权',
  '木马',
  '病毒',
  '勒索',
  '后门',
  '键盘记录',
  '免杀',
  '撞库',
  '拖库',
  '钓鱼',
  '钓鱼网站',
  '漏洞利用',
  '弱口令',
  '爆破密码',
  '内网渗透',
  '反向连接',
  '反弹shell',
  '注入攻击',
  '拒绝服务',
  '分布式拒绝服务',
  // 危险物
  '炸弹',
  '制作炸弹',
  '爆炸物',
  '炸药',
  '雷管',
  '枪支',
  '自制枪',
  '武器',
  '军火',
  '化学武器',
  '生物武器',
  '神经毒剂',
  '沙林',
  '蓖麻毒素',
  '毒药',
  '剧毒',
  '投毒',
  // 药物
  '合成毒品',
  '冰毒',
  '海洛因',
  '芬太尼',
  '摇头丸',
  '制毒',
  '贩毒',
  '走私',
  // 犯罪
  '洗钱',
  '诈骗',
  '电信诈骗',
  '伪造证件',
  '假钞',
  '伪造货币',
  '信用卡盗刷',
  '绑架',
  '谋杀',
  '分尸',
  '虐杀',
  '人口贩卖',
  '器官贩卖',
  '盗窃',
  // 自我伤害与未成年人相关
  '自杀方法',
  '自残',
  '自伤',
]

// Leetspeak mappings (multiple options per character)
const LEET_MAP: Record<string, string[]> = {
  a: ['4', '@', '∂', 'λ'],
  b: ['8', '|3', 'ß', '13'],
  c: ['(', '<', '¢', '©'],
  d: ['|)', '|>', 'đ'],
  e: ['3', '€', '£', '∑'],
  f: ['|=', 'ƒ', 'ph'],
  g: ['9', '6', '&'],
  h: ['#', '|-|', '}{'],
  i: ['1', '!', '|', '¡'],
  j: ['_|', ']', '¿'],
  k: ['|<', '|{', 'κ'],
  l: ['1', '|', '£', '|_'],
  m: ['|V|', '/\\/\\', 'µ'],
  n: ['|\\|', '/\\/', 'η'],
  o: ['0', '()', '°', 'ø'],
  p: ['|*', '|>', 'þ'],
  q: ['0_', '()_', 'ℚ'],
  r: ['|2', '®', '12'],
  s: ['5', '$', '§', '∫'],
  t: ['7', '+', '†', '⊤'],
  u: ['|_|', 'µ', 'ü'],
  v: ['\\/', '√'],
  w: ['\\/\\/', 'vv', 'ω'],
  x: ['><', '×', '}{'],
  y: ['`/', '¥', 'γ'],
  z: ['2', '7_', 'ℤ'],
}

// Unicode homoglyphs (visually similar but different Unicode codepoints)
const UNICODE_HOMOGLYPHS: Record<string, string[]> = {
  a: ['а', 'ɑ', 'α', 'ａ'], // cyrillic а, latin alpha, etc.
  b: ['Ь', 'ｂ', 'ḅ'],
  c: ['с', 'ϲ', 'ⅽ', 'ｃ'], // cyrillic с
  d: ['ԁ', 'ⅾ', 'ｄ'],
  e: ['е', 'ė', 'ẹ', 'ｅ'], // cyrillic е
  f: ['ƒ', 'ｆ'],
  g: ['ɡ', 'ｇ'],
  h: ['һ', 'ḥ', 'ｈ'], // cyrillic һ
  i: ['і', 'ι', 'ｉ'], // cyrillic і, greek iota
  j: ['ϳ', 'ｊ'],
  k: ['κ', 'ｋ'],
  l: ['ӏ', 'ⅼ', 'ｌ'], // cyrillic palochka
  m: ['м', 'ｍ'],
  n: ['ո', 'ｎ'],
  o: ['о', 'ο', 'ｏ'], // cyrillic о, greek omicron
  p: ['р', 'ρ', 'ｐ'], // cyrillic р, greek rho
  s: ['ѕ', 'ｓ'], // cyrillic ѕ
  t: ['τ', 'ｔ'],
  u: ['υ', 'ｕ'],
  v: ['ν', 'ｖ'], // greek nu
  w: ['ѡ', 'ｗ'],
  x: ['х', 'ｘ'], // cyrillic х
  y: ['у', 'γ', 'ｙ'], // cyrillic у
  z: ['ᴢ', 'ｚ'],
}

// Zero-width characters for invisible insertion
const ZW_CHARS = [
  '\u200B', // Zero-width space
  '\u200C', // Zero-width non-joiner
  '\u200D', // Zero-width joiner
  '\uFEFF', // Zero-width no-break space
]

/**
 * Apply leetspeak transformation to a word
 */
function applyLeetspeak(word: string, intensity: 'light' | 'medium' | 'heavy'): string {
  const chars = word.split('')
  const transformCount =
    intensity === 'light' ? 1 : intensity === 'medium' ? Math.ceil(chars.length / 2) : chars.length

  // Get indices to transform (spread throughout the word)
  const indices: number[] = []
  const step = Math.max(1, Math.floor(chars.length / transformCount))
  for (let i = 0; i < chars.length && indices.length < transformCount; i += step) {
    if (LEET_MAP[chars[i].toLowerCase()]) {
      indices.push(i)
    }
  }

  // If we didn't get enough, grab any remaining transformable chars
  if (indices.length < transformCount) {
    for (let i = 0; i < chars.length && indices.length < transformCount; i++) {
      if (!indices.includes(i) && LEET_MAP[chars[i].toLowerCase()]) {
        indices.push(i)
      }
    }
  }

  // Apply transformations
  for (const i of indices) {
    const char = chars[i].toLowerCase()
    if (LEET_MAP[char]) {
      const options = LEET_MAP[char]
      chars[i] = options[Math.floor(Math.random() * options.length)]
    }
  }

  return chars.join('')
}

/**
 * Apply unicode homoglyph transformation
 */
function applyUnicode(word: string, intensity: 'light' | 'medium' | 'heavy'): string {
  const chars = word.split('')
  const transformCount =
    intensity === 'light' ? 1 : intensity === 'medium' ? Math.ceil(chars.length / 2) : chars.length

  const indices: number[] = []
  for (let i = 0; i < chars.length && indices.length < transformCount; i++) {
    if (UNICODE_HOMOGLYPHS[chars[i].toLowerCase()]) {
      indices.push(i)
    }
  }

  for (const i of indices) {
    const char = chars[i].toLowerCase()
    if (UNICODE_HOMOGLYPHS[char]) {
      const options = UNICODE_HOMOGLYPHS[char]
      const replacement = options[Math.floor(Math.random() * options.length)]
      // Preserve case
      chars[i] = chars[i] === chars[i].toUpperCase() ? replacement.toUpperCase() : replacement
    }
  }

  return chars.join('')
}

/**
 * Insert zero-width characters between letters
 */
function applyZWJ(word: string, intensity: 'light' | 'medium' | 'heavy'): string {
  const chars = word.split('')
  const insertCount =
    intensity === 'light'
      ? 1
      : intensity === 'medium'
        ? Math.ceil(chars.length / 2)
        : chars.length - 1

  const result: string[] = []
  let insertions = 0

  for (let i = 0; i < chars.length; i++) {
    result.push(chars[i])
    if (i < chars.length - 1 && insertions < insertCount) {
      const zwChar = ZW_CHARS[Math.floor(Math.random() * ZW_CHARS.length)]
      result.push(zwChar)
      insertions++
    }
  }

  return result.join('')
}

/**
 * Apply mixed case disruption
 */
function applyMixedCase(word: string, intensity: 'light' | 'medium' | 'heavy'): string {
  const chars = word.split('')

  if (intensity === 'light') {
    // Just capitalize one random letter
    const idx = Math.floor(Math.random() * chars.length)
    chars[idx] = chars[idx].toUpperCase()
  } else if (intensity === 'medium') {
    // Alternating case
    for (let i = 0; i < chars.length; i++) {
      chars[i] = i % 2 === 0 ? chars[i].toLowerCase() : chars[i].toUpperCase()
    }
  } else {
    // Random case
    for (let i = 0; i < chars.length; i++) {
      chars[i] = Math.random() > 0.5 ? chars[i].toUpperCase() : chars[i].toLowerCase()
    }
  }

  return chars.join('')
}

/**
 * Apply phonetic substitution
 */
function applyPhonetic(word: string): string {
  // Common phonetic substitutions
  const substitutions: [RegExp, string][] = [
    [/ph/gi, 'f'],
    [/ck/gi, 'k'],
    [/x/gi, 'ks'],
    [/qu/gi, 'kw'],
    [/c(?=[eiy])/gi, 's'], // soft c
    [/c/gi, 'k'], // hard c
  ]

  let result = word
  for (const [pattern, replacement] of substitutions) {
    result = result.replace(pattern, replacement)
  }

  return result
}

/**
 * 全角替换：ASCII 可见字符整体平移到全角区，中文与其它字符保持原样。
 * 对中英混排的触发词最稳定，模型仍能读出语义，但常见正则与关键词表会漏匹配。
 */
function applyFullwidth(word: string): string {
  return word
    .replace(/[!-~]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0))
    .replace(/ /g, '\u3000')
}

/**
 * 细空格插入：在字符之间插入 U+2009，中文与拉丁字母都适用。
 * light 只拆第一处，medium 隔一个拆一处，heavy 全部拆开。
 */
function applySpacing(word: string, intensity: 'light' | 'medium' | 'heavy'): string {
  const chars = [...word]
  if (chars.length < 2) {
    return word
  }
  if (intensity === 'light') {
    return `${chars[0]}\u2009${chars.slice(1).join('')}`
  }
  const step = intensity === 'medium' ? 2 : 1
  return chars
    .map((char, index) => (index < chars.length - 1 && index % step === 0 ? `${char}\u2009` : char))
    .join('')
}

/**
 * Apply a random mix of techniques
 */
function applyRandom(word: string, intensity: 'light' | 'medium' | 'heavy'): string {
  const techniques = [applyLeetspeak, applyUnicode, applyZWJ, applyMixedCase, applyFullwidth]
  const technique = techniques[Math.floor(Math.random() * techniques.length)]
  return technique(word, intensity)
}

/**
 * Main obfuscation function for a single word
 */
function obfuscateWord(
  word: string,
  technique: ObfuscationTechnique,
  intensity: 'light' | 'medium' | 'heavy'
): string {
  const transform = (): string => {
    switch (technique) {
      case 'leetspeak':
        return applyLeetspeak(word, intensity)
      case 'unicode':
        return applyUnicode(word, intensity)
      case 'zwj':
        return applyZWJ(word, intensity)
      case 'mixedcase':
        return applyMixedCase(word, intensity)
      case 'phonetic':
        return applyPhonetic(word)
      case 'fullwidth':
        // 纯中文触发词没有 ASCII 可平移，退化为细空格，避免出现「选了技术却没有变化」
        return /[!-~]/.test(word) ? applyFullwidth(word) : applySpacing(word, intensity)
      case 'spacing':
        return applySpacing(word, intensity)
      case 'random':
        return applyRandom(word, intensity)
      default: {
        // 33 种上游技术：逐词函数直接来自 techniques.ts
        const entry = TECHNIQUES[technique]
        return entry ? entry.apply(word) : word
      }
    }
  }

  const transformed = transform()
  // leetspeak / unicode / mixedcase 等只改拉丁字母的算法遇到纯中文会原样返回；
  // 这里统一退化为细空格，保证任何命中触发词的预览都能看到变化。
  if (transformed === word && [...word].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)) {
    return applySpacing(word, intensity)
  }
  return transformed
}

/**
 * Find all trigger words in the input text
 */
/** 触发词只由 ASCII 可见字符组成时按词边界匹配；中文等其余触发词按子串匹配。 */
const isLatinTrigger = (trigger: string): boolean => /^[\x20-\x7e]+$/.test(trigger)

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 把文本里命中的触发词逐个交给变换函数，返回替换后的文本 */
const replaceWith = (
  text: string,
  trigger: string,
  transform: (match: string) => string
): string => {
  if (isLatinTrigger(trigger)) {
    return text.replace(new RegExp(`\\b${escapeRegExp(trigger)}\\b`, 'gi'), transform)
  }
  return text.replaceAll(trigger, transform)
}

const replaceTrigger = (
  text: string,
  trigger: string,
  config: ParseltongueConfig,
  transformations: ParseltongueResult['transformations']
): string =>
  replaceWith(text, trigger, (match) => {
    const transformed = obfuscateWord(match, config.technique, config.intensity)
    transformations.push({ original: match, transformed, technique: config.technique })
    return transformed
  })

export function detectTriggers(text: string, customTriggers: string[] = []): string[] {
  // 中英两套内置触发词都参与检测，自定义触发词追加在后面
  const allTriggers = [...DEFAULT_TRIGGERS, ...ZH_TRIGGERS, ...customTriggers]
  const found: string[] = []
  const lowerText = text.toLowerCase()

  for (const trigger of allTriggers) {
    if (isLatinTrigger(trigger)) {
      const regex = new RegExp(`\\b${escapeRegExp(trigger)}\\b`, 'i')
      if (regex.test(lowerText)) {
        found.push(trigger)
      }
    } else if (lowerText.includes(trigger)) {
      found.push(trigger)
    }
  }

  return Array.from(new Set(found)) // Remove duplicates
}

/**
 * Main parseltongue transformation function
 * Detects trigger words and obfuscates them
 */
export function applyParseltongue(text: string, config: ParseltongueConfig): ParseltongueResult {
  if (!config.enabled) {
    return {
      originalText: text,
      transformedText: text,
      triggersFound: [],
      techniqueUsed: config.technique,
      transformations: [],
    }
  }

  const triggersFound = detectTriggers(text, config.customTriggers)

  if (triggersFound.length === 0) {
    return {
      originalText: text,
      transformedText: text,
      triggersFound: [],
      techniqueUsed: config.technique,
      transformations: [],
    }
  }

  let transformedText = text
  const transformations: ParseltongueResult['transformations'] = []

  // Sort triggers by length (longest first) to avoid partial replacements
  const sortedTriggers = [...triggersFound].sort((a, b) => b.length - a.length)

  for (const trigger of sortedTriggers) {
    transformedText = replaceTrigger(transformedText, trigger, config, transformations)
  }

  return {
    originalText: text,
    transformedText,
    triggersFound,
    techniqueUsed: config.technique,
    transformations,
  }
}

/**
 * 变体赛跑的单条候选：一个技术 + 一套采样参数。
 * 采样轮换与上游 `getParseltongueSamplingParams` 一致。
 */
export type ParseltongueVariant = {
  technique: TechniqueName
  label: string
  text: string
  index: number
  temperature: number
  topP: number
}

const SAMPLING_CYCLE = [
  { temperature: 0.7, topP: 1 },
  { temperature: 0.8, topP: 0.95 },
  { temperature: 0.75, topP: 1 },
  { temperature: 0.85, topP: 0.9 },
  { temperature: 0.9, topP: 0.95 },
  { temperature: 0.7, topP: 0.9 },
  { temperature: 0.8, topP: 1 },
  { temperature: 0.95, topP: 0.85 },
  { temperature: 0.65, topP: 1 },
  { temperature: 0.6, topP: 0.95 },
  { temperature: 1, topP: 0.8 },
]

/** 变体档位与对应的技术数量（light 11 / standard 22 / heavy 33） */
export const VARIANT_TIER_SIZE = TIER_SIZES

/**
 * 按档位生成改写变体：只改写命中的触发词，其余文本原样保留。
 * 没有命中触发词时各变体文本相同，仅采样参数不同（与上游行为一致）。
 */
export const generateVariants = (
  text: string,
  tier: VariantTier,
  customTriggers: string[] = []
): ParseltongueVariant[] => {
  const triggers = detectTriggers(text, customTriggers)
  const names = techniquesForTier(tier) as TechniqueName[]
  // 最长优先，避免短触发词先替换破坏长触发词
  const sorted = [...triggers].sort((a, b) => b.length - a.length)
  return names.map((technique, index) => {
    const entry = TECHNIQUES[technique]
    let transformed = text
    for (const trigger of sorted) {
      transformed = replaceWith(transformed, trigger, (match) => entry.apply(match))
    }
    const sampling = SAMPLING_CYCLE[index % SAMPLING_CYCLE.length]
    return {
      technique,
      label: entry.label,
      text: transformed,
      index,
      temperature: sampling.temperature,
      topP: sampling.topP,
    }
  })
}

/**
 * Get the default parseltongue config
 */
export function getDefaultConfig(): ParseltongueConfig {
  return {
    enabled: false,
    technique: 'leetspeak',
    intensity: 'medium',
    customTriggers: [],
  }
}

/**
 * Get human-readable description of a technique
 */
export function getTechniqueDescription(technique: ObfuscationTechnique): string {
  const descriptions: Partial<Record<ObfuscationTechnique, string>> = {
    leetspeak: 'Classic 1337speak: a→4, e→3, etc.',
    unicode: 'Unicode lookalikes (cyrillic, greek)',
    zwj: 'Invisible zero-width characters',
    mixedcase: 'Disrupted casing patterns',
    phonetic: 'Phonetic spelling substitutions',
    fullwidth: 'Full-width characters (falls back to thin spaces for pure CJK)',
    spacing: 'Thin spaces inserted between characters (works for CJK)',
    random: 'Random mix of all techniques',
  }
  return descriptions[technique] ?? TECHNIQUES[technique]?.label ?? technique
}

/**
 * Get available techniques for UI
 */
export function getAvailableTechniques(): Array<{
  id: ObfuscationTechnique
  name: string
  description: string
}> {
  return [
    { id: 'leetspeak', name: 'L33tspeak', description: getTechniqueDescription('leetspeak') },
    { id: 'unicode', name: 'Unicode', description: getTechniqueDescription('unicode') },
    { id: 'zwj', name: 'Zero-Width', description: getTechniqueDescription('zwj') },
    { id: 'mixedcase', name: 'MiXeD CaSe', description: getTechniqueDescription('mixedcase') },
    { id: 'phonetic', name: 'Phonetic', description: getTechniqueDescription('phonetic') },
    { id: 'fullwidth', name: 'Full-width', description: getTechniqueDescription('fullwidth') },
    { id: 'spacing', name: 'Spacing', description: getTechniqueDescription('spacing') },
    { id: 'random', name: 'Random', description: getTechniqueDescription('random') },
  ]
}

/**
 * Export the default trigger list for reference
 */
export { DEFAULT_TRIGGERS, ZH_TRIGGERS }
