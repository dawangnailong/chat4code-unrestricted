/**
 * MCP（Streamable HTTP）最小客户端。
 *
 * 只实现实验台需要的三件事：initialize、tools/list、tools/call。
 * 服务端返回 SSE（event: message / data: {...}）或单条 JSON，这里统一解析。
 */

type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const PROTOCOL_VERSION = '2025-06-18'

export class McpClient {
  private readonly endpoint: string
  private sessionId: string | null = null
  private nextId = 1

  constructor(endpoint: string) {
    this.endpoint = endpoint
  }

  get connected(): boolean {
    return this.sessionId !== null
  }

  get baseUrl(): string {
    return this.endpoint
  }

  /** 建立会话：initialize + notifications/initialized。 */
  async connect(): Promise<void> {
    const response = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'chat4code-unrestricted-lab', version: '1.0.0' },
      },
    })
    const session = response.headers.get('mcp-session-id')
    if (!session) {
      throw new Error('MCP 服务端没有返回 Mcp-Session-Id，无法建立会话')
    }
    this.sessionId = session
    const message = this.parseMessage(await response.text())
    if (message.error) {
      throw new Error(message.error.message)
    }
    await this.notify('notifications/initialized')
  }

  /** 列出服务端工具，返回工具名与描述。 */
  async listTools(): Promise<{ name: string; description?: string }[]> {
    const result = (await this.call('tools/list')) as {
      tools?: { name: string; description?: string }[]
    }
    return result.tools ?? []
  }

  /** 调用一个工具，并把 content[0].text 当作 JSON 解析。 */
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await this.call('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string }[]
      isError?: boolean
    }
    const text = result?.content?.find((item) => item.type === 'text')?.text
    if (text === undefined) {
      throw new Error('MCP 工具没有返回文本内容')
    }
    if (result.isError) {
      throw new Error(text)
    }
    return JSON.parse(text) as T
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: '2.0', method })
  }

  private async call(method: string, params?: unknown): Promise<unknown> {
    const response = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params })
    const message = this.parseMessage(await response.text())
    if (message.error) {
      throw new Error(message.error.message)
    }
    return message.result
  }

  private async post(payload: JsonRpcMessage): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId
    }
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      throw new Error(`MCP 请求失败：HTTP ${response.status}`)
    }
    return response
  }

  private parseMessage(text: string): JsonRpcMessage {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
    const raw = dataLines.length > 0 ? dataLines[dataLines.length - 1] : text.trim()
    try {
      return JSON.parse(raw) as JsonRpcMessage
    } catch {
      throw new Error(`MCP 返回内容无法解析：${raw.slice(0, 200)}`)
    }
  }
}
