import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import {
  checkForUpdate,
  currentVersion,
  isAndroidApp,
  type UpdateInfo,
} from '../../services/update.js'
import { useSettings } from '../../services/settings.js'
import styles from './UpdateCard.module.css'

/** GitHub 的 ISO 时间转成本地可读时间 */
const formatDate = (iso: string, locale: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

/**
 * 设置 → 关于 里的「检查更新」卡片。
 *
 * 点一下向 GitHub Releases 要最新版本：已是最新 / 有新版本（安卓端额外给 APK 直链，
 * 用普通链接打开，APK 里会交给系统浏览器）/ 失败三种结果都在卡片内展示。
 */
export const UpdateCard = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [checking, setChecking] = useState(false)
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const check = async () => {
    setChecking(true)
    setError(null)
    try {
      setInfo(await checkForUpdate())
    } catch (failure) {
      setInfo(null)
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setChecking(false)
    }
  }

  const notes = info?.notes?.trim() ?? ''
  // 优先给 APK 直链，没有产物就退回 Release 页面
  const downloadUrl = info ? info.apkUrl || info.pageUrl : ''

  return (
    <div className={styles.card} data-section="update">
      <div className={styles.head}>
        <span className={styles.current}>{t('updateCurrent', { version: currentVersion() })}</span>
        <Button
          size="s"
          variant="outlined"
          disabled={checking}
          aria-busy={checking}
          onClick={() => void check()}
        >
          {checking ? t('updateChecking') : t('updateCheck')}
        </Button>
      </div>
      {error ? <div className={styles.error}>{t('updateFailed', { reason: error })}</div> : null}
      {info ? (
        <div className={styles.result}>
          <div className={info.hasUpdate ? styles.available : styles.latest}>
            {info.hasUpdate ? t('updateAvailable', { version: info.latest }) : t('updateLatest')}
          </div>
          {info.hasUpdate ? (
            <>
              {isAndroidApp() ? <div className={styles.hint}>{t('updateAndroidHint')}</div> : null}
              <a className={styles.download} href={downloadUrl} target="_blank" rel="noreferrer">
                {t('updateDownload')}
              </a>
            </>
          ) : null}
          {info.publishedAt ? (
            <div className={styles.meta}>
              {t('updatePublishedAt', { date: formatDate(info.publishedAt, locale) })}
            </div>
          ) : null}
          {notes ? (
            <details className={styles.notes}>
              <summary className={styles.notesSummary}>{t('updateNotes')}</summary>
              <pre className={styles.notesBody}>{notes.slice(0, 500)}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
