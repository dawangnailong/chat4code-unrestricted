import clsx from 'clsx'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconEditOutline16 } from '../base/icons.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { useTranslate } from '../../i18n/index.js'
import { copyText } from '../../utils/clipboard.js'
import { showToast } from '../base/toastState.js'
import {
  setParseltongue,
  setParseltongueIntensity,
  setParseltongueTechnique,
  useSettings,
} from '../../services/settings.js'
import {
  applyParseltongue,
  detectTriggers,
  type ObfuscationTechnique,
} from '../../services/unrestricted/parseltongue.js'
import styles from './ParseltonguePanel.module.css'

/**
 * 输入扰动入口：按钮固定在输入框的工具行里，点开后是浮层，
 * 可以开关扰动、选技术与强度，并按当前草稿实时预览改写结果。
 * 触发按钮的类名由 ChatInput 传入，保证和「深度思考 / 智能搜索」两个开关同一套样式。
 */
export const ParseltongueButton = ({
  text,
  triggerClassName,
  selectedClassName,
  labelClassName,
}: {
  text: string
  triggerClassName: string
  selectedClassName: string
  labelClassName: string
}) => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.parseltongue)
  const technique = useSettings((state) => state.parseltongueTechnique)
  const intensity = useSettings((state) => state.parseltongueIntensity)
  const [open, setOpen] = useState(false)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { side: 'top', align: 'end', offset: 8, maxHeight: 360, minSpace: 200 })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const techniques: { value: ObfuscationTechnique; label: string }[] = [
    { value: 'leetspeak', label: t('settingsTechniqueLeetspeak') },
    { value: 'unicode', label: t('settingsTechniqueUnicode') },
    { value: 'zwj', label: t('settingsTechniqueZwj') },
    { value: 'mixedcase', label: t('settingsTechniqueMixedcase') },
    { value: 'phonetic', label: t('settingsTechniquePhonetic') },
    { value: 'fullwidth', label: t('settingsTechniqueFullwidth') },
    { value: 'spacing', label: t('settingsTechniqueSpacing') },
    { value: 'random', label: t('settingsTechniqueRandom') },
  ]
  const intensities: { value: 'light' | 'medium' | 'heavy'; label: string }[] = [
    { value: 'light', label: t('settingsIntensityLight') },
    { value: 'medium', label: t('settingsIntensityMedium') },
    { value: 'heavy', label: t('settingsIntensityHeavy') },
  ]

  const triggers = text.trim() === '' ? [] : detectTriggers(text)
  // 预览始终按当前配置计算；没有命中触发词时展示原文，避免看起来「没有效果」
  const preview =
    text.trim() === ''
      ? ''
      : triggers.length === 0
        ? text
        : applyParseltongue(text, {
            enabled: true,
            technique,
            intensity,
            customTriggers: [],
          }).transformedText

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(triggerClassName, enabled && selectedClassName, open && styles.active)}
        aria-label={t('parseltongueToggle')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <IconEditOutline16 />
        <span className={labelClassName}>{t('parseltongueToggle')}</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={position ?? undefined}
              role="dialog"
              aria-label={t('parseltonguePanelTitle')}
            >
              <div className={styles.head}>
                <span className={styles.title}>{t('parseltonguePanelTitle')}</span>
                <Switch
                  checked={enabled}
                  onChange={setParseltongue}
                  label={t('parseltonguePanelEnable')}
                />
              </div>
              <div className={styles.controls}>
                <Select
                  value={technique}
                  options={techniques}
                  onChange={setParseltongueTechnique}
                  ariaLabel={t('settingsParseltongueTechnique')}
                  className={styles.select}
                />
                <Select
                  value={intensity}
                  options={intensities}
                  onChange={setParseltongueIntensity}
                  ariaLabel={t('settingsParseltongueIntensity')}
                  className={styles.select}
                />
              </div>
              <div className={styles.count}>
                {triggers.length > 0
                  ? t('parseltonguePanelTriggers', { count: triggers.length })
                  : t('parseltonguePanelNoTriggers')}
              </div>
              <div className={styles.previewHead}>
                <span className={styles.previewLabel}>{t('parseltonguePanelPreview')}</span>
                <button
                  type="button"
                  className={styles.copy}
                  disabled={!preview}
                  onClick={() => {
                    void copyText(preview).then((ok) => {
                      showToast({ key: ok ? 'copied' : 'copyFailed' })
                    })
                  }}
                >
                  {t('copy')}
                </button>
              </div>
              <pre className={styles.preview}>{preview || t('parseltonguePanelEmpty')}</pre>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
