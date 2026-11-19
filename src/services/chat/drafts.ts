import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import {
  cancelUpload,
  completeAttachmentLocally,
  getMaxCount,
  isImage,
  resolveMimeType,
  restartUpload,
  uploadAttachment,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import { isBridgeMode } from '../api/provider.js'
import {
  attachmentPoisonSignature,
  createPoisonSidecar,
  type AttachmentPoisonConfig,
} from '../attachmentPoison.js'
import { useSettings } from '../settings.js'
import type { FileAttachment } from './types.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件与上传任务的 key */
  id: string
  file: File
  isImage: boolean
  /** 伴随投毒文本本身不再投毒 */
  skipPoison?: boolean
  /** 由附件投毒自动生成的伴随附件 */
  generated?: boolean
}

type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** 草稿只保存在本次页面的内存中，独立于会话详情缓存；null 是新对话的草稿。 */
export const useDrafts = create<{ drafts: Map<string | null, Draft> }>(() => ({
  drafts: new Map(),
}))

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) =>
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })

export const setDraftText = (sessionId: string | null, text: string) =>
  updateDraft(sessionId, (draft) => ({ ...draft, text }))

const upload = (attachment: DraftAttachment, apiKey: string) => {
  // bridge 模式没有 Files API：原件仅存本地，任务直接完成，发送时再转 base64 内联
  if (isBridgeMode()) {
    completeAttachmentLocally(
      attachment.id,
      attachment.skipPoison
        ? 'skip'
        : attachmentPoisonSignature(useSettings.getState().attachmentPoison)
    )
    return
  }
  // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
  void uploadAttachment(
    apiKey,
    attachment.id,
    attachment.file,
    attachment.file.name,
    attachment.isImage,
    { skipPoison: attachment.skipPoison }
  ).catch(() => {})
}

/** bridge 模式接受的图片格式：Anthropic Messages 的 base64 图片 media_type 清单 */
const BRIDGE_IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** 整批校验通过后才创建预览和开始上传。 */
export const addDraftFiles = (
  sessionId: string | null,
  files: File[],
  apiKey: string
): TranslationMessage | null => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(files, getDraft(sessionId).attachments.length)
  if (error) {
    return error
  }
  if (isBridgeMode()) {
    // bridge 只支持图片内联：文档类整批拒绝；格式不在 Anthropic 支持清单的单独点名。
    if (files.some((file) => !isImage(resolveMimeType(file)))) {
      return { key: 'bridgeDocumentsUnsupported' }
    }
    const unsupported = files.find((file) => !BRIDGE_IMAGE_MEDIA_TYPES.has(resolveMimeType(file)))
    if (unsupported) {
      return { key: 'bridgeImageFormatUnsupported', params: { name: unsupported.name } }
    }
  }
  const added = files.map(
    (file): DraftAttachment => ({
      id: createId(),
      file,
      isImage: isImage(resolveMimeType(file)),
    })
  )
  // 伴随文本附件是普通附件，占一个名额；名额不足时只为前面的文件生成
  // bridge 模式不支持文档附件，伴随文本没有载体，跳过生成
  const poison = useSettings.getState().attachmentPoison
  const sidecars: DraftAttachment[] = []
  if (
    !isBridgeMode() &&
    poison.enabled &&
    poison.methods.includes('sidecar') &&
    poison.content.trim() !== ''
  ) {
    const available = Math.max(
      0,
      getMaxCount() - getDraft(sessionId).attachments.length - added.length
    )
    for (const attachment of added.slice(0, available)) {
      const file = createPoisonSidecar(attachment.file.name, poison.content)
      sidecars.push({
        id: createId(),
        file,
        isImage: false,
        skipPoison: true,
        generated: true,
      })
    }
  }
  const next = [...added, ...sidecars]
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...next] }))
  next.forEach((attachment) => upload(attachment, apiKey))
  return null
}

export const retryDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  apiKey: string
) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment) {
    // bridge 模式任务本就即时完成，重试入口不会出现；保留分支以防未来引入失败态
    upload(attachment, apiKey)
  }
}

/** 附件投毒开关变化时强制按当前设置重新上传（中止旧任务，避免旧配置的结果覆盖新任务） */
export const restartDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  apiKey: string
) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment) {
    if (isBridgeMode()) {
      // 投毒在发送时对副本应用：这里只需重盖指纹，没有旧任务可中止
      completeAttachmentLocally(
        attachment.id,
        attachment.skipPoison
          ? 'skip'
          : attachmentPoisonSignature(useSettings.getState().attachmentPoison)
      )
      return
    }
    restartUpload(
      apiKey,
      attachment.id,
      attachment.file,
      attachment.file.name,
      attachment.isImage,
      { skipPoison: attachment.skipPoison }
    )
  }
}

/** 发送按钮和实际提交共用规则：有内容，且全部附件已就绪（DeepSeek 需上传成功，bridge 本地即就绪）。 */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const bridge = isBridgeMode()
  const files: (FileAttachment & { serverId: string | null; blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    if (task?.status !== 'done') {
      return null
    }
    // bridge 任务没有服务端副本（serverId 为空串）：附件只存本地，发送时转 base64
    if (!bridge && !task.serverId) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: bridge ? null : task.serverId,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      poison: task.poison,
      ...(attachment.generated ? { generated: true } : {}),
      blob: attachment.file,
    })
  }
  return { text, files }
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  cancelUpload(attachment.id)
  updateDraft(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId),
  }))
}

/**
 * 附件投毒设置变化时同步草稿：移除旧的伴随文本附件，按新配置重新生成；
 * 原附件由调用方重新上传，确保采用新配置。bridge 模式没有伴随附件，仅清掉
 * 旧通道可能遗留的生成件。
 */
export const syncDraftSidecars = (sessionId: string | null, apiKey: string) => {
  const draft = getDraft(sessionId)
  const generated = draft.attachments.filter((attachment) => attachment.generated)
  const originals = draft.attachments.filter((attachment) => !attachment.generated)
  generated.forEach((attachment) => cancelUpload(attachment.id))

  if (isBridgeMode()) {
    updateDraft(sessionId, (current) => ({
      ...current,
      attachments: [...originals],
    }))
    return
  }

  const poison: AttachmentPoisonConfig = useSettings.getState().attachmentPoison
  const sidecars: DraftAttachment[] = []
  if (poison.enabled && poison.methods.includes('sidecar') && poison.content.trim() !== '') {
    const available = Math.max(0, getMaxCount() - originals.length)
    for (const original of originals.slice(0, available)) {
      const file = createPoisonSidecar(original.file.name, poison.content)
      sidecars.push({
        id: createId(),
        file,
        isImage: false,
        skipPoison: true,
        generated: true,
      })
    }
  }
  updateDraft(sessionId, (current) => ({
    ...current,
    attachments: [...originals, ...sidecars],
  }))
  sidecars.forEach((attachment) => upload(attachment, apiKey))
}

/** 发送成功后原件与 serverId 已交给会话，保留上传完成态。 */
export const clearSentDraft = (sessionId: string | null) => {
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿及上传任务。 */
export const clearDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => cancelUpload(attachment.id))
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

export const clearAllDrafts = () => {
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach((attachment) => cancelUpload(attachment.id))
  }
  useDrafts.setState({ drafts: new Map() })
}
