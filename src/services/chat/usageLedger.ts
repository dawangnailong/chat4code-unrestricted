import { create } from 'zustand'
import type { MessageUsage } from '../api/types.js'
import { usageCost } from './sessionStats.js'

/**
 * 用量账本：按「日 / 模型 / 会话」累计每次请求的 token 与费用，
 * 供统计页画趋势图、热力图、小时分布与会话排行。
 *
 * 与 dailyUsage 的分工：dailyUsage 只管今天（跨天归零、用来触发额度提醒），
 * 账本保留最近 400 天，跨天不清空，因此图表、长期对比与构成分析只读账本。
 * 数据全部来自服务端 message_delta 上报的 usage，不做字符估算。
 *
 * 结构版本：v1 只有日 / 模型维度；v2 增加每小时请求数与会话维度。
 * 读取时对缺字段一律补默认值，所以 v1 的历史数据可以直接升级，不需要迁移脚本。
 */

const STORAGE_KEY = 'chat-demo:usage-ledger'
/** 账本结构版本；以后加字段时继续往上加，读取端按缺省值兼容旧数据 */
export const LEDGER_VERSION = 2
/** 保留天数：一年多的趋势足够看，又不至于让 localStorage 膨胀 */
export const LEDGER_KEEP_DAYS = 400
/** 会话维度只保留最近 300 个，避免账本无限增长 */
export const LEDGER_MAX_SESSIONS = 300

/** 24 小时桶：每个元素的含义由调用方决定（请求数） */
export type HourBucket = number[]

const emptyHours = (): HourBucket => Array.from({ length: 24 }, () => 0)

/** 单个模型在一天里的累计 */
export type ModelUsage = {
  /** 未命中缓存的输入 token */
  input: number
  /** 命中缓存的输入 token */
  cacheRead: number
  /** 写入缓存的输入 token */
  cacheWrite: number
  output: number
  cost: number
  /** 该模型的请求次数 */
  requests: number
}

/** 单个会话在一天里的累计；at 为当天最后一次请求的时间戳 */
export type SessionUsage = ModelUsage & { at: number }

/** 一天的累计 */
export type DayUsage = ModelUsage & {
  /** 本地日期 YYYY-MM-DD */
  date: string
  /** 联网搜索调用次数 */
  searches: number
  /** 文件解析页数（客户端拿不到真实页数时按体积估算） */
  pages: number
  /** 按模型拆分 */
  models: Record<string, ModelUsage>
  /** 按会话拆分 */
  sessions: Record<string, SessionUsage>
  /** 24 小时请求数分布 */
  hourly: HourBucket
}

type LedgerState = { days: Record<string, DayUsage> }

const todayKey = (date = new Date()): string => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 日期字符串加减天数，用于补齐没有请求的空白日 */
export const shiftDayKey = (key: string, delta: number): string => {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  date.setDate(date.getDate() + delta)
  return todayKey(date)
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

const readModel = (value: unknown): ModelUsage => {
  const item = (value ?? {}) as Partial<ModelUsage>
  return {
    input: count(item.input),
    cacheRead: count(item.cacheRead),
    cacheWrite: count(item.cacheWrite),
    output: count(item.output),
    cost: count(item.cost),
    requests: count(item.requests),
  }
}

const readSession = (value: unknown): SessionUsage => {
  const item = (value ?? {}) as Partial<SessionUsage>
  return { ...readModel(item), at: count(item.at) }
}

/** v1 数据没有 hourly / sessions，这里补默认值即可完成迁移 */
const readHours = (value: unknown): HourBucket => {
  if (!Array.isArray(value)) {
    return emptyHours()
  }
  return Array.from({ length: 24 }, (_, index) => count(value[index]))
}

const readDay = (value: unknown): DayUsage | null => {
  const item = (value ?? {}) as Partial<DayUsage>
  if (typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
    return null
  }
  const models: Record<string, ModelUsage> = {}
  if (item.models && typeof item.models === 'object') {
    for (const [id, entry] of Object.entries(item.models as Record<string, unknown>)) {
      models[id] = readModel(entry)
    }
  }
  const sessions: Record<string, SessionUsage> = {}
  if (item.sessions && typeof item.sessions === 'object') {
    for (const [id, entry] of Object.entries(item.sessions as Record<string, unknown>)) {
      sessions[id] = readSession(entry)
    }
  }
  return {
    date: item.date,
    input: count(item.input),
    cacheRead: count(item.cacheRead),
    cacheWrite: count(item.cacheWrite),
    output: count(item.output),
    cost: count(item.cost),
    requests: count(item.requests),
    searches: count(item.searches),
    pages: count(item.pages),
    models,
    sessions,
    hourly: readHours(item.hourly),
  }
}

const read = (): Record<string, DayUsage> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    const entries =
      typeof parsed === 'object' && parsed !== null && 'days' in parsed
        ? (parsed as { days: unknown }).days
        : parsed
    if (typeof entries !== 'object' || entries === null) {
      return {}
    }
    const days: Record<string, DayUsage> = {}
    for (const value of Object.values(entries as Record<string, unknown>)) {
      const day = readDay(value)
      if (day) {
        days[day.date] = day
      }
    }
    return days
  } catch {
    // 损坏的 JSON 直接当作空账本，不要让统计页带崩整个应用
    return {}
  }
}

