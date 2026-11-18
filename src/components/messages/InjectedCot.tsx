import { memo, useState } from 'react'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCustomCotOutline16,
} from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './InjectedCot.module.css'

/**
 * 关闭深度思考时，回复上方展示本轮实际注入的自定义思维链。
 * 只展示用户预设的步骤本身，不冒充服务端返回的 thinking；可折叠，默认展开。
 */
export const InjectedCot = memo(function InjectedCot({ text }: { text: string }) {
  const t = useTranslate()
  const [open, setOpen] = useState(true)
  return (
    <div className={styles.box}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        aria-label={t('injectedCotLabel')}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.icon}>
          <IconCustomCotOutline16 />
        </span>
        <span className={styles.title}>{t('injectedCotLabel')}</span>
        <span className={styles.badge}>{t('injectedCotBadge')}</span>
        <span className={styles.chevron}>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
      </button>
      {open ? <pre className={styles.body}>{text}</pre> : null}
    </div>
  )
})
