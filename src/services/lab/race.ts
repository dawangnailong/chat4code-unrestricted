/**
 * 多路赛跑引擎：用同一份测试问题并发调用选中的 Hall of Fame 提示词组合，
 * 逐流收集回复、按综合分打分，交给实验台的「多路赛跑」视图展示。
 *
 * 组合模板、深度指令、输入扰动与打分都复用 G0DM0D3 的移植实现
 * （libertas / prompts / parseltongue / scoring），这里只负责组装请求和手写并发池。
 */
import { streamMessage } from '../api/provider.js'
import type { CreateMessageRequest } from '../api/types.js'
import { applyHallOfFameCombo, HALL_OF_FAME } from '../unrestricted/libertas.js'
import {
  applyParseltongue,
  type ObfuscationTechnique,
  type ParseltongueConfig,
} from '../unrestricted/parseltongue.js'
import { DEPTH_DIRECTIVE } from '../unrestricted/prompts.js'
import { scoreResponse } from '../unrestricted/scoring.js'

export type RaceModel = 'deepseek-v4-pro' | 'deepseek-flash'

/** 候选状态：排队中、流式输出、正常完成、出错、被用户中止 */
export type RaceStatus = 'pending' | 'streaming' | 'done' | 'error' | 'aborted'

export type RaceResult = {
  id: string
  codename: string
  color: string
  model: RaceModel
  status: RaceStatus
  text: string
  score: number
  durationMs: number
  error?: string
  /** 该候选最终使用的系统提示词，供结果卡片的「用此组合开新会话」复用 */
  system?: string
}

export type RaceOptions = {
  apiKey: string
  query: string
  comboIds: string[]
  model: RaceModel | 'mixed'
  concurrency: number
  depth: boolean
  parseltongue: {
    enabled: boolean
    technique: ObfuscationTechnique
    intensity: 'light' | 'medium' | 'heavy'
  }
  unrestricted: boolean
}

/** 界面展示用的组合清单，由 Hall of Fame 映射而来，不含提示词正文 */
export const RACE_COMBOS: Array<{
  id: string
  codename: string
  description: string
  color: string
}> = HALL_OF_FAME.map((combo) => ({
  id: combo.id,
  codename: combo.codename,
  description: combo.description,
  color: combo.color,
}))

/** 一个候选：结果对象与提前组装好的请求体 */
type Candidate = {
  result: RaceResult
  body: CreateMessageRequest
}

/** 把异常转成卡片上展示的错误文案；ApiError 继承自 Error，取 message 即可 */
const readFailure = (failure: unknown): string => {
  if (failure instanceof Error) {
    return failure.message || failure.name
  }
  return String(failure)
}

/** 同一个问题在不同候选下的请求体：模型按混合模式交替，扰动只作用于 user 文本 */
const buildCandidate = (
  comboId: string,
  index: number,
  options: RaceOptions,
  query: string,
  parseltongueConfig: ParseltongueConfig
): Candidate | null => {
  const combo = HALL_OF_FAME.find((item) => item.id === comboId)
  if (!combo) {
    return null
  }
  const applied = applyHallOfFameCombo(combo, query)
  const system = options.depth ? `${applied.system}${DEPTH_DIRECTIVE}` : applied.system
  // 扰动只改 user 侧，避免把系统提示词里的占位符与指令结构打散
  const userText = applyParseltongue(applied.user, parseltongueConfig).transformedText
  const model: RaceModel =
    options.model === 'mixed'
      ? index % 2 === 0
        ? 'deepseek-v4-pro'
        : 'deepseek-flash'
      : options.model

  return {
    result: {
      id: combo.id,
      codename: combo.codename,
      color: combo.color,
      model,
      status: 'pending',
      text: '',
      score: 0,
      durationMs: 0,
      system,
    },
    body: {
      model,
      system,
      messages: [{ role: 'user', content: userText }],
      thinking: { type: 'disabled' },
      temperature: 0.8,
      top_p: 0.95,
      tools: [],
      ...(options.unrestricted ? {} : { safety_check: { level: 'low' as const } }),
    },
  }
}

/**
 * 跑一轮赛跑：并发上限取 1–6，某个候选完成就回调一次全量快照。
 * 返回最终结果；被中止的候选标记为 aborted，未开始的候选同样标记为 aborted。
 */
export const runRace = async (
  options: RaceOptions,
  handlers: { onUpdate: (results: RaceResult[]) => void; signal: AbortSignal }
): Promise<RaceResult[]> => {
  const query = options.query.trim()
  const parseltongueConfig: ParseltongueConfig = {
    enabled: options.parseltongue.enabled,
    technique: options.parseltongue.technique,
    intensity: options.parseltongue.intensity,
    customTriggers: [],
  }

  const candidates: Candidate[] = []
  for (const comboId of options.comboIds) {
    const candidate = buildCandidate(comboId, candidates.length, options, query, parseltongueConfig)
    if (candidate) {
      candidates.push(candidate)
    }
  }

  const results: RaceResult[] = candidates.map((candidate) => candidate.result)
  const snapshot = (): RaceResult[] => results.map((result) => ({ ...result }))
  const update = () => handlers.onUpdate(snapshot())
  const requested = Number.isFinite(options.concurrency) ? Math.round(options.concurrency) : 3
  const limit = Math.min(6, Math.max(1, requested))
  let cursor = 0

  /** 中止时把排队中与正在流式的候选统一标成 aborted */
  const abortRemaining = () => {
    for (const result of results) {
      if (result.status === 'pending' || result.status === 'streaming') {
        result.status = 'aborted'
      }
    }
  }

  const runCandidate = async (candidate: Candidate): Promise<void> => {
    const { result, body } = candidate
    result.status = 'streaming'
    update()
    const startedAt = Date.now()
    try {
      let text = ''
      for await (const event of streamMessage(
        options.apiKey,
        body,
        handlers.signal,
        `race_${result.id}`
      )) {
        // 文本块的起始事件可能已经带内容，直接累加可兼容多文本块
        if (event.type === 'content_block_start' && event.content_block.type === 'text') {
          text += event.content_block.text
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text
        }
      }
      result.text = text
      result.score = scoreResponse(text, query)
      result.status = 'done'
    } catch (failure) {
      if (handlers.signal.aborted) {
        result.status = 'aborted'
      } else {
        result.status = 'error'
        result.error = readFailure(failure)
      }
    } finally {
      result.durationMs = Date.now() - startedAt
      update()
    }
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      if (handlers.signal.aborted) {
        abortRemaining()
        update()
        return
      }
      const index = cursor
      cursor += 1
      if (index >= candidates.length) {
        return
      }
      await runCandidate(candidates[index])
    }
  }

  // 手写并发池：先起 limit 个 worker，各自从共享游标取下一个候选
  const workers: Promise<void>[] = []
  for (let index = 0; index < limit && index < candidates.length; index += 1) {
    workers.push(worker())
  }
  await Promise.all(workers)

  if (handlers.signal.aborted) {
    abortRemaining()
  }
  update()
  return snapshot()
}