const write = (days: Record<string, DayUsage>) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: LEDGER_VERSION, days }))
  } catch {
    // 隐私模式下写不进去也不影响本次展示
  }
}

/** 只保留最近 LEDGER_KEEP_DAYS 天，按日期字符串排序即可 */
const prune = (days: Record<string, DayUsage>): Record<string, DayUsage> => {
  const keys = Object.keys(days).sort()
  if (keys.length <= LEDGER_KEEP_DAYS) {
    return days
  }
  const kept = keys.slice(keys.length - LEDGER_KEEP_DAYS)
  return Object.fromEntries(kept.flatMap((key) => (days[key] ? [[key, days[key]]] : [])))
}

/** 会话维度用「最近出现时间」淘汰，跨天累加时以最新的一天为准 */
const pruneSessions = (days: Record<string, DayUsage>): Record<string, DayUsage> => {
  const latest = new Map<string, number>()
  for (const day of Object.values(days)) {
    for (const [id, usage] of Object.entries(day.sessions)) {
      latest.set(id, Math.max(latest.get(id) ?? 0, usage.at))
    }
  }
  if (latest.size <= LEDGER_MAX_SESSIONS) {
    return days
  }
  const keep = new Set(
    [...latest.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, LEDGER_MAX_SESSIONS)
      .map(([id]) => id)
  )
  const next: Record<string, DayUsage> = {}
  for (const [key, day] of Object.entries(days)) {
    next[key] = {
      ...day,
      sessions: Object.fromEntries(
        Object.entries(day.sessions).filter(([id]) => keep.has(id))
      ) as Record<string, SessionUsage>,
    }
  }
  return next
}

export const useLedger = create<LedgerState>(() => ({ days: read() }))

/** 记录一次请求；同一分钟内的重复调用会合并进同一天 */
export const noteLedgerUsage = (
  model: string,
  usage: MessageUsage,
  at = new Date(),
  extra: { sessionId?: string; pages?: number } = {}
) => {
  const input = usage.input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  if (input + cacheRead + cacheWrite + output <= 0) {
    return
  }
  const date = todayKey(at)
  const cost = usageCost(model, usage, at)
  const searches = usage.server_tool_use?.web_search_requests ?? 0
  const previous = useLedger.getState().days[date]

  const models: Record<string, ModelUsage> = { ...(previous?.models ?? {}) }
  const modelPrevious = models[model] ?? {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    cost: 0,
    requests: 0,
  }
  models[model] = {
    input: modelPrevious.input + input,
    cacheRead: modelPrevious.cacheRead + cacheRead,
    cacheWrite: modelPrevious.cacheWrite + cacheWrite,
    output: modelPrevious.output + output,
    cost: modelPrevious.cost + cost,
    requests: modelPrevious.requests + 1,
  }

  const sessions: Record<string, SessionUsage> = { ...(previous?.sessions ?? {}) }
  if (extra.sessionId) {
    const sessionPrevious = sessions[extra.sessionId] ?? {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      cost: 0,
      requests: 0,
      at: 0,
    }
    sessions[extra.sessionId] = {
      input: sessionPrevious.input + input,
      cacheRead: sessionPrevious.cacheRead + cacheRead,
      cacheWrite: sessionPrevious.cacheWrite + cacheWrite,
      output: sessionPrevious.output + output,
      cost: sessionPrevious.cost + cost,
      requests: sessionPrevious.requests + 1,
      at: Math.max(sessionPrevious.at, at.getTime()),
    }
  }

  const hourly = [...(previous?.hourly ?? emptyHours())]
  hourly[at.getHours()] = (hourly[at.getHours()] ?? 0) + 1

  const next: DayUsage = {
    date,
    input: (previous?.input ?? 0) + input,
    cacheRead: (previous?.cacheRead ?? 0) + cacheRead,
    cacheWrite: (previous?.cacheWrite ?? 0) + cacheWrite,
    output: (previous?.output ?? 0) + output,
    cost: (previous?.cost ?? 0) + cost,
    requests: (previous?.requests ?? 0) + 1,
    searches: (previous?.searches ?? 0) + searches,
    pages: (previous?.pages ?? 0) + Math.max(0, extra.pages ?? 0),
    models,
    sessions,
    hourly,
  }
  const days = pruneSessions(prune({ ...useLedger.getState().days, [date]: next }))
  write(days)
  useLedger.setState({ days })
}

/** 空的一天：日期补齐用，方便图表按天连续绘制 */
export const emptyDay = (date: string): DayUsage => ({
  date,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  cost: 0,
  requests: 0,
  searches: 0,
  pages: 0,
  models: {},
  sessions: {},
  hourly: emptyHours(),
})

