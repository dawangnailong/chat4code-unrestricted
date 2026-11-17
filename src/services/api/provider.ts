import { useSettings } from '../settings.js'
import { streamViaBridge, listBridgeModels, connectBridge } from './bridge.js'
import { request, streamMessage as streamDeepseek, verifyApiKey, ApiError, API_ORIGIN } from './client.js'
import { fetchRemoteModels, builtinModels, type ModelOption } from './models.js'
import type { ApiProvider, CreateMessageRequest, MessageStreamEvent } from './types.js'

/**
 * Provider 门面：唯一同时了解 settings 与各传输层的 API 模块。
 * 默认 deepseek 通道保持原行为；opencode-bridge 通道把请求交给扩展。
 */

export { ApiError, API_ORIGIN, request }
export type { ApiErrorKind } from './client.js'

export const isBridgeMode = (): boolean =>
  useSettings.getState().apiProvider === 'opencode-bridge'

export const builtinProviderModels = (provider: ApiProvider): ModelOption[] =>
  builtinModels(provider)

/**
 * 流式对话：bridge 模式使用扩展的 Anthropic Messages 传输，
 * 否则走原有的 DeepSeek 直连。sessionId 仅 bridge 模式使用。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  sessionId?: string
): AsyncGenerator<MessageStreamEvent> {
  const { apiProvider, bridgeExtensionId, maxTokens } = useSettings.getState()
  if (apiProvider === 'opencode-bridge') {
    yield* streamViaBridge(body, signal, sessionId ?? 'adhoc', {
      extensionId: bridgeExtensionId,
      maxTokens,
    })
    return
  }
  yield* streamDeepseek(apiKey, body, signal)
}

/**
 * 校验当前通道是否可用：
 * - DeepSeek：GET /models
 * - bridge：连接扩展并拉取模型目录（同时验证扩展已安装、Origin 已授权、Key 已配置）
 */
export const verifyProvider = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  if (isBridgeMode()) {
    const extensionId = useSettings.getState().bridgeExtensionId
    await connectBridge(extensionId)
    await listBridgeModels(extensionId, signal)
    return
  }
  await verifyApiKey(apiKey, signal)
}

/** 云端模型列表：bridge 模式使用扩展的 /v1/models，否则走 DeepSeek 的兼容端点 */
export const fetchProviderModels = async (
  apiKey: string,
  signal?: AbortSignal
): Promise<ModelOption[]> => {
  if (isBridgeMode()) {
    const extensionId = useSettings.getState().bridgeExtensionId
    if (!extensionId.trim()) {
      throw new Error('missing extension id')
    }
    return listBridgeModels(extensionId, signal)
  }
  return fetchRemoteModels(apiKey)
}
