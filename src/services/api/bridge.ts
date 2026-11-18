import type { TranslationKey, TranslationMessage } from '../../i18n/index.js'
import type {
  Conversation,
  OpenCodeBridge,
  OpenCodeBridgeError,
} from '../../vendor/opencode-bridge/opencode-bridge.js'
import { ApiError, type ApiErrorKind } from './client.js'
import { parseModels, writeCachedModels, type ModelOption } from './models.js'
import { readMessageEvent } from './parseEvent.js'
import type {
  AssistantBlockParam,
  CreateMessageRequest,
  MessageParam,
  MessageStreamEvent,
} from './types.js'

/**
 * OpenCode Bridge 传输层：把应用现有的 Anthropic Messages 请求体转成
 * bridge 能接受的形状，交给扩展后台发出。页面侧会自动协商传输方式：
 * Chrome 走 direct port，Safari 走 content-script relay（window.postMessage）；
 * 请求最终由扩展 service worker / offscreen document 发出。
 * API Key 由扩展自行保存并注入，这里不接触 Key。
 */

/** bridge 校验要求 max_tokens 必填；设置里没填时使用该默认值 */
export const BRIDGE_MAX_TOKENS_DEFAULT = 8192

const SESSION_ID_MAX = 128
const ERROR_MESSAGE_MAX = 300

const MODEL_MAP: Record<string, string> = {
  'deepseek-flash': 'deepseek-v4.1-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
}

type BridgeModule = typeof import('../../vendor/opencode-bridge/opencode-bridge.js')

let modulePromise: Promise<BridgeModule> | null = null
let bridge: OpenCodeBridge | null = null
let bridgeExtensionId = ''
const conversations = new Map<string, Conversation>()

const loadBridgeModule = (): Promise<BridgeModule> => {
  modulePromise ??= import('../../vendor/opencode-bridge/opencode-bridge.js')
  return modulePromise
}

/** 把聊天会话 id 整理成 bridge 允许的 ses_ 前缀 id */
export const sanitizeBridgeSessionId = (raw: string): string => {
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]/g, '_').replace(/^_+/, '')
  const base = cleaned || 'adhoc'
  const prefixed = base.startsWith('ses_') ? base : `ses_${base}`
  return prefixed.slice(0, SESSION_ID_MAX)
}

/** 连接扩展；扩展 ID 变化时重建连接并丢弃旧会话 */
export const connectBridge = async (extensionId: string): Promise<OpenCodeBridge> => {
  const id = extensionId.trim()
  if (!id) {
    throw new ApiError('network', { key: 'bridgeExtensionIdMissing' })
  }
  if (bridge && bridgeExtensionId === id) {
    return bridge
  }
  const mod = await loadBridgeModule()
  const next = new mod.OpenCodeBridge({ extensionId: id })
  try {
    await next.connect()
  } catch (error) {
    next.close()
    throw toBridgeError(error)
  }
  bridge?.close()
  conversations.clear()
  bridge = next
  bridgeExtensionId = id
  return next
}

/** 当前 bridge 协商出的传输方式：direct（Chrome 主路径）或 relay（Safari content script） */
export const getBridgeTransport = (): 'direct' | 'relay' | null => bridge?.transport ?? null

/**
 * 丢弃当前连接，下一次请求重新握手。
 * Safari 回收扩展后台后，页面上旧的 direct port 可能已失效却不再触发 onDisconnect；
 * 继续复用会让之后每次发送都在 postMessage 上失败，只能重新建立连接。
 */
export const resetBridgeConnection = () => {
  bridge?.close()
  bridge = null
  bridgeExtensionId = ''
  conversations.clear()
}

/** 同一聊天会话复用同一个 bridge conversation，保证 x-opencode-session 稳定 */
export const getBridgeConversation = async (
  extensionId: string,
  sessionId: string
): Promise<Conversation> => {
  const instance = await connectBridge(extensionId)
  const id = sanitizeBridgeSessionId(sessionId)
  const cached = conversations.get(id)
  if (cached) {
    return cached
  }
  const conversation = instance.createConversation({ sessionId: id })
  conversations.set(id, conversation)
  return conversation
}

/** 拉取 Go / Console 的模型目录 */
export const listBridgeModels = async (
  extensionId: string,
  signal?: AbortSignal
): Promise<ModelOption[]> => {
  const instance = await connectBridge(extensionId)
  let response
  try {
    response = await instance.models.list({ signal })
  } catch (error) {
    throw failBridge(error, signal)
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(
      'http',
      {
        key: 'bridgeErrorUpstreamHttp',
        params: { status: response.status, message: truncate(response.body) },
      },
      response.status
    )
  }
  const models = parseModels(response.json)
  if (models.length > 0) {
    writeCachedModels('opencode-bridge', models)
  }
  return models
}

