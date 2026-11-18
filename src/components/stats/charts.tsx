import clsx from 'clsx'
import { useId } from 'react'
import styles from './charts.module.css'

/**
 * 统计图表的轻量实现：柱状图、热力图、环形构成、迷你趋势线、压力表。
 *
 * 全部用 SVG / div 手绘，不引入图表库：这些图形只需要固定几种形态，
 * 依赖图表库反而会增加构建体积，也不方便跟随主题变量换色。
 * 每个图形都带 aria-label，并把数值放在 title 里，鼠标悬停即可看到原始数字。
 */

export type BarColumn = {
  key: string
  /** 轴标签，通常只显示日期的「日」 */
  label: string
  /** 主柱数值（token） */
  primary: number
  /** 次柱数值（费用），没有就不画 */
  secondary?: number
  /** 悬停提示 */
  title: string
}

/** 柱状图：每天一对柱子，左边 token、右边费用 */
export const BarChart = ({
  columns,
  ariaLabel,
  className,
  height,
}: {
  columns: BarColumn[]
  ariaLabel: string
  className?: string
  /** 图表高度，默认 132px；小时分布等窄图可以调矮 */
  height?: number
}) => {
  const primaryMax = Math.max(1, ...columns.map((item) => item.primary))
  const secondaryMax = Math.max(1, ...columns.map((item) => item.secondary ?? 0))
  return (
    <div
      className={clsx(styles.bars, className)}
      style={height === undefined ? undefined : { height }}
      role="img"
      aria-label={ariaLabel}
    >
      {columns.map((column) => (
        <div key={column.key} className={styles.column} title={column.title}>
          <div className={styles.pair}>
            <span
              className={styles.barPrimary}
              style={{ height: `${Math.max(1.5, (column.primary / primaryMax) * 100)}%` }}
            />
            {column.secondary === undefined ? null : (
              <span
                className={styles.barSecondary}
                style={{
                  height: `${column.secondary > 0 ? Math.max(1.5, (column.secondary / secondaryMax) * 100) : 0}%`,
                }}
              />
            )}
          </div>
          <span className={styles.barLabel}>{column.label}</span>
        </div>
      ))}
    </div>
  )
}

export type HeatCell = {
  key: string
  /** 0-4 强度等级 */
  level: number
  /** 悬停提示 */
  title: string
}

/** 热力图：按列铺开，每列 7 天；列数由调用方决定（最近 N 周） */
export const Heatmap = ({
  cells,
  ariaLabel,
  className,
}: {
  cells: HeatCell[]
  ariaLabel: string
  className?: string
}) => (
  <div className={clsx(styles.heatmap, className)} role="img" aria-label={ariaLabel}>
    {cells.map((cell) => (
      <span key={cell.key} className={styles.heatCell} data-level={cell.level} title={cell.title} />
    ))}
  </div>
)

export type RingSegment = { key: string; label: string; value: number }

/** 环形构成：value 为 0 的段直接跳过，全 0 时画一个空环 */
export const RingChart = ({
  segments,
  centerLabel,
  centerValue,
  ariaLabel,
  className,
}: {
  segments: RingSegment[]
  centerLabel: string
  centerValue: string
  ariaLabel: string
  className?: string
}) => {
  const total = segments.reduce((sum, item) => sum + item.value, 0)
  let offset = 0
  return (
    <div className={clsx(styles.ring, className)} role="img" aria-label={ariaLabel}>
      <svg viewBox="0 0 100 100" className={styles.ringSvg} aria-hidden>
        <circle className={styles.ringTrack} cx="50" cy="50" r="40" pathLength={100} />
        {total > 0
          ? segments.map((segment, index) => {
              const share = (segment.value / total) * 100
              const dash = Math.max(0, share)
              const element = (
                <circle
                  key={segment.key}
                  className={styles[`ringSegment${(index % 5) + 1}`]}
                  cx="50"
                  cy="50"
                  r="40"
                  pathLength={100}
                  strokeDasharray={`${dash} ${100 - dash}`}
                  strokeDashoffset={-offset}
                />
              )
              offset += dash
              return element
            })
          : null}
      </svg>
      <div className={styles.ringCenter}>
        <span className={styles.ringValue}>{centerValue}</span>
        <span className={styles.ringLabel}>{centerLabel}</span>
      </div>
    </div>
  )
}

/** 迷你趋势线：只表达形状，具体数值看旁边的文字 */
export const Sparkline = ({
  values,
  ariaLabel,
  className,
}: {
  values: number[]
  ariaLabel: string
  className?: string
}) => {
  const gradientId = useId()
  if (values.length === 0) {
    return <div className={clsx(styles.spark, className)} aria-hidden />
  }
  const max = Math.max(1, ...values)
  const step = values.length > 1 ? 100 / (values.length - 1) : 100
  const points = values.map((value, index) => {
    const x = values.length > 1 ? index * step : 50
    const y = 100 - (value / max) * 92 - 4
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  return (
    <svg
      className={clsx(styles.spark, className)}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,100 ${points.join(' ')} 100,100`} fill={`url(#${gradientId})`} />
      <polyline className={styles.sparkLine} points={points.join(' ')} />
    </svg>
  )
}

/** 压力表：上下文占用比例，超过 80% 变警示色 */
export const PressureGauge = ({
  percent,
  label,
  ariaLabel,
  className,
}: {
  percent: number
  label: string
  ariaLabel: string
  className?: string
}) => {
  const clamped = Math.max(0, Math.min(100, percent))
  const warn = clamped >= 80
  return (
    <div
      className={clsx(styles.gauge, className)}
      data-warn={warn || undefined}
      role="img"
      aria-label={ariaLabel}
    >
      <svg viewBox="0 0 100 54" className={styles.gaugeSvg} aria-hidden>
        <path
          className={styles.gaugeTrack}
          d="M6 48 A44 44 0 0 1 94 48"
          pathLength={100}
          fill="none"
        />
        <path
          className={styles.gaugeFill}
          d="M6 48 A44 44 0 0 1 94 48"
          pathLength={100}
          strokeDasharray={`${clamped} 100`}
          fill="none"
        />
      </svg>
      <span className={styles.gaugeLabel}>{label}</span>
    </div>
  )
}
