import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { mimeForPath, workspaceFileBytes, type WorkspaceFile } from './store.js'

/**
 * 工作区 ZIP 归档：任意文件都能原样往返。
 *
 * - 导出：把每个文件按原始字节写进 ZIP，目录结构沿用工作区路径；
 * - 导入：unzipSync 解出所有条目，目录与 macOS 元数据条目自动跳过。
 * 之前导出的 JSON 备份仍然可以在设置页导入，ZIP 是新的默认格式。
 */

export type ArchiveEntry = { name: string; bytes: Uint8Array; mime: string }

/** 导出 ZIP；保留路径层级 */
export const exportWorkspaceZip = (files: WorkspaceFile[]): Blob => {
  const entries: Record<string, Uint8Array> = {}
  for (const file of files) {
    // ZIP 内部不允许绝对路径；工作区路径已经是相对的
    entries[file.path] = workspaceFileBytes(file)
  }
  const zipped = zipSync(entries, { level: 6 })
  return new Blob([zipped], { type: 'application/zip' })
}

const shouldSkip = (name: string): boolean =>
  name.endsWith('/') ||
  name.startsWith('__MACOSX/') ||
  name.split('/').some((segment) => segment === '.DS_Store' || segment === '')

/** 解出 ZIP 里的全部文件；损坏的包返回空数组 */
export const readWorkspaceZip = (bytes: Uint8Array): ArchiveEntry[] => {
  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(bytes)
  } catch {
    return []
  }
  const entries: ArchiveEntry[] = []
  for (const [name, content] of Object.entries(unzipped)) {
    if (shouldSkip(name) || content.length === 0) {
      continue
    }
    entries.push({ name, bytes: content, mime: mimeForPath(name) })
  }
  return entries
}

/** 把纯文本包成 Uint8Array，导入流程统一走字节 */
export const textToBytes = (text: string): Uint8Array => strToU8(text)

/** 读取文本（用于 JSON 备份） */
export const bytesToText = (bytes: Uint8Array): string => strFromU8(bytes)
