import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { translate } from '../../i18n/index.js'

/**
 * 网状记忆库（参考 Operit 的 Memory / MemoryLink / 向量检索）：
 * - 每个节点有标题、正文、标签、重要度、可信度；
 * - 节点之间用带权重的边连接，新增节点时按向量相似度自动连边；
 * - 检索同时考虑关键词、标签、向量与边扩散，并输出调试明细。
 * 向量在本地用确定性哈希生成，维度可配置，不依赖远端 embedding 服务。
 */

const STORAGE_KEY = 'chat-demo:memory-bank'
const MAX_NODES = 500
const MAX_EDGES = 2000

export type MemoryNode = {
  id: string
  title: string
  content: string
  tags: string[]
  importance: number
  credibility: number
  source: 'manual' | 'saved'
  savedMemoryId?: string
  createdAt: number
  updatedAt: number
  lastAccessedAt: number
}

export type MemoryEdge = {
  id: string
  sourceId: string
  targetId: string
  type: string
  weight: number
  description: string
}

export type MemorySearchConfig = {
  dimension: number
  limit: number
  threshold: number
  keywordWeight: number
  tagWeight: number
  vectorWeight: number
  edgeWeight: number
}

export type MemorySearchCandidate = {
  nodeId: string
  title: string
  keyword: number
  tag: number
  vector: number
  edge: number
  total: number
  passed: boolean
}

export type MemorySearchDebug = {
  query: string
  tokens: string[]
  config: MemorySearchConfig
  nodes: number
  edges: number
  keywordMatches: number
  tagMatches: number
  vectorMatches: number
  edgesTraversed: number
  candidates: MemorySearchCandidate[]
  results: MemoryNode[]
}

type MemoryBankState = { nodes: MemoryNode[]; edges: MemoryEdge[] }

export type MemorySearchSnapshot = {
  at: number
  query: string
  dimension: number
  nodes: number
  edges: number
  passed: number
  topScore: number
}

/** 聊天栏统计用：最近一次实际注入前的记忆检索结果（不持久化） */
export const useMemorySearchStats = create<{ last: MemorySearchSnapshot | null }>(() => ({
  last: null,
}))

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'what',
  'when',
  'where',
  'which',
  'have',
  'has',
  'are',
  'was',
  'were',
  'you',
  'your',
  'about',
  'into',
  'can',
  'how',
  'why',
  '什么',
  '怎么',
  '为什么',
  '可以',
  '请问',
  '一下',
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '这些',
  '那些',
  '刚才',
  '之前',
  '以前',
  '今天',
  '现在',
  '的',
  '了',
  '吗',
  '呢',
  '吧',
  '啊',
  '我',
  '你',
  '他',
  '她',
  '它',
  '是',
  '在',
  '有',
  '和',
  '就',
  '都',
  '还',
  '要',
  '会',
  '能',
])

/** 中英混合分词：英文按词，中文按单字 + 二元词组 */
export const tokenizeMemory = (text: string): string[] => {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()
  const words = lower.match(/[a-z0-9_.-]{2,}/g)
  if (words) {
    for (const word of words) {
      if (!STOP_WORDS.has(word)) {
        tokens.add(word)
      }
    }
  }
  const runs = lower.match(/[\u4e00-\u9fff]+/g)
  if (runs) {
    for (const run of runs) {
      for (let i = 0; i < run.length; i++) {
        const ch = run[i]
        if (!STOP_WORDS.has(ch)) {
          tokens.add(ch)
        }
        if (i + 1 < run.length) {
          const bigram = run.slice(i, i + 2)
          if (!STOP_WORDS.has(bigram)) {
            tokens.add(bigram)
          }
        }
      }
    }
  }
  return [...tokens]
}

