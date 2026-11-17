import { API_ORIGIN } from './client.js'
import type { ApiProvider } from './types.js'

/**
 * 模型列表：默认使用内置 DeepSeek Flash / V4 Pro，
 * 也可以从云端 GET /models 拉取可用模型并缓存一小时。
 * 远端 id 原样透传给请求，计费未知时按 Flash 价估算。
 * OpenCode Bridge 模式另有自己的内置列表与缓存命名空间。
 */

export type ModelOption = {
  id: string
  label: string
  source: 'remote' | 'builtin'
}

const DEEPSEEK_BUILTIN_MODELS: ModelOption[] = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash', source: 'builtin' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', source: 'builtin' },
]

const BRIDGE_BUILTIN_MODELS: ModelOption[] = [
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', source: 'builtin' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', source: 'builtin' },
]

/** 各推理通道的内置模型；bridge 模式使用 OpenCode Go 的 API model id */
export const builtinModels = (provider: ApiProvider): ModelOption[] =>
  provider === 'opencode-bridge' ? BRIDGE_BUILTIN_MODELS : DEEPSEEK_BUILTIN_MODELS

/** DeepSeek 模式的内置列表（保留旧导出，避免影响既有调用点） */
export const BUILTIN_MODELS: ModelOption[] = DEEPSEEK_BUILTIN_MODELS

const CACHE_KEY = 'chat-demo:models-cache'
/** 缓存一小时；「从云端获取」会强制刷新 */
const CACHE_TTL = 60 * 60 * 1000
/** 拉取超时，避免网络挂起时选择器一直转圈 */
const FETCH_TIMEOUT = 8000

type Cached = { at: number; models: ModelOption[]; provider?: ApiProvider }

/** 把 deepseek-v4-pro 之类的 id 整理成可读名称 */
export const prettyModelName = (id: string): string =>
  id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(' ')

const ALL_BUILTIN_MODELS = [...DEEPSEEK_BUILTIN_MODELS, ...BRIDGE_BUILTIN_MODELS]

export const modelLabel = (id: string): string =>
  ALL_BUILTIN_MODELS.find((item) => item.id === id)?.label ?? prettyModelName(id)

export const readCachedModels = (provider: ApiProvider = 'deepseek'): ModelOption[] | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Cached
    // 旧缓存没有 provider 字段，按 DeepSeek 处理；不同通道不共用模型列表
    if ((parsed.provider ?? 'deepseek') !== provider) {
      return null
    }
    if (!Array.isArray(parsed.models) || Date.now() - parsed.at > CACHE_TTL) {
      return null
    }
    return parsed.models.filter(
      (item): item is ModelOption =>
        typeof item?.id === 'string' &&
        typeof item?.label === 'string' &&
        (item.source === 'remote' || item.source === 'builtin')
    )
  } catch {
    return null
  }
}

/** 写入某通道的模型缓存；bridge 与 deepseek 互不覆盖 */
export const writeCachedModels = (provider: ApiProvider, models: ModelOption[]) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), provider, models }))
  } catch {
    // 隐私模式下写入失败不影响本次选择
  }
}

/** 兼容 OpenAI 的 {data:[{id}]} 与部分实现的 {models:[...]} */
export const parseModels = (payload: unknown): ModelOption[] => {
  if (typeof payload !== 'object' || payload === null) {
    return []
  }
  const record = payload as Record<string, unknown>
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const seen = new Set<string>()
  return list.flatMap((item): ModelOption[] => {
    if (typeof item === 'string') {
      return [{ id: item, label: prettyModelName(item), source: 'remote' as const }]
    }
    if (typeof item !== 'object' || item === null) {
      return []
    }
    const entry = item as Record<string, unknown>
    const id =
      typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : ''
    if (!id || seen.has(id)) {
      return []
    }
    seen.add(id)
    const label =
      (typeof entry.display_name === 'string' && entry.display_name) ||
      (typeof entry.displayName === 'string' && entry.displayName) ||
      prettyModelName(id)
    return [{ id, label, source: 'remote' as const }]
  })
}

const requestJson = async (url: string, headers: Record<string, string>): Promise<unknown> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 远端拉取可用模型：先试 OpenAI 兼容的 /models，再试 Anthropic 兼容前缀。
 * 都失败时抛出错误，由调用方退回缓存或内置列表。
 */
export const fetchRemoteModels = async (apiKey: string): Promise<ModelOption[]> => {
  if (!apiKey.trim()) {
    throw new Error('missing api key')
  }
  const attempts: Array<() => Promise<unknown>> = [
    () =>
      requestJson(`${API_ORIGIN}/models`, {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      }),
    () =>
      requestJson(`${API_ORIGIN}/anthropic/v1/models`, {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
      }),
  ]
  let lastError: unknown = new Error('no endpoint')
  for (const attempt of attempts) {
    try {
      const models = parseModels(await attempt())
      if (models.length > 0) {
        writeCachedModels('deepseek', models)
        return models
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
