/**
 * Hand-written declarations for the vendored OpenCode Bridge web SDK.
 * Source: https://github.com/debiandawangnailong7-coder/opencode-bridge
 * Commit: deadcb8 (MIT)
 */

export type BridgeHeaders = Record<string, string>

export type BridgeResponse = {
  status: number
  headers: BridgeHeaders
  body: string
  json: unknown
}

export type BridgeRequestOptions = {
  signal?: AbortSignal
}

export type BridgeFetchOptions = {
  /** Defaults to matching /chat/completions, /responses, /anthropic/v1/messages. */
  matchUrl?: (url: string) => boolean
}

export type BridgeConversationOptions = {
  /** 1-128 characters: letters, digits, dot, underscore, colon, or hyphen. */
  sessionId?: string
}

export type BridgeOptions = {
  extensionId: string
  portName?: string
  helloTimeoutMs?: number
}

export type BridgeStreamBody = { stream: true } & Record<string, unknown>
export type BridgeNonStreamBody = { stream?: false } & Record<string, unknown>

export class OpenCodeBridgeError extends Error {
  code: string
  status?: number
  statusText?: string
  headers?: BridgeHeaders
  body?: string
  requestId?: string
}

export class SSEParser {
  feed(chunk: string): { event: string; data: string; id: string; retry: number }[]
  flush(): { event: string; data: string; id: string; retry: number }[]
}

export class Conversation {
  readonly bridge: OpenCodeBridge
  readonly sessionId: string
  readonly chat: {
    completions: {
      create(
        body: BridgeStreamBody,
        options?: BridgeRequestOptions
      ): Promise<AsyncIterable<unknown>>
      create(
        body: BridgeNonStreamBody,
        options?: BridgeRequestOptions
      ): Promise<BridgeResponse>
    }
  }
  readonly responses: {
    create(
      body: BridgeStreamBody,
      options?: BridgeRequestOptions
    ): Promise<AsyncIterable<unknown>>
    create(
      body: BridgeNonStreamBody,
      options?: BridgeRequestOptions
    ): Promise<BridgeResponse>
  }
  readonly messages: {
    create(
      body: BridgeStreamBody,
      options?: BridgeRequestOptions
    ): Promise<AsyncIterable<unknown>>
    create(
      body: BridgeNonStreamBody,
      options?: BridgeRequestOptions
    ): Promise<BridgeResponse>
  }
  createFetch(options?: BridgeFetchOptions): typeof fetch
}

export class OpenCodeBridge {
  constructor(options: BridgeOptions)
  readonly extensionId: string
  connect(): Promise<this>
  createConversation(options?: BridgeConversationOptions): Conversation
  readonly models: {
    list(options?: BridgeRequestOptions): Promise<BridgeResponse>
  }
  close(): void
}
