import { streamMessage } from '../api/provider.js'
import type { MessageUsage } from '../api/types.js'
import { estimateRequestCost, usageCost } from '../chat/sessionStats.js'
import { generateVariants } from '../unrestricted/parseltongue.js'
import { looksLikeRefusal } from '../unrestricted/refusal.js'
import { scoreResponse } from '../unrestricted/scoring.js'
import type { VariantTier } from '../unrestricted/techniques.js'

/**
 * 变体赛跑：按扰动档位生成 11/22/33 个改写变体，分批并发请求同一模型，
 * 逐条打分，取最高分；分数达到阈值后提前收工，并受预算上限约束。
 *
 * 语义对齐 G0DM0D3 `index.html` 的 `executeParseltongue`：
 * BATCH_SIZE=6、批内 100ms 错峰、领先分数 >=65 跳过剩余变体。
 */

export type VariantModel = 'deepseek-flash' | 'deepseek-v4-pro'

export type VariantStatus =
  | 'pending'
  | 'streaming'
  | 'done'
  | 'refused'
  | 'error'
  | 'skipped'
  | 'aborted'

export type VariantResult = {
  id: string
  technique: string
  label: string
  /** 改写后实际发送的文本 */
  text: string
  status: VariantStatus
  score: number
  durationMs: number
  /** 该请求的花费（元） */
  cost: number
  error?: string
  output?: string
}

export type VariantOptions = {
  apiKey: string
  query: string
  tier: VariantTier
  model: VariantModel
  system: string
  /** 预算上限（元），实际花费达到该值后不再发起新请求 */
  budget: number
  maxOutputTokens: number
  /** 批大小，默认 6（与上游一致） */
  batchSize?: number
}

export type VariantRun = {
  results: VariantResult[]
  leader: VariantResult | null
  /** 已花费（元） */
  spent: number
  variants: number
  /** 因预算或提前收工未发起的变体数 */
  skipped: number
}

export type VariantEstimate = {
  variants: number
  /** 单请求最坏花费（元） */
  perRequest: number
  /** 预算允许的请求数 */
  affordable: number
  /** 全部变体的最坏花费（元） */
  worstCase: number
}

const BATCH_SIZE = 6
const STAGGER_MS = 100
/** 领先分数达到该值就提前收工，省下剩余请求 */
const EARLY_STOP_SCORE = 65

