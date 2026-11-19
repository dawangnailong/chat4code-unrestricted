import clsx from 'clsx'
import { useEffect, useMemo, useReducer, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { TranslationKey } from '../../i18n/index.js'
import { readLiveMetrics, subscribeLiveTick, useLiveStats } from '../../services/chat/liveStats.js'
import {
  aggregateSession,
  estimateCost,
  estimateTokens,
  formatMoney,
  formatTokens,
} from '../../services/chat/sessionStats.js'
import { setSessionCompression, useChatStore } from '../../services/chat/store.js'
import { compressSession } from '../../services/chat/compression.js'
import { contextWindowFor, useContextUsage } from '../../services/chat/contextUsage.js'
import {
  effectiveContextTokens,
  pressurePercent,
  reserveGeometry,
} from '../../services/chat/contextPressure.js'
import { useSettings } from '../../services/settings.js'
import { syncDailyUsageDate, useDailyUsage } from '../../services/chat/dailyUsage.js'
import { modelLabel } from '../../services/api/models.js'
import { useMemoryBank, useMemorySearchStats } from '../../services/chat/memoryBank.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { Modal } from '../base/Modal.js'
import { Switch } from '../base/Switch.js'
import { PressureGauge, RingChart, Sparkline } from '../stats/charts.js'
import { ledgerSeries, ledgerTotals, useLedger } from '../../services/chat/usageLedger.js'
import {
  CONTEXT_CATEGORIES,
  breakdownTotal,
  useContextBreakdown,
} from '../../services/chat/contextBreakdown.js'
import { readVoiceUsage } from '../../services/chat/sessionStats.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeStats, useStatsDialog } from './statsDialogState.js'
import styles from './StatsDialog.module.css'

/**
 * 会话统计弹窗：本次生成的实时指标、整个会话的累计用量，
 * 以及按官方单价估算的费用。金额与 token 的格式化统一走 sessionStats。
 */

/** 首 token：1 秒以内按毫秒展示，超过按两位小数秒 */
const formatFirstToken = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`

/** 秒级时长：10 秒以内保留一位小数，更长只取整秒 */
const formatSeconds = (ms: number): string => {
  const seconds = ms / 1000
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`
}

/** 百分比：保留一位小数 */
const formatPercent = (rate: number): string => `${(rate * 100).toFixed(1)}%`

/** 空会话或还没有回复没有任何金额可算 */
const NO_VALUE = '—'

type MetricItem = { key: TranslationKey; value: string }

export const StatsDialog = () => {
  const open = useStatsDialog((state) => state.open)
  return open ? <StatsContent /> : null
}

