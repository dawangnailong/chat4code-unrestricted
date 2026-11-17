import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import {
  IconCheckedOutline14,
  IconChevronDownOutline14,
  IconRefreshOutline16,
} from '../base/icons.js'
import {
  builtinModels,
  modelLabel,
  readCachedModels,
  type ModelOption,
} from '../../services/api/models.js'
import { fetchProviderModels } from '../../services/api/provider.js'
import { setModel, useSettings } from '../../services/settings.js'
import { formatMoney, isKnownModel, modelPriceFor } from '../../services/chat/sessionStats.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ModelPicker.module.css'

const mergeModels = (remote: ModelOption[], builtin: ModelOption[]): ModelOption[] => {
  const seen = new Set(remote.map((item) => item.id))
  return [...remote, ...builtin.filter((item) => !seen.has(item.id))]
}

/** 每个模型下方的价格：命中 / 未命中 / 输出，单位每 1M tokens */
const priceText = (model: string, t: ReturnType<typeof useTranslate>): string => {
  if (!isKnownModel(model)) {
    return t('modelPriceUnknown')
  }
  const price = modelPriceFor(model)
  return `${formatMoney(price.cacheHit)} / ${formatMoney(price.cacheMiss)} / ${formatMoney(price.output)}`
}

/**
 * 模型选择卡片：默认内置 Flash / V4 Pro，可从云端 GET /models 拉取并缓存。
 * 选择结果写入设置，下一条消息就用新模型；旧回复保留自己的模型与计费。
 */
export const ModelPicker = () => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  const provider = useSettings((state) => state.apiProvider)
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelOption[]>(() =>
    mergeModels(readCachedModels(provider) ?? [], builtinModels(provider))
  )
  const [loading, setLoading] = useState(false)
  const fetched = useRef(false)

  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side: 'top',
    align: 'start',
    offset: 8,
    maxHeight: 360,
    minSpace: 220,
    measureKey: models.length,
  })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const refresh = useCallback(async (silent = false) => {
    const apiKey = useSettings.getState().apiKey ?? ''
    if (!apiKey && useSettings.getState().apiProvider !== 'opencode-bridge') {
      if (!silent) {
        showToast({ key: 'modelFetchFailed' })
      }
      return
    }
    setLoading(true)
    try {
      const remote = await fetchProviderModels(apiKey)
      setModels(mergeModels(remote, builtinModels(useSettings.getState().apiProvider)))
    } catch {
      if (!silent) {
        showToast({ key: 'modelFetchFailed' })
      }
    } finally {
      setLoading(false)
    }
  }, [])

  // 切换 provider 后重建列表并允许重新拉取
  useEffect(() => {
    setModels(mergeModels(readCachedModels(provider) ?? [], builtinModels(provider)))
    fetched.current = false
  }, [provider])

  // 首次打开且没有缓存时静默拉一次；失败继续用内置列表
  useEffect(() => {
    if (!open || fetched.current) {
      return
    }
    fetched.current = true
    if (!readCachedModels(provider)) {
      void refresh(true)
    }
  }, [open, provider, refresh])

  const sourceText = useMemo(() => {
    if (loading) {
      return t('modelFetching')
    }
    const count = models.filter((item) => item.source === 'remote').length
    return count > 0 ? t('modelRemoteOk', { count }) : t('modelBuiltinFallback')
  }, [loading, models, t])

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open)}
        aria-label={t('modelSelect')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.name}>{modelLabel(model)}</span>
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={position ?? undefined}
              role="listbox"
              aria-label={t('modelSelect')}
            >
              <div className={styles.head}>
                <span className={styles.title}>{t('modelSelect')}</span>
                <button
                  type="button"
                  className={clsx(styles.refresh, loading && styles.spinning)}
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  <IconRefreshOutline16 />
                  {loading ? t('modelFetching') : t('modelFetch')}
                </button>
              </div>
              <div className={styles.list}>
                {models.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={item.id === model}
                    className={clsx(styles.option, item.id === model && styles.active)}
                    onClick={() => {
                      setModel(item.id)
                      setOpen(false)
                    }}
                  >
                    <span className={styles.optionMain}>
                      <span className={styles.optionNameRow}>
                        <span className={styles.optionName}>{item.label}</span>
                        <span className={styles.sourceTag}>
                          {item.source === 'remote' ? t('modelRemote') : t('modelBuiltin')}
                        </span>
                      </span>
                      <span className={styles.optionId}>{item.id}</span>
                      <span className={styles.optionPrice}>{priceText(item.id, t)}</span>
                    </span>
                    {item.id === model ? <IconCheckedOutline14 /> : null}
                  </button>
                ))}
              </div>
              <div className={styles.foot}>
                <span>{sourceText}</span>
                <span>
                  {t('modelPriceNote')} · {t('modelPriceUnitShort')}
                </span>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
