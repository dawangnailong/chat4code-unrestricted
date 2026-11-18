import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useBridgeMode, useSettings } from '../../services/settings.js'
import { McpClient } from '../../services/lab/mcpClient.js'
import { closeLab, setLabEndpoint, useLab } from '../../services/lab/labStore.js'
import { importPromptToChat } from '../../services/lab/importToChat.js'
import { showToast } from '../base/toastState.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { applyParseltongue } from '../../services/unrestricted/parseltongue.js'
import { RaceView } from './RaceView.js'
import { readAttackFile } from '../../services/lab/ioValidation.js'
import { modelLabel } from '../../services/api/models.js'
import { NO_API_KEY, maskApiKey } from '../../services/api/mask.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { VariantView } from './VariantView.js'
import styles from './LabView.module.css'

type MethodInfo = {
  id: string
  name: string
  kind: string
  needs: string[]
  defaults: Record<string, unknown>
  notes?: string
}

type DatasetInfo = { id: string; name: string; size: number }

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value ?? '')

type JobResult = {
  query: string
  prompt: string
  responses: string[]
  eval: unknown[]
  jailbroken: boolean
}

type JobState = {
  id: string
  status: string
  total: number
  done: number
  calls: { attack: number; target: number; eval: number }
  asr: number
  error?: string | null
  results: JobResult[]
}