const StatsContent = () => {
  const t = useTranslate()
  const activeId = useChatStore((state) => state.activeId)
  const session = useChatStore((state) =>
    activeId ? (state.sessionCache[activeId] ?? null) : null
  )
  const totals = useMemo(() => aggregateSession(session), [session])
  const [holiday, setHoliday] = useState(false)
  const [discount, setDiscount] = useState(true)
  const [compressing, setCompressing] = useState(false)
  const locale = useSettings((state) => state.locale)
  const apiKey = useSettings((state) => state.apiKey) ?? ''
  const maxTokens = useSettings((state) => state.maxTokens)
  const model = useSettings((state) => state.model)
  const serverSearchFree = useSettings((state) => state.serverSearchFree)
  const memoryDimension = useSettings((state) => state.memoryBankDimension)
  const memoryNodes = useMemoryBank((state) => state.nodes.length)
  const memoryEdges = useMemoryBank((state) => state.edges.length)
  const lastMemorySearch = useMemorySearchStats((state) => state.last)
  const usage = useContextUsage((state) => (activeId ? state.byId[activeId] : undefined))
  // 与输入框圆环同一套压力口径：压缩后按摘要节省量折算
  const contextTokens = effectiveContextTokens(
    usage?.tokens ?? 0,
    usage?.at ?? 0,
    session?.compression
  )
  const contextWindow = contextWindowFor(model)
  const reserve = reserveGeometry(contextWindow, maxTokens ?? 8192)
  const cost = useMemo(
    () =>
      estimateCost(session, {
        holiday,
        voiceDiscount: discount,
        serverSearchFree,
      }),
    [session, holiday, discount, serverSearchFree]
  )
  const daily = useDailyUsage()
  useEffect(() => {
    syncDailyUsageDate()
  }, [])
  const run = useLiveStats((state) => state.run)
  const active = run?.active ?? false
  // 生成中每秒重渲染一次，让用时、速度、估算是新值
  const [, tick] = useReducer((value: number) => value + 1, 0)
  useEffect(() => subscribeLiveTick(active, tick), [active])

  // 只展示属于当前会话的那一次生成；新对话没有会话时也允许展示
  const liveRun = run && (!session || run.sessionId === session.id) ? run : null
  const liveMetrics = liveRun ? readLiveMetrics(liveRun) : null
  const hasUsage =
    session?.messages.some(
      (message) => message.role === 'assistant' && message.usage !== undefined
    ) ?? false
  // 每条回复的输出 token 走势：用来判断这一轮比之前更长还是更短
  const replyOutputs = useMemo(
    () =>
      (session?.messages ?? [])
        .filter((message) => message.role === 'assistant' && message.usage !== undefined)
        .map((message) => (message.role === 'assistant' ? (message.usage?.output_tokens ?? 0) : 0)),
    [session]
  )
  // 输入构成：命中缓存的输入最便宜，输出最贵，比例能直接解释费用来源
  const composition = useMemo(() => {
    const segments = [
      { key: 'statsInputUncached', label: t('statsInputUncached'), value: totals.inputUncached },
      { key: 'statsCacheRead', label: t('statsCacheRead'), value: totals.cacheRead },
      { key: 'statsCacheWrite', label: t('statsCacheWrite'), value: totals.cacheWrite },
      { key: 'statsOutput', label: t('statsOutput'), value: totals.outputTokens },
    ].filter((segment) => segment.value > 0)
    const total = segments.reduce((sum, segment) => sum + segment.value, 0)
    return { segments, total }
  }, [t, totals])
  const contextPercent = pressurePercent(contextTokens, contextWindow)
  const contextRemaining = Math.max(0, contextWindow - contextTokens)
  // 跨会话的最近 7 天用量：给单个会话的数字一个参照
  const ledgerDays = useLedger((state) => state.days)
  const week = useMemo(() => ledgerSeries(ledgerDays, 7), [ledgerDays])
  const weekTotals = useMemo(() => ledgerTotals(week), [week])
  const weekTokens = useMemo(
    () => week.map((day) => day.input + day.cacheRead + day.cacheWrite + day.output),
    [week]
  )
  const voice = useMemo(() => readVoiceUsage(session?.id ?? null), [session])
  // 上下文分类：当前会话最近一轮请求的构成
  const breakdownEntry = useContextBreakdown((state) =>
    activeId ? state.byId[activeId] : undefined
  )
  const breakdownSum = breakdownEntry ? breakdownTotal(breakdownEntry.parts) : 0
  const breakdownRows = breakdownEntry
    ? CONTEXT_CATEGORIES.map((key) => ({
        key,
        label: t(`contextCategory_${key}`),
        tokens: breakdownEntry.parts[key],
      })).filter((row) => row.tokens > 0)
    : []

  const liveItems: MetricItem[] = liveMetrics
    ? [
        { key: 'statsOutput', value: formatTokens(liveMetrics.outputTokens) },
        { key: 'statsInput', value: formatTokens(liveMetrics.inputTokens) },
        {
          key: 'statsFirstToken',
          value:
            liveMetrics.firstTokenMs === null
              ? NO_VALUE
              : formatFirstToken(liveMetrics.firstTokenMs),
        },
        {
          key: 'statsCacheHit',
          value: liveMetrics.cacheRate === null ? NO_VALUE : formatPercent(liveMetrics.cacheRate),
        },
        { key: 'statsSpeed', value: `${liveMetrics.tps.toFixed(1)} ${t('statsUnitSpeed')}` },
        { key: 'statsElapsed', value: formatSeconds(liveMetrics.elapsed) },
      ]
    : []

  const sessionItems: MetricItem[] = [
    { key: 'statsRounds', value: String(totals.rounds) },
    { key: 'dailyUsageTokens', value: formatTokens(daily.totalTokens) },
    { key: 'dailyUsageCost', value: formatMoney(daily.cost) },
    { key: 'statsSteps', value: String(totals.steps) },
    { key: 'statsSpeed', value: `${totals.outputSpeed.toFixed(1)} ${t('statsUnitSpeed')}` },
    {
      key: 'statsFirstToken',
      value: totals.firstTokenAvg === null ? NO_VALUE : formatFirstToken(totals.firstTokenAvg),
    },
    { key: 'statsModelTime', value: formatSeconds(totals.modelTime) },
    {
      key: 'statsCacheHit',
      value: totals.cacheRate === null ? NO_VALUE : formatPercent(totals.cacheRate),
    },
    {
      key: 'statsInputUncached',
      value: `${formatTokens(totals.inputUncached)} ${t('statsUnitTokens')}`,
    },
    {
      key: 'statsCacheRead',
      value: `${formatTokens(totals.cacheRead)} ${t('statsUnitTokens')}`,
    },
    {
      key: 'statsCacheWrite',
      value: `${formatTokens(totals.cacheWrite)} ${t('statsUnitTokens')}`,
    },
    {
      key: 'statsOutput',
      value: `${formatTokens(totals.outputTokens)} ${t('statsUnitTokens')}`,
    },
  ]

  return (
    <Modal
      title={t('statsTitle')}
      closable
      onClose={closeStats}
      className={styles.dialog}
      mainClassName={styles.main}
      footer={
        <div className={styles.footer}>
          <span className={styles.footerNote}>{t('statsDialogNote')}</span>
          <Button
            variant="outlined"
            size="m"
            className={styles.footerButton}
            onClick={() => {
              closeStats()
              openSettings('stats')
            }}
          >
            {t('statsOpenStatsSettings')}
          </Button>
        </div>
      }
    >
      {liveItems.length > 0 ? (
        <section className={styles.section}>
          <div className={styles.sectionTitle}>{t('statsLive')}</div>
          <div className={styles.liveRow}>
            {liveItems.map((item) => (
              <div key={item.key} className={styles.liveItem}>
                <span className={styles.liveLabel}>{t(item.key)}</span>
                <span className={styles.liveValue}>{item.value}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.section}>
        <div className={styles.sectionTitle}>{t('statsSession')}</div>
        {session && hasUsage ? (
          <div className={styles.grid}>
            {sessionItems.map((item) => (
              <div key={item.key} className={styles.metric}>
                <span className={styles.metricLabel}>{t(item.key)}</span>
                <span className={styles.metricValue}>{item.value}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.empty}>{t('statsEmpty')}</div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>{t('statsTrendSessionTitle')}</div>
        {replyOutputs.length > 1 ? (
          <div className={styles.trendRow}>
            <Sparkline
              values={replyOutputs}
              ariaLabel={t('statsTrendSessionTitle')}
              className={styles.trendSpark}
            />
            <div className={styles.trendStats}>
              <span>
                {t('statsTrendSessionLatest', {
                  tokens: formatTokens(replyOutputs.at(-1) ?? 0),
                })}
              </span>
              <span>
                {t('statsTrendSessionAvg', {
                  tokens: formatTokens(
                    Math.round(
                      replyOutputs.reduce((sum, value) => sum + value, 0) / replyOutputs.length
                    )
                  ),
                })}
              </span>
              <span>
                {t('statsTrendSessionMax', {
                  tokens: formatTokens(Math.max(...replyOutputs)),
                })}
              </span>
            </div>
          </div>
        ) : (
          <div className={styles.empty}>{t('statsTrendSessionEmpty')}</div>
        )}
        <div className={styles.note}>{t('statsTrendSessionHint')}</div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>{t('statsCompositionTitle')}</div>
        {composition.total > 0 ? (
          <div className={styles.compositionRow}>
            <RingChart
              segments={composition.segments.map((segment) => ({
                key: segment.key,
                label: segment.label,
                value: segment.value,
              }))}
              centerLabel={t('statsUnitTokens')}
              centerValue={formatTokens(composition.total)}
              ariaLabel={t('statsCompositionTitle')}
            />
            <ul className={styles.compositionLegend}>
              {composition.segments.map((segment, index) => (
                <li key={segment.key} className={styles.compositionItem}>
                  <span className={styles.swatch} data-index={(index % 5) + 1} aria-hidden />
                  <span className={styles.compositionLabel}>{segment.label}</span>
                  <span className={styles.compositionValue}>
                    {formatTokens(segment.value)} ·{' '}
                    {((segment.value / composition.total) * 100).toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className={styles.empty}>{t('statsEmpty')}</div>
        )}
        <div className={styles.note}>{t('statsCompositionHint')}</div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>{t('statsWeekTitle')}</div>
        {weekTotals.requests > 0 ? (
          <>
            <div className={styles.trendRow}>
              <Sparkline
                values={weekTokens}
                ariaLabel={t('statsWeekTitle')}
                className={styles.trendSpark}
              />
              <div className={styles.trendStats}>
                <span>
                  {t('statsWeekTokens', {
                    tokens: formatTokens(
                      weekTotals.requests > 0
                        ? weekTokens.reduce((sum, value) => sum + value, 0)
                        : 0
                    ),
                  })}
                </span>
                <span>{t('statsWeekCost', { cost: formatMoney(weekTotals.cost) })}</span>
                <span>{t('statsWeekRequests', { requests: weekTotals.requests })}</span>
              </div>
            </div>
            <div className={styles.note}>{t('statsWeekHint')}</div>
          </>
        ) : (
          <div className={styles.empty}>{t('statsWeekEmpty')}</div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>{t('statsExtrasTitle')}</div>
        <div className={styles.liveRow}>
          <div className={styles.liveItem}>
            <span className={styles.liveLabel}>{t('statsToolSearches')}</span>
            <span className={styles.liveValue}>{totals.searchCount}</span>
          </div>
          <div className={styles.liveItem}>
            <span className={styles.liveLabel}>{t('statsToolFetches')}</span>
            <span className={styles.liveValue}>{totals.fetchCount}</span>
          </div>
          <div className={styles.liveItem}>
            <span className={styles.liveLabel}>{t('statsToolFiles')}</span>
            <span className={styles.liveValue}>
              {totals.parsedFiles} · {totals.parsedPages}
            </span>
          </div>
          <div className={styles.liveItem}>
            <span className={styles.liveLabel}>{t('statsExtrasTtsChars')}</span>
            <span className={styles.liveValue}>{formatTokens(voice.chars)}</span>
          </div>
          <div className={styles.liveItem}>
            <span className={styles.liveLabel}>{t('statsExtrasAsrSeconds')}</span>
            <span className={styles.liveValue}>{Math.round(voice.seconds)}</span>
          </div>
        </div>
        <div className={styles.note}>{t('statsExtrasDialogHint')}</div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>{t('contextBreakdownTitle')}</div>
        {breakdownRows.length > 0 ? (
          <div className={styles.compositionRow}>
            <RingChart
              segments={breakdownRows.map((row) => ({
                key: row.key,
                label: row.label,
                value: row.tokens,
              }))}
              centerLabel={t('statsUnitTokens')}
              centerValue={formatTokens(breakdownSum)}
              ariaLabel={t('contextBreakdownTitle')}
            />
            <ul className={styles.compositionLegend}>
              {breakdownRows.map((row, index) => (
                <li key={row.key} className={styles.compositionItem}>
                  <span className={styles.swatch} data-index={(index % 5) + 1} aria-hidden />
                  <span className={styles.compositionLabel}>{row.label}</span>
                  <span className={styles.compositionValue}>
                    {formatTokens(row.tokens)} ·{' '}
                    {((row.tokens / Math.max(1, breakdownSum)) * 100).toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className={styles.empty}>{t('contextBreakdownEmpty')}</div>
        )}
        <div className={styles.note}>{t('contextBreakdownHint')}</div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>{t('statsContextTitle')}</div>
        <div className={styles.contextRow}>
          <PressureGauge
            percent={contextPercent}
            label={`${Math.round(contextPercent)}%`}
            ariaLabel={t('statsContextPressure')}
          />
          <div className={styles.contextStats}>
            <div className={styles.contextLine}>
              <span className={styles.contextLabel}>{t('statsContextActive')}</span>
              <span className={styles.contextValue}>
                {formatTokens(contextTokens)} / {formatTokens(contextWindow)}
              </span>
            </div>
            <div className={styles.contextLine}>
              <span className={styles.contextLabel}>{t('statsRemainingLabel')}</span>
              <span className={styles.contextValue}>{formatTokens(contextRemaining)}</span>
            </div>
            <div className={styles.contextLine}>
              <span className={styles.contextLabel}>{t('compressThresholdLabel')}</span>
              <span className={styles.contextValue}>
                {formatTokens(reserve?.threshold ?? contextWindow)}
              </span>
            </div>
            <div className={styles.contextLine}>
              <span className={styles.contextLabel}>{t('statsModelTime')}</span>
              <span className={styles.contextValue}>{formatSeconds(totals.modelTime)}</span>
            </div>
          </div>
        </div>
        <div className={styles.compressInfo}>
          {t('compressPressureInfo', {
            used: formatTokens(contextTokens),
            threshold: formatTokens(reserve?.threshold ?? 0),
            percent: Math.round(contextPercent),
          })}
        </div>
        {session?.compression ? (
          <div className={styles.compressInfo}>
            {t('compressSummaryInfo', {
              rounds: session.compression.rounds,
              tokens: formatTokens(estimateTokens(session.compression.summary)),
              saved: formatTokens(session.compression.savedTokens ?? 0),
            })}
          </div>
        ) : null}
        <div className={styles.compressActions}>
          <Button
            size="s"
            variant="outlined"
            disabled={!session || compressing}
            onClick={() => {
              if (!session) {
                return
              }
              if (!apiKey) {
                showToast({ key: 'compressNeedApiKey' })
                return
              }
              setCompressing(true)
              void compressSession(session, apiKey, locale)
                .then((outcome) => {
                  if (outcome.ok) {
                    setSessionCompression(session.id, outcome.compression)
                    showToast({ key: 'compressDone' })
                  } else {
                    showToast({
                      key:
                        outcome.reason === 'tooShort'
                          ? 'compressTooShort'
                          : outcome.reason === 'noKey'
                            ? 'compressNeedApiKey'
                            : 'compressFailed',
                    })
                  }
                })
                .finally(() => setCompressing(false))
            }}
          >
            {compressing ? t('compressRunning') : t('compressButton')}
          </Button>
          {session?.compression ? (
            <Button
              size="s"
              variant="outlined"
              onClick={() => {
                setSessionCompression(session.id, null)
                showToast({ key: 'compressCleared' })
              }}
            >
              {t('compressClear')}
            </Button>
          ) : null}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>{t('memoryStatsTitle')}</div>
        <div className={styles.liveRow}>
          <div className={styles.liveItem}>
            <span className={styles.liveLabel}>{t('memoryStatsNodes')}</span>
            <span className={styles.liveValue}>{memoryNodes}</span>
          </div>
          <div className={styles.liveItem}>
            <span className={styles.liveLabel}>{t('memoryStatsEdges')}</span>
            <span className={styles.liveValue}>{memoryEdges}</span>
          </div>
          <div className={styles.liveItem}>
            <span className={styles.liveLabel}>{t('memoryStatsDimension')}</span>
            <span className={styles.liveValue}>{memoryDimension}</span>
          </div>
          <div className={styles.liveItem}>
            <span className={styles.liveLabel}>{t('memoryStatsLastHits')}</span>
            <span className={styles.liveValue}>
              {lastMemorySearch ? lastMemorySearch.passed : t('memoryStatsNoSearch')}
            </span>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.billingHead}>
          <div className={styles.sectionTitle}>{t('billingTitle')}</div>
          <span
            className={clsx(styles.badge, cost.peakNow ? styles.badgePeak : styles.badgeOffPeak)}
          >
            {cost.peakNow ? t('billingPeak') : t('billingOffPeak')}
          </span>
        </div>
        {serverSearchFree ? (
          <div className={styles.freeNote}>{t('billingSearchFreeNote')}</div>
        ) : null}
        <div className={styles.switchRow}>
          <span className={styles.switchLabel}>{t('billingHoliday')}</span>
          <Switch checked={holiday} onChange={setHoliday} label={t('billingHoliday')} />
        </div>
        <div className={styles.switchRow}>
          <span className={styles.switchLabel}>{t('billingDiscount')}</span>
          <Switch checked={discount} onChange={setDiscount} label={t('billingDiscount')} />
        </div>
        {cost.lines.length > 0 ? (
          <div className={styles.lines}>
            {cost.lines.map((line) => (
              <div key={line.key} className={styles.line}>
                <span className={styles.lineLabel}>
                  {line.key === 'billingParse'
                    ? `${t(line.key, line.params)} · ${t('billingPages', { count: cost.usage.pages })}`
                    : t(line.key, line.params)}
                </span>
                <span className={styles.lineAmount}>{formatMoney(line.amount)}</span>
              </div>
            ))}
            <div className={styles.total}>
              <span className={styles.totalLabel}>{t('billingTotal')}</span>
              <span className={styles.totalAmount}>{formatMoney(cost.total)}</span>
            </div>
          </div>
        ) : (
          <div className={styles.empty}>{t('billingEmpty')}</div>
        )}
        {cost.byModel.length > 0 ? (
          <div className={styles.modelLines}>
            <div className={styles.modelTitle}>{t('billingModels')}</div>
            {cost.byModel.map((item) => (
              <div key={item.model} className={styles.line}>
                <span className={styles.lineLabel}>
                  {modelLabel(item.model)} · {t('billingReplies', { count: item.replies })}
                </span>
                <span className={styles.lineAmount}>{formatMoney(item.cost)}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className={styles.note}>{t('billingNote')}</div>
      </section>
    </Modal>
  )
}