const hashToken = (token: string): number => {
  let hash = 2166136261
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 确定性哈希向量，L2 归一化；维度变化时重新计算即可 */
export const embedText = (text: string, dimension: number): number[] => {
  const size = Math.max(8, Math.floor(dimension))
  const vector = new Array<number>(size).fill(0)
  for (const token of tokenizeMemory(text)) {
    const hash = hashToken(token)
    const index = hash % size
    const sign = hash & 1 ? 1 : -1
    vector[index] += sign * (token.length >= 2 ? 1.6 : 0.8)
  }
  let norm = 0
  for (const value of vector) {
    norm += value * value
  }
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm)
    for (let i = 0; i < vector.length; i++) {
      vector[i] *= scale
    }
  }
  return vector
}

const cosine = (a: number[], b: number[]): number => {
  const size = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < size; i++) {
    dot += a[i] * b[i]
  }
  return dot
}

const read = (): MemoryBankState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { nodes: [], edges: [] }
    }
    const parsed = JSON.parse(raw) as Partial<MemoryBankState>
    const nodes = Array.isArray(parsed.nodes)
      ? parsed.nodes.filter(
          (node): node is MemoryNode =>
            typeof node === 'object' &&
            node !== null &&
            typeof (node as MemoryNode).id === 'string' &&
            typeof (node as MemoryNode).title === 'string' &&
            typeof (node as MemoryNode).content === 'string'
        )
      : []
    const edges = Array.isArray(parsed.edges)
      ? parsed.edges.filter(
          (edge): edge is MemoryEdge =>
            typeof edge === 'object' &&
            edge !== null &&
            typeof (edge as MemoryEdge).sourceId === 'string' &&
            typeof (edge as MemoryEdge).targetId === 'string'
        )
      : []
    return { nodes, edges }
  } catch {
    return { nodes: [], edges: [] }
  }
}

const write = (state: MemoryBankState) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 存储不可用时只保留内存状态
  }
}

export const useMemoryBank = create<MemoryBankState>(() => read())

const commit = (state: MemoryBankState) => {
  const nodes = state.nodes.slice(0, MAX_NODES)
  const ids = new Set(nodes.map((node) => node.id))
  const edges = state.edges
    .filter((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId))
    .slice(0, MAX_EDGES)
  const next = { nodes, edges }
  write(next)
  useMemoryBank.setState(next)
}

const makeNode = (
  input: {
    title?: string
    content: string
    tags?: string[]
    importance?: number
    credibility?: number
  },
  source: MemoryNode['source'],
  savedMemoryId?: string
): MemoryNode => {
  const content = input.content.trim()
  const title = (input.title ?? content.slice(0, 40)).trim() || content.slice(0, 40)
  const now = Date.now()
  return {
    id: createId(),
    title,
    content,
    tags: (input.tags ?? [])
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 8),
    importance: Math.min(1, Math.max(0, input.importance ?? 0.5)),
    credibility: Math.min(1, Math.max(0, input.credibility ?? 0.7)),
    source,
    ...(savedMemoryId ? { savedMemoryId } : {}),
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
  }
}