/** 越狱实验台：连接本地 easyjailbreak-mcp 后端，跑 EasyJailbreak 的攻击器并展示逐条结果。 */
export const LabView = () => {
  const t = useTranslate()
  const bridgeMode = useBridgeMode()
  const endpoint = useLab((state) => state.endpoint)
  const apiKey = useSettings((state) => state.apiKey) ?? ''

  const [draftEndpoint, setDraftEndpoint] = useState(endpoint)
  const clientRef = useRef<McpClient | null>(null)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [methods, setMethods] = useState<MethodInfo[]>([])
  const [datasets, setDatasets] = useState<DatasetInfo[]>([])
  const [methodId, setMethodId] = useState('')
  const [datasetId, setDatasetId] = useState('advbench')
  const [limit, setLimit] = useState(3)
  const [queries, setQueries] = useState('')
  const [params, setParams] = useState('{}')
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1')
  // 默认跟随聊天里选中的内置模型；MCP 的攻击 / 目标 / 判分都使用这一个
  const [model, setModel] = useState<string>(() =>
    useSettings.getState().model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash'
  )
  const [jobModel, setJobModel] = useState<string | null>(null)
  const [job, setJob] = useState<JobState | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [tab, setTab] = useState<'attack' | 'race' | 'variants'>('attack')
  const [preprocess, setPreprocess] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(
    () => () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
      }
    },
    []
  )

  const connect = async () => {
    setConnecting(true)
    setError(null)
    try {
      setLabEndpoint(draftEndpoint)
      const client = new McpClient(draftEndpoint)
      await client.connect()
      const health = await client.callTool<{ ok: boolean; error?: string | null }>('health')
      if (!health.ok) {
        throw new Error(health.error || t('labBackendUnavailable'))
      }
      const [methodList, datasetList] = await Promise.all([
        client.callTool<{ methods: MethodInfo[] }>('list_methods'),
        client.callTool<{ datasets: DatasetInfo[] }>('list_datasets'),
      ])
      clientRef.current = client
      setMethods(methodList.methods.filter((item) => item.kind !== 'white-box'))
      setDatasets(datasetList.datasets)
      setConnected(true)
      const first = methodList.methods.find((item) => item.kind !== 'white-box')
      if (first) {
        setMethodId(first.id)
        setParams(JSON.stringify(first.defaults, null, 2))
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setConnected(false)
      clientRef.current = null
    } finally {
      setConnecting(false)
    }
  }

  const disconnect = () => {
    clientRef.current = null
    setConnected(false)
    setJobId(null)
    setRunning(false)
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const selectMethod = (nextId: string) => {
    setMethodId(nextId)
    const method = methods.find((item) => item.id === nextId)
    setParams(JSON.stringify(method?.defaults ?? {}, null, 2))
  }

  const run = async () => {
    const client = clientRef.current
    if (!client || !methodId) {
      return
    }
    setError(null)
    setJob(null)
    setRunning(true)
    try {
      const methodParams = JSON.parse(params || '{}') as Record<string, unknown>
      const queryList = queries
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      // 自定义测试语句可以先用扰动引擎改写，再交给攻击器，和聊天里的输入扰动保持同一套配置
      const { parseltongueTechnique, parseltongueIntensity } = useSettings.getState()
      const preparedQueries =
        preprocess && queryList.length > 0
          ? queryList.map(
              (line) =>
                applyParseltongue(line, {
                  enabled: true,
                  technique: parseltongueTechnique,
                  intensity: parseltongueIntensity,
                  customTriggers: [],
                }).transformedText
            )
          : queryList
      setJobModel(model)
      const payload = {
        method: methodId,
        queries: preparedQueries,
        dataset: preparedQueries.length > 0 ? 'custom' : datasetId,
        limit: preparedQueries.length > 0 ? preparedQueries.length : limit,
        models: {
          target: { baseUrl, model, apiKey },
          attack: { baseUrl, model, apiKey },
          eval: { baseUrl, model, apiKey },
        },
        method_params: methodParams,
      }
      const started = await client.callTool<{ jobId: string }>('start_attack', payload)
      setJobId(started.jobId)
      if (pollRef.current) {
        clearInterval(pollRef.current)
      }
      pollRef.current = setInterval(async () => {
        try {
          const next = await client.callTool<JobState>('get_job', { job_id: started.jobId })
          setJob(next)
          if (['done', 'error', 'cancelled'].includes(next.status)) {
            setRunning(false)
            setJobId(null)
            if (pollRef.current) {
              clearInterval(pollRef.current)
              pollRef.current = null
            }
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, 1200)
    } catch (failure) {
      setRunning(false)
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  /** 把当前实验结果下载成 JSON。 */
  const exportResults = () => {
    if (!job) {
      return
    }
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      method: methodId,
      model: jobModel ?? model,
      job,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `jailbreak-lab-${methodId || 'result'}-${Date.now()}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  /** 导入一份之前导出的结果文件（只展示，不重新跑）。 */
  const importResults = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text())
      const data = readAttackFile(parsed)
      if (!data) {
        throw new Error('invalid attack file')
      }
      const raw = data.job
      const rawResults = Array.isArray(raw.results) ? raw.results : null
      if (!rawResults) {
        throw new Error('missing results')
      }
      const calls = (raw.calls ?? {}) as Record<string, unknown>
      const results = rawResults.map((item) => {
        const record = (item ?? {}) as Record<string, unknown>
        return {
          query: asText(record.query),
          prompt: asText(record.prompt),
          responses: Array.isArray(record.responses) ? record.responses.map(asText) : [],
          eval: Array.isArray(record.eval) ? record.eval : [],
          jailbroken: record.jailbroken === true,
        }
      })
      setJob({
        id: String(raw.id ?? 'imported'),
        status: String(raw.status ?? 'done'),
        total: Number(raw.total ?? results.length),
        done: Number(raw.done ?? results.length),
        calls: {
          attack: Number(calls.attack ?? 0),
          target: Number(calls.target ?? 0),
          eval: Number(calls.eval ?? 0),
        },
        asr: Number(raw.asr ?? 0),
        error: typeof raw.error === 'string' ? raw.error : null,
        results,
      })
      setJobModel(data.model)
      setError(null)
      showToast({ key: 'labImportedResults' })
    } catch {
      setError(t('labImportFailed'))
    }
  }

  const cancel = async () => {
    const client = clientRef.current
    if (client && jobId) {
      await client.callTool('cancel_job', { job_id: jobId }).catch(() => undefined)
    }
  }

  if (bridgeMode) {
    return (
      <div className={styles.lab}>
        <header className={styles.header}>
          <div className={styles.heading}>
            <div className={styles.title}>{t('labTitle')}</div>
            <div className={styles.subtitle}>{t('labSubtitle')}</div>
          </div>
          <div className={styles.connection}>
            <Button variant="outlined" size="s" onClick={closeLab}>
              {t('labBack')}
            </Button>
          </div>
        </header>
        <div className={styles.error}>{t('bridgeLabUnsupported')}</div>
      </div>
    )
  }

  return (
    <div className={styles.lab}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <div className={styles.title}>{t('labTitle')}</div>
          <div className={styles.subtitle}>{t('labSubtitle')}</div>
        </div>
        <div className={styles.connection}>
          <Button variant="outlined" size="s" onClick={closeLab}>
            {t('labBack')}
          </Button>
          {tab === 'attack' ? (
            <>
              <Button variant="outlined" size="s" disabled={!job} onClick={exportResults}>
                {t('labExport')}
              </Button>
              <Button
                variant="outlined"
                size="s"
                onClick={() => document.getElementById('lab-import-input')?.click()}
              >
                {t('labImport')}
              </Button>
              <input
                id="lab-import-input"
                className={styles.hiddenInput}
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) {
                    void importResults(file)
                  }
                }}
              />
              <input
                className={styles.endpoint}
                value={draftEndpoint}
                aria-label={t('labEndpoint')}
                onChange={(event) => setDraftEndpoint(event.target.value)}
                spellCheck={false}
              />
              {connected ? (
                <Button variant="outlined" size="s" onClick={disconnect}>
                  {t('labDisconnect')}
                </Button>
              ) : (
                <Button size="s" disabled={connecting} onClick={() => void connect()}>
                  {connecting ? t('labConnecting') : t('labConnect')}
                </Button>
              )}
              <span className={clsx(styles.dot, connected && styles.dotOn)} />
              <span className={styles.statusText}>
                {connected ? t('labConnected') : t('labDisconnected')}
              </span>
            </>
          ) : null}
        </div>
      </header>

      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'attack'}
          className={clsx(styles.tab, tab === 'attack' && styles.tabActive)}
          onClick={() => setTab('attack')}
        >
          {t('labTabAttack')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'race'}
          className={clsx(styles.tab, tab === 'race' && styles.tabActive)}
          onClick={() => setTab('race')}
        >
          {t('labTabRace')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'variants'}
          className={clsx(styles.tab, tab === 'variants' && styles.tabActive)}
          onClick={() => setTab('variants')}
        >
          {t('labTabVariants')}
        </button>
      </div>

      {tab !== 'attack' ? <div className={styles.directNote}>{t('labDirectApiNote')}</div> : null}

      {error && tab === 'attack' ? <div className={styles.error}>{error}</div> : null}

      {tab === 'race' ? (
        <div className={styles.tabBody}>
          <RaceView />
        </div>
      ) : tab === 'variants' ? (
        <div className={styles.tabBody}>
          <VariantView />
        </div>
      ) : (
        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.field}>
              <span className={styles.label}>{t('labMethod')}</span>
              <Select
                ariaLabel={t('labMethod')}
                value={methodId}
                disabled={!connected}
                options={methods.map((item) => ({ value: item.id, label: item.name }))}
                onChange={selectMethod}
                placeholder={t('labNeedConnect')}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.label}>{t('labDataset')}</span>
              <Select
                ariaLabel={t('labDataset')}
                value={datasetId}
                disabled={!connected || queries.trim().length > 0}
                options={datasets.map((item) => ({
                  value: item.id,
                  label: `${item.name}${item.size ? ` (${item.size})` : ''}`,
                }))}
                onChange={setDatasetId}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.label}>{t('labLimit')}</span>
              <input
                className={styles.input}
                type="number"
                min={1}
                max={50}
                value={limit}
                disabled={!connected}
                onChange={(event) => setLimit(Math.max(1, Number(event.target.value) || 1))}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.label}>{t('labQueries')}</span>
              <textarea
                className={styles.textarea}
                rows={4}
                value={queries}
                disabled={!connected}
                placeholder={t('labQueriesPlaceholder')}
                onChange={(event) => setQueries(event.target.value)}
              />
            </div>

            <div className={styles.preprocessRow}>
              <Switch checked={preprocess} onChange={setPreprocess} label={t('labPreprocess')} />
              <span className={styles.label}>{t('labPreprocess')}</span>
            </div>

            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <span className={styles.label}>{t('labBaseUrl')}</span>
                <input
                  className={styles.input}
                  value={baseUrl}
                  disabled={!connected}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className={styles.field}>
                <span className={styles.label}>{t('labModel')}</span>
                <Select<string>
                  ariaLabel={t('labModel')}
                  value={model}
                  disabled={!connected}
                  options={[
                    { value: 'deepseek-flash', label: 'DeepSeek Flash' },
                    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
                  ]}
                  onChange={setModel}
                />
                <span className={styles.hint}>{t('labModelHint')}</span>
              </div>
            </div>

            <div className={styles.field}>
              <span className={styles.label}>{t('labApiKey')}</span>
              {/* 只读展示一律脱敏，避免把完整密钥留在页面上 */}
              <div className={styles.keyRow}>
                <code className={styles.keyMask}>{apiKey ? maskApiKey(apiKey) : NO_API_KEY}</code>
                <button
                  type="button"
                  className={styles.keyLink}
                  onClick={() => openSettings('data')}
                >
                  {t('labApiKeyManage')}
                </button>
              </div>
              <span className={styles.hint}>{t('labApiKeyHint')}</span>
            </div>

            <div className={styles.field}>
              <span className={styles.label}>{t('labMethodParams')}</span>
              <textarea
                className={styles.textarea}
                rows={6}
                value={params}
                disabled={!connected}
                onChange={(event) => setParams(event.target.value)}
                spellCheck={false}
              />
            </div>

            <div className={styles.actions}>
              <Button
                size="m"
                disabled={!connected || !methodId || running}
                onClick={() => void run()}
              >
                {running ? t('labRunning') : t('labRun')}
              </Button>
              {running ? (
                <Button variant="outlined" size="m" onClick={() => void cancel()}>
                  {t('labCancel')}
                </Button>
              ) : null}
            </div>
          </section>

          <section className={styles.results}>
            {job ? (
              <>
                <div className={styles.metrics}>
                  <div className={styles.metric}>
                    <span className={styles.metricLabel}>{t('labProgress')}</span>
                    <span className={styles.metricValue}>
                      {job.done}/{job.total}
                    </span>
                  </div>
                  <div className={styles.metric}>
                    <span className={styles.metricLabel}>{t('labCalls')}</span>
                    <span className={styles.metricValue}>
                      {job.calls.target + job.calls.attack + job.calls.eval}
                    </span>
                  </div>
                  <div className={styles.metric}>
                    <span className={styles.metricLabel}>{t('labAsr')}</span>
                    <span className={styles.metricValue}>{Math.round(job.asr * 100)}%</span>
                  </div>
                  <div className={styles.metric}>
                    <span className={styles.metricLabel}>{t('labStatus')}</span>
                    <span className={styles.metricValue}>{job.status}</span>
                  </div>
                  <div className={styles.metric}>
                    <span className={styles.metricLabel}>{t('labModel')}</span>
                    <span className={styles.metricValue}>
                      {jobModel ? modelLabel(jobModel) : '—'}
                    </span>
                  </div>
                </div>
                {job.error ? <div className={styles.error}>{job.error}</div> : null}
                <div className={styles.list}>
                  {job.results.map((item, index) => {
                    const queryText = asText(item.query)
                    return (
                      <details
                        className={styles.result}
                        key={`${queryText}-${index}`}
                        open={index === 0}
                      >
                        <summary className={styles.resultSummary}>
                          <span className={clsx(styles.badge, item.jailbroken && styles.badgeOk)}>
                            {item.jailbroken ? t('labJailbroken') : t('labRejected')}
                          </span>
                          <span className={styles.resultQuery}>{queryText}</span>
                        </summary>
                        <div className={styles.resultBody}>
                          {item.jailbroken ? (
                            <div className={styles.resultActions}>
                              <Button
                                size="s"
                                onClick={() => importPromptToChat(asText(item.prompt))}
                              >
                                {t('labImportChat')}
                              </Button>
                            </div>
                          ) : null}
                          <div className={styles.resultBlock}>
                            <div className={styles.resultLabel}>{t('labPrompt')}</div>
                            <pre className={styles.pre}>{asText(item.prompt)}</pre>
                          </div>
                          <div className={styles.resultBlock}>
                            <div className={styles.resultLabel}>{t('labResponse')}</div>
                            <pre className={styles.pre}>
                              {item.responses.map(asText).join('\n---\n')}
                            </pre>
                          </div>
                          <div className={styles.resultBlock}>
                            <div className={styles.resultLabel}>{t('labJudge')}</div>
                            <pre className={styles.pre}>{JSON.stringify(item.eval)}</pre>
                          </div>
                        </div>
                      </details>
                    )
                  })}
                  {job.results.length === 0 ? (
                    <div className={styles.empty}>{t('labNoResults')}</div>
                  ) : null}
                </div>
              </>
            ) : (
              <div className={styles.empty}>{t('labHint')}</div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