/**
 * 以流式方式调用 Anthropic Messages，逐个产出应用认识的 MessageStreamEvent。
 * bridge SDK 已经解析 SSE，这里只做事件规范化与中断语义对齐。
 */
export async function* streamViaBridge(
  body: CreateMessageRequest,
  signal: AbortSignal,
  sessionId: string,
  options: { extensionId: string; maxTokens: number | null }
): AsyncGenerator<MessageStreamEvent> {
  const conversation = await getBridgeConversation(options.extensionId, sessionId)
  const bridgeBody = toBridgeBody(body, options.maxTokens)
  let events: AsyncIterable<unknown>
  try {
    events = await conversation.messages.create(
      { ...bridgeBody, stream: true },
      { signal }
    )
  } catch (error) {
    throw failBridge(error, signal)
  }

  let sawMessageStop = false
  try {
    for await (const raw of events) {
      if (signal.aborted) {
        throw signal.reason
      }
      const event = readMessageEvent(raw)
      if (!event) {
        continue
      }
      yield event
      if (event.type === 'message_stop') {
        sawMessageStop = true
        return
      }
    }
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason
    }
    throw failBridge(error, signal)
  }
  if (!sawMessageStop) {
    // 与 DeepSeek 传输层一致：没有 message_stop 就按断流处理
    throw new ApiError('interrupted', '')
  }
}

// ---------------------------------------------------------------------------
// 请求体清洗
// ---------------------------------------------------------------------------

type BridgeTextBlock = { type: 'text'; text: string }
type BridgeMessage =
  | { role: 'user'; content: string | BridgeTextBlock[] }
  | { role: 'assistant'; content: BridgeTextBlock[] }

type BridgeBody = {
  model: string
  max_tokens: number
  system?: string
  messages: BridgeMessage[]
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number }
  temperature?: number
  top_p?: number
}

/** 把应用请求体转成 bridge / OpenCode 能接受的标准 Anthropic 形状 */
export const toBridgeBody = (
  body: CreateMessageRequest,
  maxTokensSetting: number | null
): BridgeBody => {
  const result: BridgeBody = {
    model: MODEL_MAP[body.model] ?? body.model,
    max_tokens: body.max_tokens ?? maxTokensSetting ?? BRIDGE_MAX_TOKENS_DEFAULT,
    messages: toBridgeMessages(body.messages),
  }
  if (body.system) {
    result.system = body.system
  }
  if (body.thinking) {
    // Anthropic 的 enabled thinking 需要 budget_tokens；降级请求只有 type 时干脆不下发
    if (body.thinking.type === 'enabled' && body.thinking.budget_tokens) {
      result.thinking = { type: 'enabled', budget_tokens: body.thinking.budget_tokens }
    } else if (body.thinking.type === 'disabled') {
      result.thinking = { type: 'disabled' }
    }
  }
  if (body.temperature !== undefined) {
    result.temperature = body.temperature
  }
  if (body.top_p !== undefined) {
    result.top_p = body.top_p
  }
  // 丢弃 safety_check / title / reasoning_effort / deepseek_* 工具：
  // 它们不在 OpenCode 的 Anthropic 兼容层里。
  return result
}

const toBridgeMessages = (messages: MessageParam[]): BridgeMessage[] => {
  const out: BridgeMessage[] = []
  let pendingReminder = ''

  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      pendingReminder = pendingReminder ? `${pendingReminder}\n\n${message.content}` : message.content
      continue
    }
    if (message.role === 'user') {
      const blocks = toUserTextBlocks(message.content)
      if (pendingReminder) {
        blocks.unshift({ type: 'text', text: pendingReminder })
        pendingReminder = ''
      }
      if (blocks.length === 0) {
        continue
      }
      out.push({ role: 'user', content: blocks })
      continue
    }
    if (message.role === 'assistant') {
      const text = toAssistantText(message.content)
      if (text.trim() === '') {
        continue
      }
      out.push({ role: 'assistant', content: [{ type: 'text', text }] })
    }
  }

  if (pendingReminder) {
    // 末尾提醒没有后续 user 可合并：独立成一条 user 消息，Anthropic 会按连续 user 合并
    out.push({ role: 'user', content: pendingReminder })
  }
  return out
}

const toUserTextBlocks = (
  content: Extract<MessageParam, { role: 'user' }>['content']
): BridgeTextBlock[] => {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  return content.flatMap((block): BridgeTextBlock[] =>
    block.type === 'text' ? [{ type: 'text', text: block.text }] : []
  )
}