/** 新节点按向量相似度自动连边，形成网状记忆 */
const autoLink = (
  node: MemoryNode,
  nodes: MemoryNode[],
  edges: MemoryEdge[],
  dimension: number
) => {
  const sourceVector = embedText(`${node.title}\n${node.content}`, dimension)
  const scored = nodes
    .filter((item) => item.id !== node.id)
    .map((item) => ({
      item,
      score: cosine(sourceVector, embedText(`${item.title}\n${item.content}`, dimension)),
    }))
    .filter((entry) => entry.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  const added: MemoryEdge[] = []
  for (const { item, score } of scored) {
    const duplicate = edges.some(
      (edge) =>
        (edge.sourceId === node.id && edge.targetId === item.id) ||
        (edge.sourceId === item.id && edge.targetId === node.id)
    )
    if (duplicate) {
      continue
    }
    added.push({
      id: createId(),
      sourceId: node.id,
      targetId: item.id,
      type: 'related',
      weight: Math.min(1, Math.max(0.05, score)),
      description: '向量相似自动关联',
    })
  }
  return [...edges, ...added]
}

export const addMemoryNode = (
  input: {
    title?: string
    content: string
    tags?: string[]
    importance?: number
    credibility?: number
  },
  dimension = 256
): MemoryNode | null => {
  const content = input.content.trim()
  if (!content) {
    return null
  }
  const current = useMemoryBank.getState()
  const duplicate = current.nodes.find((node) => node.content.trim() === content)
  if (duplicate) {
    return duplicate
  }
  const node = makeNode({ ...input, content }, 'manual')
  const edges = autoLink(node, current.nodes, current.edges, dimension)
  commit({ nodes: [node, ...current.nodes], edges })
  return node
}

/** 长期记忆变更后同步到记忆库；同一条 savedMemoryId 只保留一个节点 */
export const upsertSavedMemoryNode = (
  savedMemoryId: string,
  content: string,
  dimension = 256
): void => {
  const text = content.trim()
  if (!text) {
    return
  }
  const current = useMemoryBank.getState()
  const existing = current.nodes.find((node) => node.savedMemoryId === savedMemoryId)
  if (existing) {
    const updated: MemoryNode = {
      ...existing,
      title: text.slice(0, 40),
      content: text,
      updatedAt: Date.now(),
    }
    commit({
      nodes: current.nodes.map((node) => (node.id === existing.id ? updated : node)),
      edges: current.edges,
    })
    return
  }
  const node = makeNode({ content: text }, 'saved', savedMemoryId)
  const edges = autoLink(node, current.nodes, current.edges, dimension)
  commit({ nodes: [node, ...current.nodes], edges })
}

export const removeSavedMemoryNode = (savedMemoryId: string) => {
  const current = useMemoryBank.getState()
  const target = current.nodes.find((node) => node.savedMemoryId === savedMemoryId)
  if (!target) {
    return
  }
  commit({
    nodes: current.nodes.filter((node) => node.id !== target.id),
    edges: current.edges.filter(
      (edge) => edge.sourceId !== target.id && edge.targetId !== target.id
    ),
  })
}

export const updateMemoryNode = (
  id: string,
  patch: Partial<Pick<MemoryNode, 'title' | 'content' | 'tags' | 'importance' | 'credibility'>>
) => {
  const current = useMemoryBank.getState()
  const node = current.nodes.find((item) => item.id === id)
  if (!node) {
    return
  }
  commit({
    nodes: current.nodes.map((item) =>
      item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item
    ),
    edges: current.edges,
  })
}

export const deleteMemoryNode = (id: string) => {
  const current = useMemoryBank.getState()
  commit({
    nodes: current.nodes.filter((node) => node.id !== id),
    edges: current.edges.filter((edge) => edge.sourceId !== id && edge.targetId !== id),
  })
}

export const clearMemoryBank = () => {
  commit({ nodes: [], edges: [] })
}

/** 导入记忆归档时整体替换节点与边 */
export const replaceMemoryBank = (nodes: MemoryNode[], edges: MemoryEdge[]) => {
  commit({ nodes, edges })
}

export type MemoryBankStats = {
  nodes: number
  edges: number
  dimension: number
  avgDegree: number
  vectorBytes: number
}

/** 向量维度使用情况：当前维度、节点数、平均度、Float32 估算占用 */
export const memoryBankStats = (dimension: number): MemoryBankStats => {
  const { nodes, edges } = useMemoryBank.getState()
  const size = Math.max(8, Math.floor(dimension))
  return {
    nodes: nodes.length,
    edges: edges.length,
    dimension: size,
    avgDegree: nodes.length === 0 ? 0 : (edges.length * 2) / nodes.length,
    vectorBytes: nodes.length * size * 4,
  }
}

const tokenOverlapScore = (queryTokens: string[], targetTokens: Set<string>): number => {
  if (queryTokens.length === 0) {
    return 0
  }
  let hit = 0
  let total = 0
  for (const token of queryTokens) {
    const weight = token.length >= 2 ? 1.5 : 0.7
    total += weight
    if (targetTokens.has(token)) {
      hit += weight
    }
  }
  return total > 0 ? hit / total : 0
}

/** 检索记忆库并返回每个候选的分数明细，供设置页「搜索调试」展示 */
export const searchMemoryBank = (query: string, config: MemorySearchConfig): MemorySearchDebug => {
  const state = useMemoryBank.getState()
  const tokens = tokenizeMemory(query)
  const queryVector = embedText(query, config.dimension)
  const base = new Map<string, MemorySearchCandidate>()

  for (const node of state.nodes) {
    const nodeTokens = new Set(tokenizeMemory(`${node.title}\n${node.content}`))
    const tagTokens = new Set(tokenizeMemory(node.tags.join(' ')))
    const keyword = tokenOverlapScore(tokens, nodeTokens)
    const tag = tokenOverlapScore(tokens, tagTokens)
    const vector = Math.max(
      0,
      cosine(queryVector, embedText(`${node.title}\n${node.content}`, config.dimension))
    )
    const total =
      keyword * config.keywordWeight + tag * config.tagWeight + vector * config.vectorWeight
    base.set(node.id, {
      nodeId: node.id,
      title: node.title,
      keyword,
      tag,
      vector,
      edge: 0,
      total,
      passed: false,
    })
  }

  // 边扩散：高分节点把一部分分数传给相邻节点，最多遍历 8 个种子
  let edgesTraversed = 0
  const seeds = [...base.values()].sort((a, b) => b.total - a.total).slice(0, 8)
  for (const seed of seeds) {
    for (const edge of state.edges) {
      if (edge.sourceId !== seed.nodeId && edge.targetId !== seed.nodeId) {
        continue
      }
      const neighborId = edge.sourceId === seed.nodeId ? edge.targetId : edge.sourceId
      const neighbor = base.get(neighborId)
      if (!neighbor) {
        continue
      }
      edgesTraversed += 1
      neighbor.edge = Math.max(neighbor.edge, seed.total * edge.weight)
    }
  }

  const candidates: MemorySearchCandidate[] = []
  for (const candidate of base.values()) {
    candidate.total =
      candidate.keyword * config.keywordWeight +
      candidate.tag * config.tagWeight +
      candidate.vector * config.vectorWeight +
      candidate.edge * config.edgeWeight
    candidate.passed = candidate.total >= config.threshold
    candidates.push(candidate)
  }
  candidates.sort((a, b) => b.total - a.total)
  const passed = candidates.filter((candidate) => candidate.passed).slice(0, config.limit)
  const nodeMap = new Map(state.nodes.map((node) => [node.id, node]))
  return {
    query,
    tokens,
    config,
    nodes: state.nodes.length,
    edges: state.edges.length,
    keywordMatches: candidates.filter((candidate) => candidate.keyword > 0).length,
    tagMatches: candidates.filter((candidate) => candidate.tag > 0).length,
    vectorMatches: candidates.filter((candidate) => candidate.vector > 0.05).length,
    edgesTraversed,
    candidates,
    results: passed
      .map((candidate) => nodeMap.get(candidate.nodeId))
      .filter((node): node is MemoryNode => node !== undefined),
  }
}

/** 把检索结果拼成可注入 system 的文本 */
export const formatMemoryBankContext = (query: string, config: MemorySearchConfig): string => {
  if (query.trim() === '') {
    return ''
  }
  const debug = searchMemoryBank(query, config)
  useMemorySearchStats.setState({
    last: {
      at: Date.now(),
      query,
      dimension: config.dimension,
      nodes: debug.nodes,
      edges: debug.edges,
      passed: debug.results.length,
      topScore: debug.candidates[0]?.total ?? 0,
    },
  })
  if (debug.results.length === 0) {
    return ''
  }
  const lines = [translate('memoryBankHeader')]
  let total = lines[0].length
  for (const node of debug.results) {
    const content = node.content.replace(/\s+/g, ' ').trim()
    const line = `- [${node.title}] ${content.length > 500 ? `${content.slice(0, 500)}…` : content}`
    if (total + line.length > 1800) {
      break
    }
    lines.push(line)
    total += line.length + 1
  }
  return lines.length > 1 ? lines.join('\n') : ''
}
