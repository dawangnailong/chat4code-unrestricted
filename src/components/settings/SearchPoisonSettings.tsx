import { useMemo, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconTrashOutline16 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { useTranslate } from '../../i18n/index.js'
import {
  newPoisonId,
  searchPoisonPreview,
  type PoisonField,
  type PoisonFilter,
  type PoisonResult,
  type PoisonRule,
  type SearchPoisonConfig,
} from '../../services/searchPoison.js'
import { setSearchPoison, useSettings } from '../../services/settings.js'
import styles from './Settings.module.css'

/**
 * 搜索投毒设置：自定义时间 / 知识截止、接管搜索、替换规则、黑名单、强制自定义结果与白名单。
 *
 * 所有配置只写入 localStorage。接管模式不向服务端声明搜索工具，因此过滤结果对模型真实生效；
 * 非接管模式保留服务端搜索，只能改写客户端收到的结果块与引用（详见底部说明）。
 */
export const SearchPoisonSettings = () => {
  const t = useTranslate()
  const config = useSettings((state) => state.searchPoison)
  const preview = useMemo(() => searchPoisonPreview(config), [config])
  const forced = config.blocked.length > 0 || config.whitelistEnabled
  const fields: { value: PoisonField; label: string }[] = [
    { value: 'all', label: t('searchPoisonFieldAll') },
    { value: 'url', label: t('searchPoisonFieldUrl') },
    { value: 'title', label: t('searchPoisonFieldTitle') },
    { value: 'snippet', label: t('searchPoisonFieldSnippet') },
  ]

  const addRule = () =>
    setSearchPoison({
      replacements: [
        ...config.replacements,
        {
          id: newPoisonId('r'),
          pattern: '',
          replacement: '',
          field: 'all',
          regex: false,
        },
      ],
    })

  const updateRule = (id: string, patch: Partial<PoisonRule>) =>
    setSearchPoison({
      replacements: config.replacements.map((rule) =>
        rule.id === id ? { ...rule, ...patch } : rule
      ),
    })

  const removeRule = (id: string) =>
    setSearchPoison({ replacements: config.replacements.filter((rule) => rule.id !== id) })

  const addFilter = (key: 'blocked' | 'whitelist') =>
    setSearchPoison({
      [key]: [...config[key], { id: newPoisonId('f'), pattern: '', field: 'all', regex: false }],
    } as Partial<SearchPoisonConfig>)

  const updateFilter = (key: 'blocked' | 'whitelist', id: string, patch: Partial<PoisonFilter>) =>
    setSearchPoison({
      [key]: config[key].map((filter) => (filter.id === id ? { ...filter, ...patch } : filter)),
    } as Partial<SearchPoisonConfig>)

  const removeFilter = (key: 'blocked' | 'whitelist', id: string) =>
    setSearchPoison({
      [key]: config[key].filter((filter) => filter.id !== id),
    } as Partial<SearchPoisonConfig>)

  const addResult = () =>
    setSearchPoison({
      forced: [...config.forced, { id: newPoisonId('res'), title: '', url: '', snippet: '' }],
    })

  const updateResult = (id: string, patch: Partial<PoisonResult>) =>
    setSearchPoison({
      forced: config.forced.map((result) => (result.id === id ? { ...result, ...patch } : result)),
    })

  const removeResult = (id: string) =>
    setSearchPoison({ forced: config.forced.filter((result) => result.id !== id) })

  const filterRows = (key: 'blocked' | 'whitelist') => {
    const list = config[key]
    if (list.length === 0) {
      return <div className={styles.poisonEmpty}>{t('searchPoisonNoRules')}</div>
    }
    return (
      <div className={styles.poisonList}>
        {list.map((filter) => (
          <div className={styles.poisonRule} key={filter.id}>
            <div className={styles.poisonRuleFields}>
              <input
                className={styles.poisonInput}
                defaultValue={filter.pattern}
                placeholder={t('searchPoisonPatternPlaceholder')}
                aria-label={t('searchPoisonPatternPlaceholder')}
                maxLength={500}
                spellCheck={false}
                onBlur={(event) => updateFilter(key, filter.id, { pattern: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur()
                  }
                }}
              />
              <Select<PoisonField>
                ariaLabel={t('searchPoisonField')}
                className={styles.poisonFieldSelect}
                value={filter.field}
                options={fields}
                onChange={(value) => updateFilter(key, filter.id, { field: value })}
              />
            </div>
            <div className={styles.poisonRuleFoot}>
              <span className={styles.poisonRegex}>
                <Switch
                  checked={filter.regex}
                  onChange={(value) => updateFilter(key, filter.id, { regex: value })}
                  label={t('searchPoisonRegex')}
                />
                {t('searchPoisonRegex')}
              </span>
              <IconButton
                icon={<IconTrashOutline16 />}
                tooltip={t('delete')}
                className={styles.poisonRemove}
                onClick={() => removeFilter(key, filter.id)}
              />
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <>
      <Cell
        label={t('searchPoisonEnabled')}
        description={t('searchPoisonEnabledDescription')}
        action={
          <Switch
            checked={config.enabled}
            onChange={(enabled) => setSearchPoison({ enabled })}
            label={t('searchPoisonEnabled')}
          />
        }
      />

      <Cell
        label={t('searchPoisonTakeover')}
        description={t('searchPoisonTakeoverDescription')}
        action={
          <Switch
            checked={config.takeover || forced}
            disabled={forced}
            onChange={(takeover) => setSearchPoison({ takeover })}
            label={t('searchPoisonTakeover')}
          />
        }
      />
      {forced ? <div className={styles.pipeline}>{t('searchPoisonTakeoverForced')}</div> : null}

      <Cell
        stack
        label={t('searchPoisonNow')}
        description={t('searchPoisonNowDescription')}
        action={
          <div className={styles.poisonInline}>
            <input
              type="datetime-local"
              className={clsx(styles.poisonInput, styles.poisonDateInput)}
              aria-label={t('searchPoisonNow')}
              value={config.now}
              onChange={(event) => setSearchPoison({ now: event.target.value })}
            />
            <Button
              variant="outlined"
              size="s"
              disabled={config.now === ''}
              onClick={() => setSearchPoison({ now: '' })}
            >
              {t('searchPoisonNowClear')}
            </Button>
          </div>
        }
      />

      <Cell
        stack
        label={t('searchPoisonCutoff')}
        description={t('searchPoisonCutoffDescription')}
        action={
          <div className={styles.poisonInline}>
            <input
              type="date"
              className={clsx(styles.poisonInput, styles.poisonDateInput)}
              aria-label={t('searchPoisonCutoff')}
              value={config.knowledgeCutoff}
              onChange={(event) => setSearchPoison({ knowledgeCutoff: event.target.value })}
            />
            <Button
              variant="outlined"
              size="s"
              disabled={config.knowledgeCutoff === ''}
              onClick={() => setSearchPoison({ knowledgeCutoff: '' })}
            >
              {t('searchPoisonCutoffClear')}
            </Button>
          </div>
        }
      />

      <div className={styles.poisonSection}>
        <div className={styles.poisonSectionHead}>
          <div className={styles.poisonSectionTitle}>{t('searchPoisonReplacements')}</div>
          <span className={styles.poisonCount}>
            {t('searchPoisonRuleCount', { count: config.replacements.length })}
          </span>
        </div>
        <div className={styles.poisonSectionHint}>{t('searchPoisonReplacementsDescription')}</div>
        {config.replacements.length === 0 ? (
          <div className={styles.poisonEmpty}>{t('searchPoisonNoRules')}</div>
        ) : (
          <div className={styles.poisonList}>
            {config.replacements.map((rule) => (
              <div className={styles.poisonRule} key={rule.id}>
                <div className={styles.poisonRuleFields}>
                  <input
                    className={styles.poisonInput}
                    defaultValue={rule.pattern}
                    placeholder={t('searchPoisonPatternPlaceholder')}
                    aria-label={t('searchPoisonPatternPlaceholder')}
                    maxLength={500}
                    spellCheck={false}
                    onBlur={(event) => updateRule(rule.id, { pattern: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur()
                      }
                    }}
                  />
                  <input
                    className={styles.poisonInput}
                    defaultValue={rule.replacement}
                    placeholder={t('searchPoisonReplacementPlaceholder')}
                    aria-label={t('searchPoisonReplacementPlaceholder')}
                    maxLength={1000}
                    spellCheck={false}
                    onBlur={(event) => updateRule(rule.id, { replacement: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur()
                      }
                    }}
                  />
                </div>
                <div className={styles.poisonRuleFoot}>
                  <Select<PoisonField>
                    ariaLabel={t('searchPoisonField')}
                    className={styles.poisonFieldSelect}
                    value={rule.field}
                    options={fields}
                    onChange={(value) => updateRule(rule.id, { field: value })}
                  />
                  <span className={styles.poisonRegex}>
                    <Switch
                      checked={rule.regex}
                      onChange={(value) => updateRule(rule.id, { regex: value })}
                      label={t('searchPoisonRegex')}
                    />
                    {t('searchPoisonRegex')}
                  </span>
                  <IconButton
                    icon={<IconTrashOutline16 />}
                    tooltip={t('delete')}
                    className={styles.poisonRemove}
                    onClick={() => removeRule(rule.id)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        <div className={styles.poisonAdd}>
          <Button variant="outlined" size="s" onClick={addRule}>
            {t('searchPoisonAddReplacement')}
          </Button>
        </div>
      </div>

      <div className={styles.poisonSection}>
        <div className={styles.poisonSectionHead}>
          <div className={styles.poisonSectionTitle}>{t('searchPoisonBlocked')}</div>
          <span className={styles.poisonCount}>
            {t('searchPoisonRuleCount', { count: config.blocked.length })}
          </span>
        </div>
        <div className={styles.poisonSectionHint}>{t('searchPoisonBlockedDescription')}</div>
        {filterRows('blocked')}
        <div className={styles.poisonAdd}>
          <Button variant="outlined" size="s" onClick={() => addFilter('blocked')}>
            {t('searchPoisonAddBlocked')}
          </Button>
        </div>
      </div>

      <div className={styles.poisonSection}>
        <div className={styles.poisonSectionHead}>
          <div className={styles.poisonSectionTitle}>{t('searchPoisonForced')}</div>
          <span className={styles.poisonCount}>
            {t('searchPoisonRuleCount', { count: config.forced.length })}
          </span>
        </div>
        <div className={styles.poisonSectionHint}>{t('searchPoisonForcedDescription')}</div>
        {config.forced.length === 0 ? (
          <div className={styles.poisonEmpty}>{t('searchPoisonNoResults')}</div>
        ) : (
          <div className={styles.poisonList}>
            {config.forced.map((result) => (
              <div className={styles.poisonRule} key={result.id}>
                <div className={styles.poisonResultGrid}>
                  <input
                    className={styles.poisonInput}
                    defaultValue={result.title}
                    placeholder={t('searchPoisonResultTitle')}
                    aria-label={t('searchPoisonResultTitle')}
                    maxLength={300}
                    spellCheck={false}
                    onBlur={(event) => updateResult(result.id, { title: event.target.value })}
                  />
                  <input
                    className={styles.poisonInput}
                    defaultValue={result.url}
                    placeholder={t('searchPoisonResultUrl')}
                    aria-label={t('searchPoisonResultUrl')}
                    maxLength={2000}
                    spellCheck={false}
                    onBlur={(event) => updateResult(result.id, { url: event.target.value })}
                  />
                  <textarea
                    className={clsx(styles.poisonTextarea, styles.poisonResultSnippet)}
                    rows={3}
                    defaultValue={result.snippet}
                    placeholder={t('searchPoisonResultSnippet')}
                    aria-label={t('searchPoisonResultSnippet')}
                    maxLength={4000}
                    spellCheck={false}
                    onBlur={(event) => updateResult(result.id, { snippet: event.target.value })}
                  />
                </div>
                <div className={styles.poisonRuleFoot}>
                  <span className={styles.poisonSectionHint}>{t('searchPoisonResultHint')}</span>
                  <IconButton
                    icon={<IconTrashOutline16 />}
                    tooltip={t('delete')}
                    className={styles.poisonRemove}
                    onClick={() => removeResult(result.id)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        <div className={styles.poisonAdd}>
          <Button variant="outlined" size="s" onClick={addResult}>
            {t('searchPoisonAddForced')}
          </Button>
        </div>
      </div>

      <div className={styles.poisonSection}>
        <div className={styles.poisonSectionHead}>
          <div className={styles.poisonSectionTitle}>{t('searchPoisonWhitelist')}</div>
          <span className={styles.poisonSectionHint}>{t('searchPoisonWhitelistEnabled')}</span>
          <Switch
            checked={config.whitelistEnabled}
            onChange={(whitelistEnabled) => setSearchPoison({ whitelistEnabled })}
            label={t('searchPoisonWhitelistEnabled')}
          />
        </div>
        <div className={styles.poisonSectionHint}>{t('searchPoisonWhitelistDescription')}</div>
        {filterRows('whitelist')}
        <div className={styles.poisonAdd}>
          <Button variant="outlined" size="s" onClick={() => addFilter('whitelist')}>
            {t('searchPoisonAddWhitelist')}
          </Button>
        </div>
      </div>

      <div className={styles.pipeline}>{t('searchPoisonFootnote')}</div>
      <details className={styles.promptPreview}>
        <summary className={styles.promptPreviewSummary}>
          {t('searchPoisonPreview', { count: preview.count })}
        </summary>
        <pre className={styles.promptPreviewBody}>
          {preview.context || t('searchPoisonPreviewEmpty')}
        </pre>
      </details>
    </>
  )
}

const Cell = ({
  label,
  description,
  action,
  stack = false,
}: {
  label: string
  description?: string
  action: ReactNode
  stack?: boolean
}) => (
  <div className={clsx(styles.cell, styles.row, stack && styles.poisonCell)}>
    <div className={styles.text}>
      <div className={styles.label}>{label}</div>
      {description ? <div className={styles.description}>{description}</div> : null}
    </div>
    {action}
  </div>
)
