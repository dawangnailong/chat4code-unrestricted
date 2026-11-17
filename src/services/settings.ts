import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import type { ApiProvider, ChatModel } from './api/types.js'
import { normalizeLocation, type UserLocation } from './location.js'
import type { AutoTuneStrategy } from './unrestricted/autotune.js'
import type { ObfuscationTechnique } from './unrestricted/parseltongue.js'
import type { PromptPreset } from './unrestricted/prompts.js'
import { STM_MODULE_IDS } from './unrestricted/stm.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、模型参数、提示词开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  /** 推理通道：默认直连 DeepSeek，或经 OpenCode Bridge 扩展转发 */
  apiProvider: ApiProvider
  /** OpenCode Bridge 扩展 ID；空串表示未配置 */
  bridgeExtensionId: string
  /** 当前模型：内置 flash / v4-pro，或云端列表里的任意 id */
  model: ChatModel
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  /** 思考强度 0-4；0 为关闭，与 thinking 保持同步 */
  reasoningEffort: number
  /** 自动越狱：GODMODE 提示词 + 自动扰动 + 被拒绝后自动换组合重试 */
  autoJailbreak: boolean
  /** 每轮把系统提示词静默注入 latest_reminder，防止长对话遗忘设定 */
  injectPromptEveryTurn: boolean
  /** 实验性：把内置越狱提示词换成中文翻译 */
  translateJailbreakZh: boolean
  /** 长对话自动压缩 */
  autoCompress: boolean
  /** 变体赛跑的预算上限（元） */
  variantRaceBudget: number
  /** 变体赛跑的开跑确认已永久关闭 */
  variantRaceConfirmDismissed: boolean
  search: boolean
  /** 采样温度 0–2，默认 1 */
  temperature: number
  /** 核采样阈值 0–1，默认 1 */
  topP: number
  /** 每次回复的最大输出 Token；null 表示使用服务端默认值 */
  maxTokens: number | null
  /** 解除限制模式：把系统提示词换成破限提示词，并把安全审核降到默认档 */
  unrestricted: boolean
  /** 防撤回：模型撤回已输出内容时保留已经下发的正文与思维链 */
  keepReplyContent: boolean
  /** 跳过安全审核：请求不携带 safety_check 字段（越狱模式下强制执行） */
  skipSafetyCheck: boolean
  /** 拒绝后继续生成：被安全审核拒绝的回复仍可继续生成（越狱模式下强制执行） */
  continueRefused: boolean
  /** 自定义系统提示词：null 表示使用自动组装结果（Persona，或 Persona + 破限规则分块） */
  systemPrompt: string | null
  /** 提示词预设：deepseek 用仓库里的 v4.1 文档，godmode 用移植的 GODMODE 提示词 */
  promptPreset: PromptPreset
  /** 输入扰动（Parseltongue）：开启后发送前改写命中的触发词 */
  parseltongue: boolean
  /** 扰动技术 */
  parseltongueTechnique: ObfuscationTechnique
  /** 扰动强度 */
  parseltongueIntensity: 'light' | 'medium' | 'heavy'
  /** 自动调参（AutoTune）：按上下文改写采样参数 */
  autoTune: boolean
  /** 调参策略；adaptive 会先做上下文分类再取参数 */
  autoTuneStrategy: AutoTuneStrategy
  /** 输出整形（STM）模块 id；空数组表示不整形 */
  stmModules: string[]
  /** 是否在本地校验附件限制 */
  attachmentLimits: boolean
  /** 单文件大小上限（MB）；null 表示用内置默认值 */
  attachmentMaxMB: number | null
  /** 单会话附件数量上限；null 表示用内置默认值 */
  attachmentMaxCount: number | null
  /** 自定义扩展名白名单；null 表示用内置清单 */
  attachmentExts: string[] | null
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  apiProvider: 'chat-demo:api-provider',
  bridgeExtensionId: 'chat-demo:bridge-extension-id',
  model: 'chat-demo:model',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  reasoningEffort: 'chat-demo:reasoning-effort',
  autoJailbreak: 'chat-demo:auto-jailbreak',
  injectPromptEveryTurn: 'chat-demo:inject-prompt-every-turn',
  translateJailbreakZh: 'chat-demo:translate-jailbreak-zh',
  autoCompress: 'chat-demo:auto-compress',
  variantRaceBudget: 'chat-demo:variant-race-budget',
  variantRaceConfirmDismissed: 'chat-demo:variant-race-confirm-dismissed',
  search: 'chat-demo:search',
  temperature: 'chat-demo:temperature',
  topP: 'chat-demo:top-p',
  maxTokens: 'chat-demo:max-tokens',
  unrestricted: 'chat-demo:unrestricted',
  keepReplyContent: 'chat-demo:keep-reply-content',
  skipSafetyCheck: 'chat-demo:skip-safety-check',
  continueRefused: 'chat-demo:continue-refused',
  systemPrompt: 'chat-demo:system-prompt',
  promptPreset: 'chat-demo:prompt-preset',
  parseltongue: 'chat-demo:parseltongue',
  parseltongueTechnique: 'chat-demo:parseltongue-technique',
  parseltongueIntensity: 'chat-demo:parseltongue-intensity',
  autoTune: 'chat-demo:autotune',
  autoTuneStrategy: 'chat-demo:autotune-strategy',
  stmModules: 'chat-demo:stm-modules',
  attachmentLimits: 'chat-demo:attachment-limits',
  attachmentMaxMB: 'chat-demo:attachment-max-mb',
  attachmentMaxCount: 'chat-demo:attachment-max-count',
  attachmentExts: 'chat-demo:attachment-exts',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialModel = (): ChatModel => {
  const saved = read(KEYS.model)
  return saved !== null && saved.trim() !== '' ? saved.trim() : 'deepseek-flash'
}

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 思考强度档位：0 关闭，1-4 由弱到强 */
export const EFFORT_LEVELS = 4