/** 预算与变体数量估算：输入按整段 system + 问题、输出按上限计算最坏值 */
export const estimateVariantRun = (options: VariantOptions): VariantEstimate => {
  const variants = generateVariants(options.query, options.tier).length
  const perRequest = estimateRequestCost(
    options.model,
    `${options.system}\n${options.query}`,
    options.maxOutputTokens
  )
  const affordable = perRequest <= 0 ? variants : Math.floor(options.budget / perRequest)
  return {
    variants,
    perRequest,
    affordable: Math.min(variants, Math.max(0, affordable)),
    worstCase: perRequest * variants,
  }
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

const readFailure = (failure: unknown): string =>
  failure instanceof Error ? failure.message || failure.name : String(failure)

/**
 * 执行一轮变体赛跑。`onUpdate` 在每条完成时回调全量快照；
 * 预算或提前收工后，剩余变体标记为 skipped。
 */
export const runVariantRace = async (
  options: VariantOptions,
  handlers: { onUpdate: (run: VariantRun) => void; signal: AbortSignal }
): Promise<VariantRun> => {
  const variants = generateVariants(options.query, options.tier)
  const results: VariantResult[] = variants.map((variant) => ({
    id: `variant-${variant.index}`,
    technique: variant.technique,
    label: variant.label,
    text: variant.text,
    status: 'pending',
    score: 0,
    durationMs: 0,
    cost: 0,
  }))

  const state = {
    results,
    leader: null as VariantResult | null,
    spent: 0,
    variants: variants.length,
    skipped: 0,
  }
  const snapshot = (): VariantRun => ({
    results: state.results.map((result) => ({ ...result })),
    leader: state.leader ? { ...state.leader } : null,
    spent: state.spent,
    variants: state.variants,
    skipped: state.skipped,
  })
  const update = () => handlers.onUpdate(snapshot())

  const batchSize = Math.max(1, options.batchSize ?? BATCH_SIZE)
  const perRequest = estimateRequestCost(
    options.model,
    `${options.system}\n${options.query}`,
    options.maxOutputTokens
  )
  const affordable = perRequest <= 0 ? variants.length : Math.floor(options.budget / perRequest)

  const runOne = async (result: VariantResult, variant: (typeof variants)[number]) => {
    // 批内也可能已经触到预算：剩余的变体不再发请求
    if (handlers.signal.aborted || state.spent >= options.budget) {
      result.status = handlers.signal.aborted ? 'aborted' : 'skipped'
      state.skipped += 1
      update()
      return
    }
    result.status = 'streaming'
    update()
    const startedAt = Date.now()
    let usage: MessageUsage | undefined
    let stopReason: string | undefined
    try {
      const body = {
        model: options.model,
        system: options.system,
        messages: [{ role: 'user' as const, content: variant.text }],
        thinking: { type: 'disabled' as const },
        temperature: variant.temperature,
        top_p: variant.topP,
        tools: [],
      }
      let output = ''
      for await (const event of streamMessage(
        options.apiKey,
        body,
        handlers.signal,
        `vrace_${result.id}`
      )) {
        if (event.type === 'content_block_start' && event.content_block.type === 'text') {
          output += event.content_block.text
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          output += event.delta.text
        } else if (event.type === 'message_start') {
          usage = event.message.usage ?? usage
        } else if (event.type === 'message_delta') {
          usage = event.usage ?? usage
          stopReason = event.delta.stop_reason
        }
      }
      result.output = output
      if (handlers.signal.aborted) {
        result.status = 'aborted'
      } else if (stopReason === 'refusal' || looksLikeRefusal(output, 0)) {
        result.status = 'refused'
      } else if (output.trim() === '') {
        result.status = 'error'
        result.error = 'empty'
      } else {
        result.status = 'done'
        result.score = scoreResponse(output, options.query)
      }
    } catch (failure) {
      if (handlers.signal.aborted) {
        result.status = 'aborted'
      } else {
        result.status = 'error'
        result.error = readFailure(failure)
      }
    } finally {
      result.durationMs = Date.now() - startedAt
      result.cost = usage
        ? usageCost(options.model, usage)
        : estimateRequestCost(options.model, variant.text, options.maxOutputTokens)
      state.spent += result.cost
      if (result.status === 'done' && (!state.leader || result.score > state.leader.score)) {
        state.leader = result
      }
      update()
    }
  }

  const runBatch = async (
    batch: Array<{ result: VariantResult; variant: (typeof variants)[number] }>
  ) => {
    await Promise.all(
      batch.map(({ result, variant }, index) =>
        delay(index * STAGGER_MS, handlers.signal).then(() => runOne(result, variant))
      )
    )
  }

  const toRun = variants.slice(0, Math.min(variants.length, Math.max(0, affordable)))
  for (let start = 0; start < toRun.length; start += batchSize) {
    if (handlers.signal.aborted) {
      break
    }
    if (state.leader && state.leader.score >= EARLY_STOP_SCORE) {
      break
    }
    if (state.spent >= options.budget) {
      break
    }
    const batch = toRun.slice(start, start + batchSize).map((variant, offset) => ({
      result: results[start + offset],
      variant,
    }))
    await runBatch(batch)
  }

  // 未发起的变体统一标 skipped
  for (const result of results) {
    if (result.status === 'pending') {
      result.status = handlers.signal.aborted ? 'aborted' : 'skipped'
      state.skipped += 1
    }
  }
  update()
  return snapshot()
}
