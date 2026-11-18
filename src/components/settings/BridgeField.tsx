import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { ApiError } from '../../services/api/client.js'
import { getBridgeTransport } from '../../services/api/bridge.js'
import { verifyProvider } from '../../services/api/provider.js'
import type { ApiProvider } from '../../services/api/types.js'
import {
  setApiProvider,
  setBridgeExtensionId,
  useBridgeMode,
  useSettings,
} from '../../services/settings.js'
import { Button } from '../base/Button.js'
import styles from './Settings.module.css'

const describeError = (
  error: unknown,
  t: ReturnType<typeof useTranslate>
): string => {
  if (error instanceof ApiError && error.localMessage) {
    return t(error.localMessage.key, error.localMessage.params)
  }
  return error instanceof Error ? error.message : String(error)
}

/** 推理通道选择：DeepSeek 直连或 OpenCode Bridge 扩展 */
export const ProviderField = () => {
  const t = useTranslate()
  const provider = useSettings((state) => state.apiProvider)
  const options: Array<{ value: ApiProvider; label: string }> = [
    { value: 'deepseek', label: t('settingProviderDeepseekOptionLabel') },
    { value: 'opencode-bridge', label: t('settingProviderBridgeOptionLabel') },
  ]
  return (
    <div className={styles.cell}>
      <div className={styles.label}>{t('settingProviderLabel')}</div>
      <div className={styles.description}>{t('settingProviderDescription')}</div>
      <div className={styles.row}>
        {options.map((option) => (
          <Button
            key={option.value}
            variant={provider === option.value ? 'primary' : 'outlined'}
            size="s"
            onClick={() => setApiProvider(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** OpenCode Bridge 配置：扩展 ID + 连接测试 + 使用步骤 */
export const BridgeField = () => {
  const t = useTranslate()
  const bridgeMode = useBridgeMode()
  const savedId = useSettings((state) => state.bridgeExtensionId)
  const [value, setValue] = useState(savedId)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  if (!bridgeMode) {
    return null
  }

  const save = () => setBridgeExtensionId(value)

  const test = async () => {
    const id = value.trim()
    setBridgeExtensionId(id)
    setTesting(true)
    setResult(null)
    try {
      await verifyProvider('')
      const transport =
        getBridgeTransport() === 'relay' ? t('bridgeTransportRelay') : t('bridgeTransportDirect')
      setResult({
        ok: true,
        message: t('bridgeTestConnectionOk', { transport }),
      })
    } catch (error) {
      setResult({
        ok: false,
        message: t('bridgeTestConnectionFailed', { message: describeError(error, t) }),
      })
    } finally {
      setTesting(false)
    }
  }

  const origin = typeof location === 'undefined' ? '' : location.origin

  return (
    <div className={styles.cell}>
      <div className={styles.label}>{t('bridgeExtensionIdLabel')}</div>
      <div className={styles.description}>{t('bridgeExtensionIdDescription')}</div>
      <div className={styles.apiKeyInput}>
        <input
          type="text"
          placeholder={t('bridgeExtensionIdPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              save()
              void test()
            }
          }}
        />
        {!testing ? (
          <>
            <span className={styles.divider} />
            <button type="button" className={styles.confirm} onMouseDown={(event) => event.preventDefault()} onClick={() => void test()}>
              {t('bridgeTestConnection')}
            </button>
          </>
        ) : null}
      </div>
      {result ? (
        <div className={result.ok ? styles.description : styles.error}>{result.message}</div>
      ) : null}
      <div className={styles.systemPromptHint}>
        <strong>{t('bridgeSetupTitle')}</strong>
        <div>{t('bridgeSetupOriginHint', { origin })}</div>
        <div>{t('bridgeSetupSafariHint')}</div>
        <div>{t('bridgeSetupKeyHint')}</div>
        <div>{t('bridgeSetupUserAgentHint')}</div>
        <div>{t('bridgeSetupBaseUrlHint')}</div>
      </div>
    </div>
  )
}