/** 1-4 档对应的协议字段值，0 档不下发 */
const REASONING_EFFORT = ['low', 'medium', 'high', 'max'] as const

export const reasoningEffortValue = (effort: number) =>
  REASONING_EFFORT[Math.min(REASONING_EFFORT.length, Math.max(1, effort)) - 1]

/** Anthropic 兼容接口的思考预算，按档位递增 */
const THINKING_BUDGET = [0, 1024, 4096, 12000, 32000] as const

/** 服务端要求思考预算至少 1024，0 档也按下限兜底（正常路径不会用到） */
export const thinkingBudget = (effort: number) =>
  THINKING_BUDGET[Math.min(THINKING_BUDGET.length - 1, Math.max(1, effort))]

/** 读取数值设置；未保存、超出范围或格式不对时回落到默认值 */
const initialNumber = (key: string, fallback: number, min: number, max: number): number => {
  const raw = read(key)
  if (raw === null) {
    return fallback
  }
  const value = Number(raw)
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

/** 思考强度：优先读新键，旧数据只有 thinking 开关时按标准档恢复 */
const initialReasoningEffort = (): number => {
  const raw = Number(read(KEYS.reasoningEffort))
  if (read(KEYS.reasoningEffort) !== null && Number.isFinite(raw)) {
    return Math.min(EFFORT_LEVELS, Math.max(0, Math.round(raw)))
  }
  return read(KEYS.thinking) === 'true' ? 2 : 0
}

/** 附件大小：未设置或不是正整数时为 null（使用内置默认值） */
const initialAttachmentNumber = (key: string): number | null => {
  const raw = read(key)
  if (raw === null) {
    return null
  }
  const value = Math.floor(Number(raw))
  return Number.isFinite(value) && value >= 1 ? value : null
}

/** 自定义扩展名白名单：逗号分隔存储；为空时为 null（使用内置清单） */
const initialAttachmentExts = (): string[] | null => {
  const raw = read(KEYS.attachmentExts)
  if (raw === null) {
    return null
  }
  const exts = raw
    .split(',')
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ''))
    .filter((ext) => ext !== '')
  return exts.length > 0 ? exts : null
}

/** 自定义系统提示词：未填写或只有空白时为 null，表示使用自动组装结果 */
const initialSystemPrompt = (): string | null => {
  const saved = read(KEYS.systemPrompt)
  return saved !== null && saved.trim() !== '' ? saved : null
}

/** 最大输出 Token：未设置或不是正整数时为 null，表示使用服务端默认值 */
const initialMaxTokens = (): number | null => {
  const raw = read(KEYS.maxTokens)
  if (raw === null) {
    return null
  }
  const value = Math.floor(Number(raw))
  return Number.isFinite(value) && value >= 1 ? value : null
}

const API_PROVIDERS: ApiProvider[] = ['deepseek', 'opencode-bridge']

const PROMPT_PRESETS: PromptPreset[] = ['deepseek', 'godmode']