/** 取最近 N 天（含今天），缺的天补 0，顺序从旧到新 */
export const ledgerSeries = (
  days: Record<string, DayUsage>,
  length: number,
  now = new Date()
): DayUsage[] => {
  const today = todayKey(now)
  const series: DayUsage[] = []
  for (let index = length - 1; index >= 0; index -= 1) {
    const key = shiftDayKey(today, -index)
    series.push(days[key] ?? emptyDay(key))
  }
  return series
}

export type LedgerTotals = ModelUsage & {
  searches: number
  pages: number
  /** 命中缓存的输入占比，没有输入时为 null */
  cacheRate: number | null
  /** 有请求的天数 */
  activeDays: number
}

export const ledgerTotals = (series: DayUsage[]): LedgerTotals => {
  const totals: LedgerTotals = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    cost: 0,
    requests: 0,
    searches: 0,
    pages: 0,
    cacheRate: null,
    activeDays: 0,
  }
  for (const day of series) {
    totals.input += day.input
    totals.cacheRead += day.cacheRead
    totals.cacheWrite += day.cacheWrite
    totals.output += day.output
    totals.cost += day.cost
    totals.requests += day.requests
    totals.searches += day.searches
    totals.pages += day.pages
    if (day.requests > 0) {
      totals.activeDays += 1
    }
  }
  const inputTotal = totals.input + totals.cacheRead + totals.cacheWrite
  totals.cacheRate = inputTotal > 0 ? totals.cacheRead / inputTotal : null
  return totals
}

/** 按模型汇总一段时间，按用量从高到低 */
export const ledgerModels = (series: DayUsage[]): { model: string; usage: ModelUsage }[] => {
  const merged = new Map<string, ModelUsage>()
  for (const day of series) {
    for (const [model, usage] of Object.entries(day.models)) {
      const previous = merged.get(model) ?? {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        cost: 0,
        requests: 0,
      }
      merged.set(model, {
        input: previous.input + usage.input,
        cacheRead: previous.cacheRead + usage.cacheRead,
        cacheWrite: previous.cacheWrite + usage.cacheWrite,
        output: previous.output + usage.output,
        cost: previous.cost + usage.cost,
        requests: previous.requests + usage.requests,
      })
    }
  }
  return [...merged.entries()]
    .map(([model, usage]) => ({ model, usage }))
    .sort(
      (a, b) =>
        b.usage.input +
        b.usage.cacheRead +
        b.usage.output -
        (a.usage.input + a.usage.cacheRead + a.usage.output)
    )
}

export type SessionRankItem = {
  id: string
  tokens: number
  cost: number
  requests: number
  /** 该会话在范围内最后一次请求的时间 */
  at: number
}

/** 按会话汇总一段时间，按 token 从高到低；同一会话跨天累加 */
export const ledgerSessions = (series: DayUsage[]): SessionRankItem[] => {
  const merged = new Map<string, SessionRankItem>()
  for (const day of series) {
    for (const [id, usage] of Object.entries(day.sessions)) {
      const previous = merged.get(id) ?? { id, tokens: 0, cost: 0, requests: 0, at: 0 }
      merged.set(id, {
        id,
        tokens: previous.tokens + usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
        cost: previous.cost + usage.cost,
        requests: previous.requests + usage.requests,
        at: Math.max(previous.at, usage.at),
      })
    }
  }
  return [...merged.values()].sort((a, b) => b.tokens - a.tokens)
}

/** 把区间内的每小时请求数合并成一天内的分布 */
export const ledgerHourly = (series: DayUsage[]): HourBucket =>
  Array.from({ length: 24 }, (_, hour) =>
    series.reduce((sum, day) => sum + (day.hourly[hour] ?? 0), 0)
  )

/** 导出账本快照；只含聚合数字，不含任何对话正文 */
export const exportLedger = () => ({
  generatedAt: new Date().toISOString(),
  version: LEDGER_VERSION,
  keepDays: LEDGER_KEEP_DAYS,
  days: useLedger.getState().days,
})

/** CSV 导出：一行一天，方便丢进表格软件继续算 */
export const ledgerCsv = (series: DayUsage[]): string => {
  const header = [
    'date',
    'requests',
    'input_uncached',
    'cache_read',
    'cache_write',
    'output',
    'tokens_total',
    'cost_cny',
    'searches',
    'pages',
  ]
  const rows = series.map((day) => [
    day.date,
    day.requests,
    day.input,
    day.cacheRead,
    day.cacheWrite,
    day.output,
    day.input + day.cacheRead + day.cacheWrite + day.output,
    day.cost.toFixed(6),
    day.searches,
    day.pages,
  ])
  return [header, ...rows].map((row) => row.join(',')).join('\n')
}

/** 清空账本；统计页的「清空用量账本」走这里 */
export const clearLedger = () => {
  write({})
  useLedger.setState({ days: {} })
}
