import { useMemo, type ReactNode } from 'react'
import clsx from 'clsx'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  ATTACHMENT_POISON_METHODS,
  poisonBlock,
  type AttachmentPoisonMethod,
} from '../../services/attachmentPoison.js'
import { setAttachmentPoison, useSettings } from '../../services/settings.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import styles from './Settings.module.css'

/**
 * 附件投毒设置：默认关闭；启用后可在上传前改写附件内容，让模型读取附件时看到填写的文本。
 *
 * 所有处理都在上传前的浏览器本地完成；原始文件仍保存在 IndexedDB，重新上传时可重新投毒。
 */
const METHOD_KEYS = {
  text: {
    label: 'attachmentPoisonMethodText',
    description: 'attachmentPoisonMethodTextDescription',
  },
  docx: {
    label: 'attachmentPoisonMethodDocx',
    description: 'attachmentPoisonMethodDocxDescription',
  },
  imageOverlay: {
    label: 'attachmentPoisonMethodImageOverlay',
    description: 'attachmentPoisonMethodImageOverlayDescription',
  },
  imageMetadata: {
    label: 'attachmentPoisonMethodImageMetadata',
    description: 'attachmentPoisonMethodImageMetadataDescription',
  },
  binaryTrailer: {
    label: 'attachmentPoisonMethodBinaryTrailer',
    description: 'attachmentPoisonMethodBinaryTrailerDescription',
  },
  filename: {
    label: 'attachmentPoisonMethodFilename',
    description: 'attachmentPoisonMethodFilenameDescription',
  },
  sidecar: {
    label: 'attachmentPoisonMethodSidecar',
    description: 'attachmentPoisonMethodSidecarDescription',
  },
} satisfies Record<AttachmentPoisonMethod, { label: TranslationKey; description: TranslationKey }>

export const AttachmentPoisonSettings = () => {
  const t = useTranslate()
  const config = useSettings((state) => state.attachmentPoison)
  const preview = useMemo(
    () => poisonBlock(config.content) || t('attachmentPoisonPreviewEmpty'),
    [config.content, t]
  )
  const positions: { value: 'prepend' | 'append'; label: string }[] = [
    { value: 'prepend', label: t('attachmentPoisonPositionPrepend') },
    { value: 'append', label: t('attachmentPoisonPositionAppend') },
  ]
  const toggleMethod = (method: AttachmentPoisonMethod, enabled: boolean) =>
    setAttachmentPoison({
      methods: enabled
        ? [...config.methods, method]
        : config.methods.filter((item) => item !== method),
    })

  return (
    <>
      <Cell
        label={t('attachmentPoisonEnabled')}
        description={t('attachmentPoisonEnabledDescription')}
        action={
          <Switch
            checked={config.enabled}
            onChange={(enabled) => setAttachmentPoison({ enabled })}
            label={t('attachmentPoisonEnabled')}
          />
        }
      />

      {config.enabled ? (
        <>
          <div className={styles.systemPrompt}>
            <div className={styles.systemPromptHead}>
              <div className={styles.systemPromptLabel}>{t('attachmentPoisonContent')}</div>
              <div className={styles.systemPromptDescription}>
                {t('attachmentPoisonContentDescription')}
              </div>
            </div>
            <textarea
              className={styles.systemPromptTextarea}
              aria-label={t('attachmentPoisonContent')}
              rows={5}
              maxLength={4000}
              spellCheck={false}
              placeholder={t('attachmentPoisonContentPlaceholder')}
              value={config.content}
              onChange={(event) => setAttachmentPoison({ content: event.target.value })}
            />
            <div className={styles.systemPromptActions}>
              <span className={styles.systemPromptHint}>
                {t('attachmentPoisonContentHint', { count: config.content.length })}
              </span>
            </div>
          </div>

          <Cell
            label={t('attachmentPoisonPosition')}
            description={t('attachmentPoisonPositionDescription')}
            action={
              <Select
                ariaLabel={t('attachmentPoisonPosition')}
                value={config.position}
                options={positions}
                onChange={(position) => setAttachmentPoison({ position })}
              />
            }
          />

          <div className={styles.poisonSection}>
            <div className={styles.poisonSectionHead}>
              <div className={styles.poisonSectionTitle}>{t('attachmentPoisonMethods')}</div>
              <span className={styles.poisonCount}>
                {t('attachmentPoisonMethodCount', { count: config.methods.length })}
              </span>
            </div>
            <div className={styles.poisonSectionHint}>
              {t('attachmentPoisonMethodsDescription')}
            </div>
            {ATTACHMENT_POISON_METHODS.map((method) => {
              const meta = METHOD_KEYS[method]
              return (
                <Cell
                  key={method}
                  label={t(meta.label)}
                  description={t(meta.description)}
                  action={
                    <Switch
                      checked={config.methods.includes(method)}
                      onChange={(enabled) => toggleMethod(method, enabled)}
                      label={t(meta.label)}
                    />
                  }
                />
              )
            })}
            {config.methods.length === 0 ? (
              <div className={styles.poisonEmpty}>{t('attachmentPoisonNoMethods')}</div>
            ) : null}
          </div>

          <div className={styles.pipeline}>{t('attachmentPoisonFootnote')}</div>
          <details className={styles.promptPreview}>
            <summary className={styles.promptPreviewSummary}>
              {t('attachmentPoisonPreview')}
            </summary>
            <pre className={styles.promptPreviewBody}>{preview}</pre>
          </details>
        </>
      ) : (
        <div className={styles.pipeline}>{t('attachmentPoisonOffHint')}</div>
      )}
    </>
  )
}

const Cell = ({
  label,
  description,
  action,
}: {
  label: string
  description?: string
  action: ReactNode
}) => (
  <div className={clsx(styles.cell, styles.row)}>
    <div className={styles.text}>
      <div className={styles.label}>{label}</div>
      {description ? <div className={styles.description}>{description}</div> : null}
    </div>
    {action}
  </div>
)