const TECHNIQUES: ObfuscationTechnique[] = [
  'leetspeak',
  'unicode',
  'zwj',
  'mixedcase',
  'phonetic',
  'fullwidth',
  'spacing',
  'random',
]

const INTENSITIES: Array<'light' | 'medium' | 'heavy'> = ['light', 'medium', 'heavy']

const STRATEGIES: AutoTuneStrategy[] = ['adaptive', 'precise', 'balanced', 'creative', 'chaotic']

/** 枚举型设置：值不在允许集合里时回落到默认值 */
const initialEnum = <T extends string>(key: string, values: readonly T[], fallback: T): T => {
  const saved = read(key)
  return saved !== null && (values as readonly string[]).includes(saved) ? (saved as T) : fallback
}

/** 输出整形模块：只保留已知 id，空数组表示关闭 */
const initialStmModules = (): string[] => {
  const raw = read(KEYS.stmModules)
  if (raw === null) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (id): id is string => typeof id === 'string' && STM_MODULE_IDS.includes(id)
    )
  } catch {
    return []
  }
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  apiProvider: initialEnum(KEYS.apiProvider, API_PROVIDERS, 'deepseek'),
  bridgeExtensionId: (read(KEYS.bridgeExtensionId) ?? '').trim(),
  model: initialModel(),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: initialReasoningEffort() > 0,
  reasoningEffort: initialReasoningEffort(),
  autoJailbreak: read(KEYS.autoJailbreak) === 'true',
  injectPromptEveryTurn: read(KEYS.injectPromptEveryTurn) === 'true',
  translateJailbreakZh: read(KEYS.translateJailbreakZh) === 'true',
  autoCompress: read(KEYS.autoCompress) === 'true',
  variantRaceBudget: initialNumber(KEYS.variantRaceBudget, 1, 0.01, 1000),
  variantRaceConfirmDismissed: read(KEYS.variantRaceConfirmDismissed) === 'true',
  search: read(KEYS.search) === 'true',
  temperature: initialNumber(KEYS.temperature, 1, 0, 2),
  topP: initialNumber(KEYS.topP, 1, 0.01, 1),
  maxTokens: initialMaxTokens(),
  unrestricted: read(KEYS.unrestricted) === 'true',
  keepReplyContent: read(KEYS.keepReplyContent) === 'true',
  skipSafetyCheck: read(KEYS.skipSafetyCheck) === 'true',
  continueRefused: read(KEYS.continueRefused) === 'true',
  systemPrompt: initialSystemPrompt(),
  promptPreset: initialEnum(KEYS.promptPreset, PROMPT_PRESETS, 'deepseek'),
  parseltongue: read(KEYS.parseltongue) === 'true',
  parseltongueTechnique: initialEnum(KEYS.parseltongueTechnique, TECHNIQUES, 'leetspeak'),
  parseltongueIntensity: initialEnum(KEYS.parseltongueIntensity, INTENSITIES, 'medium'),
  autoTune: read(KEYS.autoTune) === 'true',
  autoTuneStrategy: initialEnum(KEYS.autoTuneStrategy, STRATEGIES, 'adaptive'),
  stmModules: initialStmModules(),
  attachmentLimits: read(KEYS.attachmentLimits) !== 'false',
  attachmentMaxMB: initialAttachmentNumber(KEYS.attachmentMaxMB),
  attachmentMaxCount: initialAttachmentNumber(KEYS.attachmentMaxCount),
  attachmentExts: initialAttachmentExts(),
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setModel = (model: ChatModel) => {
  const next = model.trim()
  if (next === '') {
    return
  }
  write(KEYS.model, next)
  useSettings.setState({ model: next })
}

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

/** 推理通道；切换后旧通道的 Key 与设置保留，切回即可继续使用 */
export const setApiProvider = (apiProvider: ApiProvider) => {
  write(KEYS.apiProvider, apiProvider)
  // 两个通道的 Flash 模型 id 不同：切换时同步当前模型，避免下拉列表里没有选中项
  const current = useSettings.getState().model
  const nextModel =
    apiProvider === 'opencode-bridge' && current === 'deepseek-flash'
      ? 'deepseek-v4.1-flash'
      : apiProvider === 'deepseek' && current === 'deepseek-v4.1-flash'
        ? 'deepseek-flash'
        : current
  if (nextModel !== current) {
    write(KEYS.model, nextModel)
  }
  useSettings.setState({ apiProvider, model: nextModel })
}