const toAssistantText = (blocks: AssistantBlockParam[]): string =>
  blocks.flatMap((block): string[] => (block.type === 'text' ? [block.text] : [])).join('')

// ---------------------------------------------------------------------------
// 错误映射
// ---------------------------------------------------------------------------

const BRIDGE_ERROR_MAP: Record<string, { kind: ApiErrorKind; key: TranslationKey }> = {
  AUTH_MISSING: { kind: 'http', key: 'bridgeErrorAuthMissing' },
  ORIGIN_DENIED: { kind: 'network', key: 'bridgeErrorOriginDenied' },
  NO_CHROME_RUNTIME: { kind: 'network', key: 'bridgeErrorExtensionMissing' },
  NO_BRIDGE_TRANSPORT: { kind: 'network', key: 'bridgeErrorExtensionMissing' },
  CONTENT_SCRIPT_MISSING: { kind: 'network', key: 'bridgeErrorContentScriptMissing' },
  EXTENSION_ID_REQUIRED: { kind: 'network', key: 'bridgeErrorExtensionMissing' },
  CONNECT_FAILED: { kind: 'network', key: 'bridgeErrorExtensionMissing' },
  // Safari 没有 offscreen，扩展在 service worker 里 fetch，首字节超过 25 秒会被中止
  CONNECT_TIMEOUT: { kind: 'network', key: 'bridgeErrorTimeout' },
  HELLO_TIMEOUT: { kind: 'network', key: 'bridgeErrorNoResponse' },
  NETWORK_ERROR: { kind: 'network', key: 'bridgeErrorNetwork' },
  CLOSED: { kind: 'network', key: 'bridgeErrorNetwork' },
  BAD_TRANSPORT: { kind: 'network', key: 'bridgeErrorNetwork' },
  SW_DISCONNECTED: { kind: 'protocol', key: 'bridgeErrorDisconnected' },
  OFFSCREEN_DISCONNECTED: { kind: 'protocol', key: 'bridgeErrorDisconnected' },
  RELAY_CLOSED: { kind: 'protocol', key: 'bridgeErrorDisconnected' },
  BAD_REQUEST: { kind: 'http', key: 'bridgeErrorBadRequest' },
  BODY_TOO_LARGE: { kind: 'http', key: 'bridgeErrorBodyTooLarge' },
  RESPONSE_TOO_LARGE: { kind: 'stream', key: 'bridgeErrorResponseTooLarge' },
}

const truncate = (text: string): string =>
  text.length > ERROR_MESSAGE_MAX ? `${text.slice(0, ERROR_MESSAGE_MAX)}…` : text

/** 把 bridge SDK 错误转成应用统一的 ApiError；保留上游 status 以复用 400 降级逻辑 */
export const toBridgeError = (error: unknown, signal?: AbortSignal): unknown => {
  if (signal?.aborted) {
    return signal.reason
  }
  if (error instanceof ApiError) {
    return error
  }
  const record = error as Partial<OpenCodeBridgeError> | null
  const code = typeof record?.code === 'string' ? record.code : ''
  if (code === 'ABORTED') {
    return new ApiError('network', { key: 'bridgeErrorNetwork' })
  }
  if (code === 'UPSTREAM_HTTP_ERROR') {
    const status = typeof record?.status === 'number' ? record.status : undefined
    const message = truncate(record?.body ?? record?.message ?? '')
    return new ApiError(
      'http',
      {
        key: 'bridgeErrorUpstreamHttp',
        params: { status: status ?? '', message },
      },
      status
    )
  }
  const mapped = BRIDGE_ERROR_MAP[code]
  if (mapped) {
    return new ApiError(mapped.kind, { key: mapped.key })
  }
  // 未登记的上游/扩展错误码（STREAM_ERROR、CONFIG_ERROR 等）保留原始说明，
  // 否则用户只会看到「网络异常」，无法判断是配置、超时还是扩展断开。
  const detail = typeof record?.message === 'string' ? truncate(record.message) : ''
  const message: TranslationMessage = detail
    ? { key: 'bridgeErrorUnknown', params: { message: detail } }
    : { key: 'bridgeErrorNetwork' }
  return new ApiError('network', message)
}

/**
 * 映射错误，并在连接/协议类失败后丢弃当前 bridge。
 * 上游 HTTP 错误说明通道仍然可用，保留连接以便直接重试。
 */
function failBridge(error: unknown, signal?: AbortSignal): unknown {
  const mapped = toBridgeError(error, signal)
  if (!signal?.aborted && !(mapped instanceof ApiError && mapped.kind === 'http')) {
    resetBridgeConnection()
  }
  return mapped
}
