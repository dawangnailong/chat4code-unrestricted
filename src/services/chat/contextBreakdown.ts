import { create } from 'zustand'
import type { MessageParam } from '../api/types.js'
import { estimateTokens } from './sessionStats.js'

/**
 * 上下文分类统计：把「这一轮真正发出去的上下文」按用途拆开。
 *
 * 分类口径（能分清的都分开）：
 * - system：系统提示词与 latest_reminder（包括自定义思维链、记忆、搜索投毒等注入内容）
 * - toolDefs：工具定义（服务端工具 + 浏览器 / 工作区工具的 schema 与描述）
 * - userMessages：用户文本消息
 * - assistantText：历史里的模型回复正文
 * - thinking：历史里的模型思考块
 * - toolCalls：工具调用参数（含服务端工具调用）
 * - toolResults：工具结果（客户端 tool_result 与服务端搜索结果 / 网页结果）
 * - files：附件（图片、文档按文件引用粗略折算）
 *
 * token 数按字符权重估算（中文 1 字 1 token，其余 4 字符 1 token），
 * 与设置页「提示词预览」用的是同一套口径；服务端上报的准确用量仍在别处展示。
 */

export type ContextCategory =
  | 'system'
  | 'toolDefs'
  | 'userMessages'
  | 'assistantText'
  | 'thinking'
  | 'toolCalls'
  | 'toolResults'
  | 'files'

export const CONTEXT_CATEGORIES: ContextCategory[] = [
  'system',
  'toolDefs',
  'userMessages',
  'assistantText',
  'thinking',
  'toolCalls',
  'toolResults',
  'files',
]

export type ContextBreakdown = Record<ContextCategory, number>

export const emptyBreakdown = (): ContextBreakdown => ({
  system: 0,
  toolDefs: 0,
  userMessages: 0,
  assistantText: 0,
  thinking: 0,
  toolCalls: 0,
  toolResults: 0,
  files: 0,
})

const tokensOf = (text: string): number => (text ? estimateTokens(text) : 0)

type BlockLike = Record<string, unknown>

const isRecord = (value: unknown): value is BlockLike =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 单个内容块落到哪个分类 */
const classifyBlock = (block: unknown, breakdown: ContextBreakdown) => {
  if (typeof block === 'string') {
    breakdown.userMessages += tokensOf(block)
    return
  }
  if (!isRecord(block)) {
    return
  }
  const type = block.type
  if (type === 'text') {
    const text = typeof block.text === 'string' ? block.text : ''
    // 历史模型回复与用户消息靠消息角色区分，这里按「有 text 就算正文」处理，
    // 用户消息在上层已经处理过，所以默认算作模型回复。
    breakdown.assistantText += tokensOf(text)
    return
  }
  if (type === 'thinking') {
    breakdown.thinking += tokensOf(typeof block.thinking === 'string' ? block.thinking : '')
    return
  }
  if (type === 'tool_use' || type === 'server_tool_use') {
    breakdown.toolCalls += tokensOf(JSON.stringify(block.input ?? {}))
    return
  }
  if (type === 'tool_result') {
    const content = block.content
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    breakdown.toolResults += tokensOf(text)
    return
  }
  if (type === 'web_search_tool_result' || type === 'web_fetch_tool_result') {
    breakdown.toolResults += tokensOf(JSON.stringify(block.content ?? block))
    return
  }
  if (type === 'image' || type === 'document') {
    // 附件走 Files API，客户端没有 token 数，按固定量级粗估
    breakdown.files += 320
    return
  }
}

/** 计算一轮请求的上下文分类 */
export const buildContextBreakdown = (input: {
  system: string
  tools: unknown[]
  messages: MessageParam[]
}): ContextBreakdown => {
  const breakdown = emptyBreakdown()
  breakdown.system += tokensOf(input.system)
  if (input.tools.length > 0) {
    breakdown.toolDefs += tokensOf(JSON.stringify(input.tools))
  }
  for (const message of input.messages) {
    if (message.role === 'latest_reminder') {
      breakdown.system += tokensOf(message.content)
      continue
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        breakdown.userMessages += tokensOf(message.content)
        continue
      }
      for (const block of message.content) {
        if (isRecord(block) && block.type === 'text') {
          breakdown.userMessages += tokensOf(typeof block.text === 'string' ? block.text : '')
          continue
        }
        if (isRecord(block) && (block.type === 'image' || block.type === 'document')) {
          breakdown.files += 320
        }
      }
      continue
    }
    // assistant：逐块分类
    for (const block of message.content) {
      classifyBlock(block, breakdown)
    }
  }
  return breakdown
}

/** 分类合计，用于百分比 */
export const breakdownTotal = (breakdown: ContextBreakdown): number =>
  CONTEXT_CATEGORIES.reduce((sum, key) => sum + breakdown[key], 0)

// ---------- 持久化：每个会话最近一轮的分类 ----------

const STORAGE_KEY = 'chat-demo:context-breakdown'
const MAX_ENTRIES = 200

type Entry = { at: number; parts: ContextBreakdown }
type State = { byId: Record<string, Entry> }

const read = (): Record<string, Entry> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    const result: Record<string, Entry> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<Entry> | null
      if (!entry || typeof entry.at !== 'number' || typeof entry.parts !== 'object') {
        continue
      }
      const parts = emptyBreakdown()
      for (const key of CONTEXT_CATEGORIES) {
        const raw2 = (entry.parts as Record<string, unknown>)[key]
        parts[key] = typeof raw2 === 'number' && Number.isFinite(raw2) ? Math.max(0, raw2) : 0
      }
      result[id] = { at: entry.at, parts }
    }
    return result
  } catch {
    return {}
  }
}

const write = (byId: Record<string, Entry>) => {
  try {
    const entries = Object.entries(byId)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // 隐私模式忽略
  }
}

export const useContextBreakdown = create<State>(() => ({ byId: read() }))

/** 一轮请求开始时记录它的上下文分类 */
export const noteContextBreakdown = (sessionId: string, parts: ContextBreakdown) => {
  const total = breakdownTotal(parts)
  if (total <= 0) {
    return
  }
  const byId = { ...useContextBreakdown.getState().byId, [sessionId]: { at: Date.now(), parts } }
  useContextBreakdown.setState({ byId })
  write(byId)
}

/** 清除分类记录；统计页「清空上下文记录」一并清掉 */
export const clearContextBreakdown = (sessionId?: string) => {
  if (sessionId === undefined) {
    useContextBreakdown.setState({ byId: {} })
    write({})
    return
  }
  if (!Object.hasOwn(useContextBreakdown.getState().byId, sessionId)) {
    return
  }
  const byId = Object.fromEntries(
    Object.entries(useContextBreakdown.getState().byId).filter(([key]) => key !== sessionId)
  )
  useContextBreakdown.setState({ byId })
  write(byId)
}