/** OpenCode Bridge 扩展 ID；不校验格式，留空表示未配置 */
export const setBridgeExtensionId = (bridgeExtensionId: string) => {
  const next = bridgeExtensionId.trim()
  write(KEYS.bridgeExtensionId, next === '' ? null : next)
  useSettings.setState({ bridgeExtensionId: next })
}

/** 是否处于 OpenCode Bridge 模式；组件用它隐藏 DeepSeek 专属功能 */
export const useBridgeMode = (): boolean =>
  useSettings((state) => state.apiProvider === 'opencode-bridge')

export const setThinking = (thinking: boolean) => {
  // 打开时恢复到上次的档位（没有则用标准档），关闭时档位归零
  const effort = thinking ? useSettings.getState().reasoningEffort || 2 : 0
  write(KEYS.thinking, String(thinking))
  write(KEYS.reasoningEffort, String(effort))
  useSettings.setState({ thinking, reasoningEffort: effort })
}

/** 拖动思考强度轨道：0 档同时关闭深度思考 */
export const setReasoningEffort = (value: number) => {
  const effort = Math.min(EFFORT_LEVELS, Math.max(0, Math.round(value)))
  write(KEYS.reasoningEffort, String(effort))
  write(KEYS.thinking, String(effort > 0))
  useSettings.setState({ reasoningEffort: effort, thinking: effort > 0 })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setTemperature = (temperature: number) => {
  const value = Math.min(2, Math.max(0, Number(temperature.toFixed(2))))
  write(KEYS.temperature, String(value))
  useSettings.setState({ temperature: value })
}

export const setTopP = (topP: number) => {
  const value = Math.min(1, Math.max(0.01, Number(topP.toFixed(2))))
  write(KEYS.topP, String(value))
  useSettings.setState({ topP: value })
}

/** 传 null 表示使用服务端默认值，不写入请求 */
export const setMaxTokens = (maxTokens: number | null) => {
  const value = maxTokens === null ? null : Math.max(1, Math.floor(maxTokens))
  write(KEYS.maxTokens, value === null ? null : String(value))
  useSettings.setState({ maxTokens: value })
}

export const setKeepReplyContent = (keepReplyContent: boolean) => {
  write(KEYS.keepReplyContent, String(keepReplyContent))
  useSettings.setState({ keepReplyContent })
}

export const setSkipSafetyCheck = (skipSafetyCheck: boolean) => {
  write(KEYS.skipSafetyCheck, String(skipSafetyCheck))
  useSettings.setState({ skipSafetyCheck })
}

export const setContinueRefused = (continueRefused: boolean) => {
  write(KEYS.continueRefused, String(continueRefused))
  useSettings.setState({ continueRefused })
}

/** 传 null 或空白字符串表示恢复自动组装 */
export const setSystemPrompt = (systemPrompt: string | null) => {
  const value = systemPrompt !== null && systemPrompt.trim() !== '' ? systemPrompt : null
  write(KEYS.systemPrompt, value)
  useSettings.setState({ systemPrompt: value })
}

export const setUnrestricted = (unrestricted: boolean) => {
  write(KEYS.unrestricted, String(unrestricted))
  useSettings.setState({ unrestricted })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setPromptPreset = (promptPreset: PromptPreset) => {
  write(KEYS.promptPreset, promptPreset)
  useSettings.setState({ promptPreset })
}

export const setParseltongue = (parseltongue: boolean) => {
  write(KEYS.parseltongue, String(parseltongue))
  useSettings.setState({ parseltongue })
}

export const setParseltongueTechnique = (parseltongueTechnique: ObfuscationTechnique) => {
  write(KEYS.parseltongueTechnique, parseltongueTechnique)
  useSettings.setState({ parseltongueTechnique })
}

export const setParseltongueIntensity = (parseltongueIntensity: 'light' | 'medium' | 'heavy') => {
  write(KEYS.parseltongueIntensity, parseltongueIntensity)
  useSettings.setState({ parseltongueIntensity })
}

export const setAutoTune = (autoTune: boolean) => {
  write(KEYS.autoTune, String(autoTune))
  useSettings.setState({ autoTune })
}

export const setAutoTuneStrategy = (autoTuneStrategy: AutoTuneStrategy) => {
  write(KEYS.autoTuneStrategy, autoTuneStrategy)
  useSettings.setState({ autoTuneStrategy })
}

/** 传入的 id 会按 STM_MODULE_IDS 过滤，传空数组表示关闭输出整形 */
export const setStmModules = (stmModules: string[]) => {
  const value = stmModules.filter((id) => STM_MODULE_IDS.includes(id))
  write(KEYS.stmModules, JSON.stringify(value))
  useSettings.setState({ stmModules: value })
}

export const setAttachmentLimits = (attachmentLimits: boolean) => {
  write(KEYS.attachmentLimits, String(attachmentLimits))
  useSettings.setState({ attachmentLimits })
}

/** 传 null 表示恢复内置默认值 */
export const setAttachmentMaxMB = (attachmentMaxMB: number | null) => {
  const value = attachmentMaxMB === null ? null : Math.max(1, Math.round(attachmentMaxMB))
  write(KEYS.attachmentMaxMB, value === null ? null : String(value))
  useSettings.setState({ attachmentMaxMB: value })
}

/** 传 null 表示恢复内置默认值 */
export const setAttachmentMaxCount = (attachmentMaxCount: number | null) => {
  const value = attachmentMaxCount === null ? null : Math.max(1, Math.round(attachmentMaxCount))
  write(KEYS.attachmentMaxCount, value === null ? null : String(value))
  useSettings.setState({ attachmentMaxCount: value })
}

/** 传 null 或空数组表示恢复内置白名单 */
export const setAttachmentExts = (attachmentExts: string[] | null) => {
  const value =
    attachmentExts === null || attachmentExts.length === 0
      ? null
      : attachmentExts.map((ext) => ext.trim().toLowerCase().replace(/^\./, '')).filter(Boolean)
  write(KEYS.attachmentExts, value === null ? null : value.join(','))
  useSettings.setState({ attachmentExts: value })
}

export const setAutoJailbreak = (autoJailbreak: boolean) => {
  write(KEYS.autoJailbreak, String(autoJailbreak))
  useSettings.setState({ autoJailbreak })
}

export const setVariantRaceBudget = (variantRaceBudget: number) => {
  const value = Math.min(1000, Math.max(0.01, Number(variantRaceBudget.toFixed(2))))
  write(KEYS.variantRaceBudget, String(value))
  useSettings.setState({ variantRaceBudget: value })
}

export const setVariantRaceConfirmDismissed = (variantRaceConfirmDismissed: boolean) => {
  write(KEYS.variantRaceConfirmDismissed, String(variantRaceConfirmDismissed))
  useSettings.setState({ variantRaceConfirmDismissed })
}

export const setInjectPromptEveryTurn = (injectPromptEveryTurn: boolean) => {
  write(KEYS.injectPromptEveryTurn, String(injectPromptEveryTurn))
  useSettings.setState({ injectPromptEveryTurn })
}

export const setTranslateJailbreakZh = (translateJailbreakZh: boolean) => {
  write(KEYS.translateJailbreakZh, String(translateJailbreakZh))
  useSettings.setState({ translateJailbreakZh })
}

export const setAutoCompress = (autoCompress: boolean) => {
  write(KEYS.autoCompress, String(autoCompress))
  useSettings.setState({ autoCompress })
}

/**
 * 恢复默认设置：清空本机所有设置键并回到默认值。
 * API Key 是凭据不是偏好，保留；对话、附件、统计等数据不在设置键里，同样不受影响。
 */
export const resetSettings = () => {
  const apiKey = useSettings.getState().apiKey
  for (const key of Object.values(KEYS)) {
    if (key !== KEYS.apiKey) {
      write(key, null)
    }
  }
  useSettings.setState({
    apiKey,
    apiProvider: 'deepseek',
    bridgeExtensionId: '',
    model: 'deepseek-flash',
    locale: isChineseBrowser() ? 'zh-CN' : 'en-US',
    themePreference: 'system',
    location: null,
    ttsVoice: 'stella',
    thinking: false,
    reasoningEffort: 0,
    autoJailbreak: false,
    injectPromptEveryTurn: false,
    translateJailbreakZh: false,
    autoCompress: false,
    variantRaceBudget: 1,
    variantRaceConfirmDismissed: false,
    search: false,
    temperature: 1,
    topP: 1,
    maxTokens: null,
    unrestricted: false,
    keepReplyContent: false,
    skipSafetyCheck: false,
    continueRefused: false,
    systemPrompt: null,
    promptPreset: 'deepseek',
    parseltongue: false,
    parseltongueTechnique: 'leetspeak',
    parseltongueIntensity: 'medium',
    autoTune: false,
    autoTuneStrategy: 'adaptive',
    stmModules: [],
    attachmentLimits: true,
    attachmentMaxMB: null,
    attachmentMaxCount: null,
    attachmentExts: null,
    siderCollapsed: false,
  })
}
