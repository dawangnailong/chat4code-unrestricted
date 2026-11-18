import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { contextWindowFor, useContextUsage } from '../../services/chat/contextUsage.js'
import {
  effectiveContextTokens,
  pressurePercent,
  reserveGeometry,
} from '../../services/chat/contextPressure.js'
import { useChatStore } from '../../services/chat/store.js'
import { useMemoryBank } from '../../services/chat/memoryBank.js'
import { useSettings } from '../../services/settings.js'
import { Tooltip } from '../base/Tooltip.js'
import styles from './ContextRing.module.css'

const SIZE = 30
const STROKE = 2.5
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** 30k / 1.2M 这类紧凑写法，和状态条保持一致 */
const formatTokens = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1000)}k`
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`
  }
  return String(value)
}

/**
 * 上下文占用圆环：把本轮请求的 token 数按模型窗口折算成百分比。
 * 数据来自服务端上报的用量，用圆环而不是数字，放在输入框底部不抢视线。
 */
export const ContextRing = ({
  sessionId,
  streaming = false,
  onOpen,
}: {
  sessionId: string | null
  streaming?: boolean
  /** 点击圆环打开会话统计（移动端没有独立的统计按钮） */
  onOpen?: () => void
}) => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  const maxTokens = useSettings((state) => state.maxTokens)
  const usage = useContextUsage((state) => (sessionId ? state.byId[sessionId] : undefined))
  const compression = useChatStore((state) =>
    sessionId ? state.sessionCache[sessionId]?.compression : undefined
  )
  const memoryNodes = useMemoryBank((state) => state.nodes.length)
  const memoryEdges = useMemoryBank((state) => state.edges.length)
  const tokens = effectiveContextTokens(usage?.tokens ?? 0, usage?.at ?? 0, compression)
  const window = contextWindowFor(model)
  const reserve = reserveGeometry(window, maxTokens ?? 8192)
  const percent = pressurePercent(tokens, window)
  const ratio = window > 0 ? Math.min(1, tokens / window) : 0
  const level = ratio >= 0.85 ? 'full' : ratio >= 0.6 ? 'high' : 'normal'
  const tip = [
    t('contextUsageTip', {
      used: formatTokens(tokens),
      total: formatTokens(window),
      percent: Math.round(percent),
    }),
    reserve
      ? t('contextPressureLine', {
          threshold: formatTokens(reserve.threshold),
          percent: Math.round((reserve.threshold / window) * 100),
        })
      : null,
    compression
      ? t('contextCompressionLine', {
          rounds: compression.rounds,
          saved: formatTokens(compression.savedTokens ?? 0),
        })
      : null,
    memoryNodes > 0 ? t('contextMemoryLine', { nodes: memoryNodes, edges: memoryEdges }) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Tooltip content={tokens > 0 ? tip : t('contextUsageEmpty')}>
      <button
        type="button"
        className={clsx(styles.ring, streaming && styles.active)}
        data-level={level}
        data-empty={tokens === 0 || undefined}
        data-compressed={compression ? true : undefined}
        aria-label={t('contextUsageLabel', { percent: Math.round(percent) })}
        onClick={onOpen}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
          <circle
            className={styles.track}
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
          />
          <circle
            className={styles.value}
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </svg>
        {/* 没有用量时给一个破折号，比 0 更像「还没开始」 */}
        <span className={styles.percent}>{tokens > 0 ? Math.round(percent) : '–'}</span>
      </button>
    </Tooltip>
  )
}
