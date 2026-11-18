import { replaceSavedMemories, useSavedMemories, type SavedMemoryItem } from './savedMemory.js'
import { replaceMemoryBank, useMemoryBank, type MemoryEdge, type MemoryNode } from './memoryBank.js'

/**
 * 记忆归档：把长期记忆与网状记忆库节点/边打包成一个 JSON，
 * 支持整体替换或按内容去重合并。
 */

export type MemoryArchive = {
  version: 1
  type: 'memory-archive'
  exportedAt: string
  savedMemories: SavedMemoryItem[]
  nodes: MemoryNode[]
  edges: MemoryEdge[]
}

export type ImportMode = 'replace' | 'merge'

export const buildMemoryArchive = (): MemoryArchive => ({
  version: 1,
  type: 'memory-archive',
  exportedAt: new Date().toISOString(),
  savedMemories: useSavedMemories.getState().items,
  nodes: useMemoryBank.getState().nodes,
  edges: useMemoryBank.getState().edges,
})

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const readString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const readTime = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : Date.now()

const readSaved = (value: unknown): SavedMemoryItem[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item): SavedMemoryItem[] => {
    const record = asRecord(item)
    if (!record || typeof record.id !== 'string' || typeof record.content !== 'string') {
      return []
    }
    return [
      {
        id: record.id,
        content: record.content,
        enabled: record.enabled !== false,
        updatedAt: readTime(record.updatedAt),
      },
    ]
  })
}

const readNodes = (value: unknown): MemoryNode[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item): MemoryNode[] => {
    const record = asRecord(item)
    if (!record || typeof record.id !== 'string' || typeof record.content !== 'string') {
      return []
    }
    return [
      {
        id: record.id,
        title: readString(record.title, record.content.slice(0, 40)),
        content: record.content,
        tags: Array.isArray(record.tags)
          ? record.tags.filter((tag): tag is string => typeof tag === 'string')
          : [],
        importance: typeof record.importance === 'number' ? record.importance : 0.5,
        credibility: typeof record.credibility === 'number' ? record.credibility : 0.7,
        source: record.source === 'saved' ? 'saved' : 'manual',
        ...(typeof record.savedMemoryId === 'string'
          ? { savedMemoryId: record.savedMemoryId }
          : {}),
        createdAt: readTime(record.createdAt),
        updatedAt: readTime(record.updatedAt),
        lastAccessedAt: readTime(record.lastAccessedAt),
      },
    ]
  })
}

const readEdges = (value: unknown, nodeIds: Set<string>): MemoryEdge[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item): MemoryEdge[] => {
    const record = asRecord(item)
    if (
      !record ||
      typeof record.id !== 'string' ||
      typeof record.sourceId !== 'string' ||
      typeof record.targetId !== 'string' ||
      !nodeIds.has(record.sourceId) ||
      !nodeIds.has(record.targetId)
    ) {
      return []
    }
    return [
      {
        id: record.id,
        sourceId: record.sourceId,
        targetId: record.targetId,
        type: readString(record.type, 'related'),
        weight: typeof record.weight === 'number' ? Math.min(1, Math.max(0, record.weight)) : 0.5,
        description: readString(record.description),
      },
    ]
  })
}

export const parseMemoryArchive = (value: unknown): MemoryArchive | null => {
  const record = asRecord(value)
  if (!record || record.type !== 'memory-archive' || record.version !== 1) {
    return null
  }
  const nodes = readNodes(record.nodes)
  const nodeIds = new Set(nodes.map((node) => node.id))
  return {
    version: 1,
    type: 'memory-archive',
    exportedAt: readString(record.exportedAt, new Date().toISOString()),
    savedMemories: readSaved(record.savedMemories),
    nodes,
    edges: readEdges(record.edges, nodeIds),
  }
}

/** 应用归档；merge 按内容/ID 去重，replace 直接覆盖 */
export const applyMemoryArchive = (archive: MemoryArchive, mode: ImportMode) => {
  const currentSaved = useSavedMemories.getState().items
  const currentBank = useMemoryBank.getState()
  if (mode === 'replace') {
    replaceSavedMemories(archive.savedMemories)
    replaceMemoryBank(archive.nodes, archive.edges)
    return
  }

  const savedContents = new Set(currentSaved.map((item) => item.content.trim()))
  const saved = [...currentSaved]
  for (const item of archive.savedMemories) {
    if (!savedContents.has(item.content.trim())) {
      saved.push(item)
      savedContents.add(item.content.trim())
    }
  }
  const nodeContents = new Set(currentBank.nodes.map((node) => node.content.trim()))
  const nodeIds = new Set(currentBank.nodes.map((node) => node.id))
  const nodes = [...currentBank.nodes]
  for (const node of archive.nodes) {
    if (!nodeIds.has(node.id) && !nodeContents.has(node.content.trim())) {
      nodes.push(node)
      nodeIds.add(node.id)
      nodeContents.add(node.content.trim())
    }
  }
  const edgeKeys = new Set(currentBank.edges.map((edge) => `${edge.sourceId}->${edge.targetId}`))
  const edges = [...currentBank.edges]
  for (const edge of archive.edges) {
    const key = `${edge.sourceId}->${edge.targetId}`
    if (!edgeKeys.has(key)) {
      edges.push(edge)
      edgeKeys.add(key)
    }
  }
  replaceSavedMemories(saved)
  replaceMemoryBank(nodes, edges)
}
