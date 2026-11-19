import { ApiError } from '../api/client.js'
import { getContextRounds } from './reply.js'
import type { FileAttachment, Message, UserMessage } from './types.js'
import { applyAttachmentPoison, attachmentPoisonSignature } from '../attachmentPoison.js'
import { sniffImageType } from './imageType.js'
import * as db from './db.js'
import { useSettings } from '../settings.js'
import { formatSize } from '../attachments.js'

/**
 * OpenCode Bridge 通道的图片内联装配：bridge 没有 DeepSeek Files API，
 * 每次发送把上下文里最近 N 张图片从本地原件转成 Anthropic base64 块；
 * 其余图片替换为占位文本。本地存储（IndexedDB 原件）不受任何影响。
 */

/** base64 字符总量预算；预留约 8 MiB 给文本与其余请求体（扩展默认上限 32 MiB） */
export const BRIDGE_IMAGE_BUDGET_BASE64 = 24 * 1024 * 1024

/** Anthropic Messages 接受的图片 media_type */
const SUPPORTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** 单次请求内联的图片张数上限；设置里可配 1-10 */
export const BRIDGE_INLINE_IMAGE_COUNT_MAX = 10

export type InlineImagePayload =
  | { kind: 'inline'; mediaType: string; data: string }
  | { kind: 'omitted' }

type Candidate = { file: FileAttachment; isCurrentTurn: boolean }

/** 把 blob 编码为 base64；分块处理避免超长字符串调用栈溢出 */
const encodeBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** 加载图片并转码为 PNG；失败返回 null（解码失败或无 canvas 环境） */
const transcodeToPng = async (blob: Blob): Promise<Blob | null> => {
  if (typeof document === 'undefined' || !('createImageBitmap' in globalThis)) {
    return null
  }
  try {
    const bitmap = await createImageBitmap(blob)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')
      if (!context) {
        return null
      }
      context.drawImage(bitmap, 0, 0)
      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((output) => resolve(output), 'image/png')
      })
    } finally {
      bitmap.close()
    }
  } catch {
    return null
  }
}

/** 解析内联所需的 media_type 与最终 blob：不支持的格式转码为 PNG */
const resolveMedia = async (
  blob: Blob,
  mimeType: string
): Promise<{ blob: Blob; mediaType: string } | null> => {
  if (SUPPORTED_MEDIA_TYPES.has(mimeType)) {
    return { blob, mediaType: mimeType }
  }
  const header = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  const sniffed = sniffImageType(header)
  if (SUPPORTED_MEDIA_TYPES.has(sniffed)) {
    return { blob, mediaType: sniffed }
  }
  // bmp / tiff / avif 等接口不接受的格式：转码为 PNG；未知格式同样尝试转码
  const png = await transcodeToPng(blob)
  return png ? { blob: png, mediaType: 'image/png' } : null
}

/**
 * 组装本次请求的图片载荷：按「本轮提问 → 历史轮次（新到旧）」的顺序内联最近 N 张，
 * 其余标记为 omitted 由渲染层替换为占位文本。
 * - 本轮图片无本地原件或单张超预算时中止发送（可重试）；
 * - 历史图片缺原件或失败时静默降级为 omitted，下次发送再试。
 */
export const buildBridgeImages = async (
  sessionId: string,
  request: { history: Message[]; question: UserMessage },
  signal: AbortSignal,
  peekFile: (sessionId: string, fileId: string) => Blob | undefined
): Promise<Map<string, InlineImagePayload>> => {
  const { bridgeInlineImageCount, attachmentPoison } = useSettings.getState()
  const limit = Math.min(
    BRIDGE_INLINE_IMAGE_COUNT_MAX,
    Math.max(1, Math.round(bridgeInlineImageCount))
  )
  const signature = attachmentPoisonSignature(attachmentPoison)

  // 候选按新到旧排列：本轮提问优先内联，历史从最近的轮次往前取
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  const collect = (files: FileAttachment[], isCurrentTurn: boolean) => {
    for (const file of files) {
      if (!file.isImage || file.generated || seen.has(file.id)) {
        continue
      }
      seen.add(file.id)
      candidates.push({ file, isCurrentTurn })
    }
  }
  collect(request.question.files, true)
  for (const [user] of getContextRounds(request.history).toReversed()) {
    collect(user.files, false)
  }

  const payloads = new Map<string, InlineImagePayload>()
  let inlined = 0
  let budget = BRIDGE_IMAGE_BUDGET_BASE64
  for (const { file, isCurrentTurn } of candidates) {
    signal.throwIfAborted()
    // 超出张数上限的历史图片降级为占位文本；本轮图片不受张数影响（见下）
    if (inlined >= limit && !isCurrentTurn) {
      payloads.set(file.id, { kind: 'omitted' })
      continue
    }
    let blob = peekFile(sessionId, file.id)
    if (!blob) {
      blob = await db.loadFile(file.id)
    }
    if (!blob) {
      if (isCurrentTurn) {
        throw new ApiError('http', { key: 'bridgeAttachmentMissing', params: { name: file.name } })
      }
      payloads.set(file.id, { kind: 'omitted' })
      continue
    }
    // 附件投毒在发送时对副本应用：IndexedDB 原件保持干净，改配置后下次发送自然生效
    if (signature !== 'off' && file.poison !== 'skip') {
      try {
        const poisoned = await applyAttachmentPoison(blob, file.name, true, attachmentPoison)
        blob = poisoned.blob
      } catch {
        // 投毒失败不阻断发送，回退为原文件
      }
    }
    const resolved = await resolveMedia(blob, file.mimeType)
    if (!resolved) {
      if (isCurrentTurn) {
        throw new ApiError('http', {
          key: 'bridgeImageFormatUnsupported',
          params: { name: file.name },
        })
      }
      payloads.set(file.id, { kind: 'omitted' })
      continue
    }
    const data = await encodeBase64(resolved.blob)
    if (data.length > budget) {
      if (isCurrentTurn) {
        throw new ApiError('http', {
          key: 'bridgeImageTooLarge',
          params: { name: file.name, size: formatSize(data.length) },
        })
      }
      payloads.set(file.id, { kind: 'omitted' })
      continue
    }
    budget -= data.length
    inlined += 1
    payloads.set(file.id, { kind: 'inline', mediaType: resolved.mediaType, data })
  }
  // 本轮图片始终内联（即使超过张数上限也优先保证新内容可见），占位只发生在历史图片上
  return payloads
}
