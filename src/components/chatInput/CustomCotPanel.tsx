import clsx from 'clsx'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { Button } from '../base/Button.js'
import { IconCustomCotOutline16, IconSettingsOutline16 } from '../base/icons.js'
import { Switch } from '../base/Switch.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { useTranslate } from '../../i18n/index.js'
import {
  CUSTOM_COT_MAX_CHARS,
  setCustomCot,
  setCustomCotEnabled,
  useSettings,
} from '../../services/settings.js'
import { isCustomCotActive } from '../../services/chat/customCot.js'
import { DEFAULT_CUSTOM_COT } from '../../services/chat/defaultCot.js'
import styles from './CustomCotPanel.module.css'

/**
 * 输入栏的自定义思维链卡片：与设置页共用同一份配置。
 * 卡片里可以直接开关、编辑、填入示例、清空，也可以跳到设置页看完整说明与预览。
 */
export const CustomCotButton = ({
  triggerClassName,
  selectedClassName,
  labelClassName,
}: {
  triggerClassName: string
  selectedClassName: string
  labelClassName: string
}) => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.customCotEnabled)
  const text = useSettings((state) => state.customCot)
  const thinking = useSettings((state) => state.thinking)
  const [open, setOpen] = useState(false)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { side: 'top', align: 'start', offset: 8, maxHeight: 420, minSpace: 240 })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const active = isCustomCotActive(enabled, text)
  const empty = text.trim() === ''
  const label = t(active ? 'settingsCustomCotToolbarActive' : 'settingsCustomCotToolbar')

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(triggerClassName, active && selectedClassName, open && styles.active)}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconCustomCotOutline16 />
        <span className={labelClassName}>{t('settingsCustomCotShort')}</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={position ?? undefined}
              role="dialog"
              aria-label={t('customCotPanelTitle')}
            >
              <div className={styles.head}>
                <span className={styles.title}>{t('customCotPanelTitle')}</span>
                <Switch
                  checked={enabled}
                  onChange={setCustomCotEnabled}
                  label={t('settingsCustomCot')}
                />
              </div>
              <textarea
                className={styles.textarea}
                aria-label={t('settingsCustomCotEditorLabel')}
                rows={6}
                maxLength={CUSTOM_COT_MAX_CHARS}
                placeholder={t('settingsCustomCotPlaceholder')}
                value={text}
                onChange={(event) => setCustomCot(event.target.value)}
              />
              <div className={styles.meta}>
                <span>
                  {t('settingsCustomCotCount', { count: text.length, max: CUSTOM_COT_MAX_CHARS })}
                </span>
                <span
                  className={styles.status}
                  data-experimental={thinking || undefined}
                  data-off={!enabled || undefined}
                >
                  {t(
                    !enabled
                      ? 'settingsCustomCotOffHint'
                      : empty
                        ? 'settingsCustomCotEmpty'
                        : thinking
                          ? 'settingsCustomCotStatusThinkingTitle'
                          : 'settingsCustomCotStatusDirectTitle'
                  )}
                </span>
              </div>
              <div className={styles.hint}>{t('customCotPanelHint')}</div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => setCustomCot(DEFAULT_CUSTOM_COT)}
                >
                  {t('settingsCustomCotInsertExample')}
                </button>
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={text === ''}
                  onClick={() => setCustomCot('')}
                >
                  {t('settingsCustomCotClear')}
                </button>
                <Button
                  variant="outlined"
                  size="s"
                  className={styles.settingsButton}
                  onClick={() => {
                    setOpen(false)
                    openSettings('cot')
                  }}
                >
                  <IconSettingsOutline16 />
                  {t('customCotPanelOpenSettings')}
                </Button>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
