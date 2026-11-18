import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconBrowseOutline16,
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconLinkOutline16,
  IconPaperclipOutline16,
  IconRefreshOutline16,
  IconSettingsOutline16,
  IconThinkOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { useIsMobile } from '../../app/viewport.js'
import { modelLabel } from '../../services/api/models.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  resetSettings,
  setAttachmentExts,
  setAutoJailbreak,
  setAttachmentLimits,
  setAttachmentMaxCount,
  setAttachmentMaxMB,
  setAutoCompress,
  setAutoTune,
  setAutoTuneStrategy,
  setInjectPromptEveryTurn,
  setContinueRefused,
  setParseltongue,
  setParseltongueIntensity,
  setParseltongueTechnique,
  setPromptPreset,
  setStmModules,
  setTranslateJailbreakZh,
  setKeepReplyContent,
  setLocale,
  setLocation,
  setMaxTokens,
  setSkipSafetyCheck,
  setSystemPrompt,
  setTemperature,
  setThemePreference,
  setTopP,
  setTtsVoice,
  setUnrestricted,
  useBridgeMode,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import type { AutoTuneStrategy } from '../../services/unrestricted/autotune.js'
import type { ObfuscationTechnique } from '../../services/unrestricted/parseltongue.js'
import type { PromptPreset } from '../../services/unrestricted/prompts.js'
import { useFeedback } from '../../services/chat/feedbackStore.js'
import { composeSystemPrompt } from '../../services/chat/systemPrompt.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import { ParamControl } from './ParamControls.js'
import paramStyles from './ParamControls.module.css'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { BridgeField, ProviderField } from './BridgeField.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'model', label: 'settingDialogAsideModelOptionLabel', icon: <IconThinkOutline16 /> },
  { value: 'prompt', label: 'settingDialogAsidePromptOptionLabel', icon: <IconEditOutline16 /> },
  {
    value: 'advanced',
    label: 'settingDialogAsideAdvancedOptionLabel',
    icon: <IconBrowseOutline16 />,
  },
  {
    value: 'attachments',
    label: 'settingDialogAsideAttachmentsOptionLabel',
    icon: <IconPaperclipOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
  { value: 'about', label: 'settingDialogAsideAboutOptionLabel', icon: <IconLinkOutline16 /> },
  {
    value: 'changelog',
    label: 'settingDialogAsideChangelogOptionLabel',
    icon: <IconRefreshOutline16 />,
  },
]

const SettingsContent = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const bridgeMode = useBridgeMode()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const [resetOpen, setResetOpen] = useState(false)
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
            </>
          ) : section === 'model' ? (
            <ModelSettings />
          ) : section === 'prompt' ? (
            <UnrestrictedSetting />
          ) : section === 'advanced' ? (
            <AdvancedSettings />
          ) : section === 'attachments' ? (
            <AttachmentsSetting />
          ) : section === 'about' ? (
            <AboutSetting />
          ) : section === 'changelog' ? (
            <ChangelogSetting />
          ) : (
            <>
              <ProviderField />
              {bridgeMode ? <BridgeField /> : <ApiKeyField editor={apiKeyEditor} />}
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('settingsResetAll')}
                description={t('settingsResetAllDescription')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={() => setResetOpen(true)}
                  >
                    {t('resetSettings')}
                  </Button>
                }
              />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile && !bridgeMode ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
      {resetOpen ? (
        <ResetSettingsConfirm
          onCancel={() => setResetOpen(false)}
          onConfirm={() => {
            resetSettings()
            setResetOpen(false)
            showToast({ key: 'resetSettingsDone' })
          }}
        />
      ) : null}
    </>
  )
}

/** 恢复默认设置确认：只重置设置，API Key 与对话数据保留。 */
const ResetSettingsConfirm = ({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: () => void
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('resetSettingsModalTitle')}
      className={styles.deleteConfirm}
      onClose={onCancel}
      footer={
        <div className={styles.deleteActions}>
          <Button variant="outlined" autoFocus onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {t('resetSettings')}
          </Button>
        </div>
      }
    >
      {t('resetSettingsModalDescription')}
    </Modal>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  const bridgeMode = useBridgeMode()
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      description={bridgeMode ? t('bridgeSpeechUnsupported') : undefined}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 关于：项目简介、仓库与演示地址、上游项目。 */
const AboutSetting = () => {
  const t = useTranslate()
  const version =
    document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? ''
  const links: { label: TranslationKey; href: string }[] = [
    {
      label: 'aboutRepositoryLabel',
      href: 'https://github.com/dawangnailong/chat4code-unrestricted',
    },
    { label: 'aboutDemoLabel', href: 'https://chat-unrestricted.fur0.com/' },
    { label: 'aboutUpstreamLabel', href: 'https://github.com/deepseek-ai/chat-demo' },
  ]
  return (
    <div className={styles.about}>
      <div className={styles.aboutTitle}>
        {t('aboutProjectName')}
        {version ? <span className={styles.aboutVersion}>v{version}</span> : null}
      </div>
      <div className={styles.aboutDescription}>{t('aboutDescription')}</div>
      {links.map((link) => (
        <a
          key={link.href}
          className={styles.aboutLink}
          href={link.href}
          target="_blank"
          rel="noreferrer"
        >
          <span className={styles.aboutLinkLabel}>{t(link.label)}</span>
          {link.href}
        </a>
      ))}
    </div>
  )
}

/** 更新日志与上游鸣谢。 */
const ChangelogSetting = () => {
  const t = useTranslate()
  const groups: { title: TranslationKey; items: TranslationKey[] }[] = [
    {
      title: 'changelogV252Title',
      items: ['changelogV252Toolbar'],
    },
    {
      title: 'changelogV251Title',
      items: [
        'changelogV251Mobile',
        'changelogV251Model',
        'changelogV251Billing',
        'changelogV251Lab',
      ],
    },
    {
      title: 'changelogV25Title',
      items: [
        'changelogV25Official',
        'changelogV25Reset',
        'changelogV25Fork',
        'changelogV25VariantIO',
        'changelogV25Mobile',
        'changelogV25Popover',
        'changelogV25IO',
      ],
    },
    {
      title: 'changelogV246Title',
      items: ['changelogV246Pressure', 'changelogV246Ring', 'changelogV246Summary'],
    },
    {
      title: 'changelogV245Title',
      items: [
        'changelogV245Inject',
        'changelogV245Zh',
        'changelogV245Compress',
        'changelogV245Credits',
      ],
    },
    {
      title: 'changelogV24Title',
      items: [
        'changelogV24Techniques',
        'changelogV24Variants',
        'changelogV24Budget',
        'changelogV24Refusal',
        'changelogV24Mobile',
      ],
    },
    {
      title: 'changelogV231Title',
      items: [
        'changelogV231Hover',
        'changelogV231Combo',
        'changelogV231Auto',
        'changelogV231Feedback',
      ],
    },
    {
      title: 'changelogV23Title',
      items: [
        'changelogV23Thinking',
        'changelogV23Context',
        'changelogV23Stats',
        'changelogV23Billing',
        'changelogV23Attachments',
        'changelogV23RaceIO',
      ],
    },
    {
      title: 'changelogV22Title',
      items: [
        'changelogV22Preset',
        'changelogV22Perturb',
        'changelogV22AutoTune',
        'changelogV22Stm',
        'changelogV22Race',
      ],
    },
    {
      title: 'changelogRecentTitle',
      items: [
        'changelogRecentLab',
        'changelogRecentImport',
        'changelogRecentMcp',
        'changelogRecentDocs',
      ],
    },
    {
      title: 'changelogEarlierTitle',
      items: [
        'changelogEarlierUnrestricted',
        'changelogEarlierParams',
        'changelogEarlierRetract',
        'changelogEarlierEdit',
        'changelogEarlierPrompt',
      ],
    },
  ]
  const credits: { label: TranslationKey; note: TranslationKey; href: string }[] = [
    {
      label: 'creditEasyJailbreakLabel',
      note: 'creditEasyJailbreakNote',
      href: 'https://github.com/EasyJailbreak/EasyJailbreak',
    },
    {
      label: 'creditDeepseekChatLabel',
      note: 'creditDeepseekChatNote',
      href: 'https://github.com/deepseek-ai/chat-demo',
    },
    {
      label: 'creditG0dm0d3Label',
      note: 'creditG0dm0d3Note',
      href: 'https://github.com/elder-plinius/G0DM0D3',
    },
    {
      label: 'creditDeepseekAgentLabel',
      note: 'creditDeepseekAgentNote',
      href: 'https://github.com/Aoan2011/DeepSeek-Agent',
    },
    {
      label: 'creditDshUnrestrictedLabel',
      note: 'creditDshUnrestrictedNote',
      href: 'https://github.com/yexi-by/dsh-unrestricted',
    },
    {
      label: 'creditLibertasLabel',
      note: 'creditLibertasNote',
      href: 'https://github.com/elder-plinius/L1B3RT4S',
    },
  ]
  return (
    <div className={styles.about}>
      <div className={styles.aboutTitle}>{t('changelogTitle')}</div>
      {groups.map((group) => (
        <div key={group.title} className={styles.changelogGroup}>
          <div className={styles.changelogGroupTitle}>{t(group.title)}</div>
          <ul className={styles.changelogList}>
            {group.items.map((item) => (
              <li key={item}>{t(item)}</li>
            ))}
          </ul>
        </div>
      ))}
      <div className={styles.aboutTitle}>{t('creditsTitle')}</div>
      {credits.map((credit) => (
        <div key={credit.href} className={styles.credit}>
          <a className={styles.aboutLink} href={credit.href} target="_blank" rel="noreferrer">
            <span className={styles.aboutLinkLabel}>{t(credit.label)}</span>
            {credit.href}
          </a>
          <div className={styles.creditNote}>{t(credit.note)}</div>
        </div>
      ))}
    </div>
  )
}

/**
 * 模型参数与回复开关：采样温度、Top P、每次回复的输出上限，
 * 以及防撤回、跳过安全审核、拒绝后继续生成。越狱模式下后两个强制执行。
 */
const ModelSettings = () => {
  const t = useTranslate()
  const temperature = useSettings((state) => state.temperature)
  const topP = useSettings((state) => state.topP)
  const maxTokens = useSettings((state) => state.maxTokens)
  const model = useSettings((state) => state.model)
  const keepReplyContent = useSettings((state) => state.keepReplyContent)
  const skipSafetyCheck = useSettings((state) => state.skipSafetyCheck)
  const continueRefused = useSettings((state) => state.continueRefused)
  // 越狱模式下两项限制强制执行，开关显示为已开启且不可单独关闭。
  const unrestricted = useSettings((state) => state.unrestricted)
  const autoCompress = useSettings((state) => state.autoCompress)
  return (
    <>
      <SettingCell
        label={t('settingsModel')}
        description={t('settingsModelDescription')}
        status={null}
        action={<span className={styles.modelBadge}>{modelLabel(model)}</span>}
      />
      <SettingCell
        label={t('settingsTemperature')}
        description={t('settingsTemperatureDescription')}
        status={null}
        className={paramStyles.cell}
        action={
          <ParamControl
            label={t('settingsTemperature')}
            value={temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={(value) => setTemperature(value ?? 1)}
          />
        }
      />
      <SettingCell
        label={t('settingsTopP')}
        description={t('settingsTopPDescription')}
        status={null}
        className={paramStyles.cell}
        action={
          <ParamControl
            label={t('settingsTopP')}
            value={topP}
            min={0.01}
            max={1}
            step={0.01}
            onChange={(value) => setTopP(value ?? 1)}
          />
        }
      />
      <SettingCell
        label={t('settingsMaxTokens')}
        description={t('settingsMaxTokensDescription')}
        status={null}
        className={paramStyles.cell}
        action={
          <ParamControl
            label={t('settingsMaxTokens')}
            value={maxTokens}
            min={1}
            max={65536}
            step={1}
            optional
            onChange={setMaxTokens}
          />
        }
      />
      <SettingCell
        label={t('settingsKeepReply')}
        description={t('settingsKeepReplyDescription')}
        status={null}
        action={
          <Switch
            checked={keepReplyContent}
            onChange={setKeepReplyContent}
            label={t('settingsKeepReply')}
          />
        }
      />
      <SettingCell
        label={t('settingsSkipSafetyCheck')}
        description={t('settingsSkipSafetyCheckDescription')}
        status={null}
        action={
          <Switch
            checked={skipSafetyCheck || unrestricted}
            disabled={unrestricted}
            onChange={setSkipSafetyCheck}
            label={t('settingsSkipSafetyCheck')}
          />
        }
      />
      <SettingCell
        label={t('settingsAutoCompress')}
        description={t('settingsAutoCompressDescription')}
        status={null}
        action={
          <Switch
            checked={autoCompress}
            onChange={setAutoCompress}
            label={t('settingsAutoCompress')}
          />
        }
      />
      <SettingCell
        label={t('settingsContinueRefused')}
        description={t('settingsContinueRefusedDescription')}
        status={null}
        action={
          <Switch
            checked={continueRefused || unrestricted}
            disabled={unrestricted}
            onChange={setContinueRefused}
            label={t('settingsContinueRefused')}
          />
        }
      />
    </>
  )
}

/**
 * 系统提示词组装流水线：打开「解除限制模式」后，请求发出前把 Persona 与破限规则分块拼在一起，
 * 同时跳过安全审核、允许继续生成被拒绝的回复；关闭时原样放行官方默认提示词。
 * 下方可预览实际下发的全文。
 */
const UnrestrictedSetting = () => {
  const t = useTranslate()
  const unrestricted = useSettings((state) => state.unrestricted)
  const systemPrompt = useSettings((state) => state.systemPrompt)
  const promptPreset = useSettings((state) => state.promptPreset)
  const injectPrompt = useSettings((state) => state.injectPromptEveryTurn)
  const translateJailbreak = useSettings((state) => state.translateJailbreakZh)
  return (
    <>
      <SettingCell
        label={t('settingsUnrestricted')}
        description={t('settingsUnrestrictedDescription')}
        status={null}
        action={
          <Switch
            checked={unrestricted}
            onChange={setUnrestricted}
            label={t('settingsUnrestricted')}
          />
        }
      />
      <SettingCell
        label={t('settingsInjectPrompt')}
        description={t('settingsInjectPromptDescription')}
        status={null}
        action={
          <Switch
            checked={injectPrompt}
            onChange={setInjectPromptEveryTurn}
            label={t('settingsInjectPrompt')}
          />
        }
      />
      <SystemPromptSetting />
      <div className={styles.pipeline}>
        {t(
          systemPrompt !== null
            ? 'settingsPipelineCustom'
            : promptPreset === 'godmode'
              ? 'settingsPipelineGodmode'
              : unrestricted
                ? 'settingsPipelineUnrestricted'
                : 'settingsPipelineDefault'
        )}
      </div>
      <details className={styles.promptPreview}>
        <summary className={styles.promptPreviewSummary}>{t('settingsPromptPreview')}</summary>
        <pre className={styles.promptPreviewBody}>
          {composeSystemPrompt(unrestricted, systemPrompt, promptPreset, translateJailbreak)}
        </pre>
      </details>
    </>
  )
}

/**
 * 自定义系统提示词：留空沿用自动组装结果，填写后原样作为 system 下发。
 * 草稿独立于设置值，清空输入框不会立刻回填默认内容；「填入默认」把当前组装结果填进输入框。
 */
const SystemPromptSetting = () => {
  const t = useTranslate()
  const unrestricted = useSettings((state) => state.unrestricted)
  const systemPrompt = useSettings((state) => state.systemPrompt)
  const promptPreset = useSettings((state) => state.promptPreset)
  const translateJailbreak = useSettings((state) => state.translateJailbreakZh)
  const [draft, setDraft] = useState(systemPrompt ?? '')

  // 外部重置（恢复默认）或切换分组后同步草稿
  useEffect(() => {
    setDraft(systemPrompt ?? '')
  }, [systemPrompt])

  const commit = (value: string) => {
    setDraft(value)
    setSystemPrompt(value)
  }

  return (
    <div className={styles.systemPrompt}>
      <div className={styles.systemPromptHead}>
        <div className={styles.systemPromptLabel}>{t('settingsCustomPrompt')}</div>
        <div className={styles.systemPromptDescription}>{t('settingsCustomPromptDescription')}</div>
      </div>
      <textarea
        className={styles.systemPromptTextarea}
        aria-label={t('settingsCustomPrompt')}
        rows={6}
        placeholder={t('settingsCustomPromptPlaceholder')}
        value={draft}
        onChange={(event) => commit(event.target.value)}
      />
      <div className={styles.systemPromptActions}>
        <span className={styles.systemPromptHint}>
          {t(systemPrompt === null ? 'settingsCustomPromptAuto' : 'settingsCustomPromptCustom')}
        </span>
        <Button
          variant="outlined"
          size="s"
          onClick={() =>
            commit(composeSystemPrompt(unrestricted, null, promptPreset, translateJailbreak))
          }
        >
          {t('settingsCustomPromptFill')}
        </Button>
        <Button
          variant="outlined"
          size="s"
          disabled={systemPrompt === null}
          onClick={() => commit('')}
        >
          {t('settingsCustomPromptReset')}
        </Button>
      </div>
    </div>
  )
}

/**
 * 高级设置：提示词预设、输入扰动、自动调参与输出整形。
 * 这几项默认关闭，保持开箱行为与旧版本一致；改动只写入本机 localStorage。
 */
const AdvancedSettings = () => {
  const t = useTranslate()
  const promptPreset = useSettings((state) => state.promptPreset)
  const autoJailbreak = useSettings((state) => state.autoJailbreak)
  const translateJailbreak = useSettings((state) => state.translateJailbreakZh)
  const parseltongue = useSettings((state) => state.parseltongue)
  const technique = useSettings((state) => state.parseltongueTechnique)
  const intensity = useSettings((state) => state.parseltongueIntensity)
  const autoTune = useSettings((state) => state.autoTune)
  const strategy = useSettings((state) => state.autoTuneStrategy)
  const stmModules = useSettings((state) => state.stmModules)
  const feedbackSamples = useFeedback((state) => state.state.history.length)

  const presets: { value: PromptPreset; label: string }[] = [
    { value: 'deepseek', label: t('settingsPromptPresetDeepseek') },
    { value: 'godmode', label: t('settingsPromptPresetGodmode') },
  ]
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
  const strategies: { value: AutoTuneStrategy; label: string }[] = [
    { value: 'adaptive', label: t('settingsAutoTuneAdaptive') },
    { value: 'precise', label: t('settingsAutoTunePrecise') },
    { value: 'balanced', label: t('settingsAutoTuneBalanced') },
    { value: 'creative', label: t('settingsAutoTuneCreative') },
    { value: 'chaotic', label: t('settingsAutoTuneChaotic') },
  ]
  const stmRows: { id: string; label: string }[] = [
    { id: 'hedge_reducer', label: t('settingsStmHedge') },
    { id: 'direct_mode', label: t('settingsStmDirect') },
    { id: 'casual_mode', label: t('settingsStmCasual') },
  ]

  return (
    <>
      <SettingCell
        label={t('settingsPromptPreset')}
        description={t('settingsPromptPresetDescription')}
        status={null}
        action={
          <Select
            value={promptPreset}
            options={presets}
            onChange={setPromptPreset}
            ariaLabel={t('settingsPromptPreset')}
          />
        }
      />
      <SettingCell
        label={t('autoJailbreak')}
        description={t('autoJailbreakDescription')}
        status={null}
        action={
          <Switch checked={autoJailbreak} onChange={setAutoJailbreak} label={t('autoJailbreak')} />
        }
      />
      <SettingCell
        label={t('settingsTranslateJailbreak')}
        description={t('settingsTranslateJailbreakDescription')}
        status={null}
        action={
          <Switch
            checked={translateJailbreak}
            onChange={setTranslateJailbreakZh}
            label={t('settingsTranslateJailbreak')}
          />
        }
      />
      <SettingCell
        label={t('settingsParseltongue')}
        description={t('settingsParseltongueDescription')}
        status={null}
        action={
          <Switch
            checked={parseltongue}
            onChange={setParseltongue}
            label={t('settingsParseltongue')}
          />
        }
      />
      <SettingCell
        label={t('settingsParseltongueTechnique')}
        description={t('settingsParseltongueTechniqueDescription')}
        status={null}
        action={
          <Select
            value={technique}
            options={techniques}
            onChange={setParseltongueTechnique}
            ariaLabel={t('settingsParseltongueTechnique')}
          />
        }
      />
      <SettingCell
        label={t('settingsParseltongueIntensity')}
        description={t('settingsParseltongueIntensityDescription')}
        status={null}
        action={
          <Select
            value={intensity}
            options={intensities}
            onChange={setParseltongueIntensity}
            ariaLabel={t('settingsParseltongueIntensity')}
          />
        }
      />
      <div className={styles.pipeline}>{t('settingsParseltongueHint')}</div>
      <SettingCell
        label={t('settingsAutoTune')}
        description={t('settingsAutoTuneDescription')}
        status={null}
        action={<Switch checked={autoTune} onChange={setAutoTune} label={t('settingsAutoTune')} />}
      />
      <SettingCell
        label={t('settingsAutoTuneStrategy')}
        description={t('settingsAutoTuneStrategyDescription')}
        status={null}
        action={
          <Select
            value={strategy}
            options={strategies}
            onChange={setAutoTuneStrategy}
            ariaLabel={t('settingsAutoTuneStrategy')}
          />
        }
      />
      <div className={styles.pipeline}>{t('settingsAutoTuneHint')}</div>
      {stmRows.map((row, index) => (
        <SettingCell
          key={row.id}
          label={row.label}
          description={index === 0 ? t('settingsStmDescription') : undefined}
          status={null}
          action={
            <Switch
              checked={stmModules.includes(row.id)}
              onChange={(enabled) =>
                setStmModules(
                  enabled ? [...stmModules, row.id] : stmModules.filter((id) => id !== row.id)
                )
              }
              label={row.label}
            />
          }
        />
      ))}
      <div className={styles.pipeline}>{t('settingsStmHint')}</div>
      <div className={styles.pipeline}>
        {t('settingsFeedbackStats', { count: feedbackSamples })}
      </div>
    </>
  )
}

/**
 * 附件限制：默认按内置规则校验（单文件 64 MB、单会话 50 个、扩展名白名单），
 * 也可以关掉校验或改成自己的数值与白名单；改动立即对下一次选择和上传生效。
 */
const AttachmentsSetting = () => {
  const t = useTranslate()
  const limitEnabled = useSettings((state) => state.attachmentLimits)
  const maxMB = useSettings((state) => state.attachmentMaxMB)
  const maxCount = useSettings((state) => state.attachmentMaxCount)
  const exts = useSettings((state) => state.attachmentExts)
  const [draft, setDraft] = useState(exts ? exts.join(', ') : '')

  useEffect(() => {
    setDraft(exts ? exts.join(', ') : '')
  }, [exts])

  const commitExts = (value: string) => {
    setDraft(value)
    setAttachmentExts(
      value
        .split(/[,\n\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  }

  return (
    <>
      <SettingCell
        label={t('attachmentsLimit')}
        description={t('attachmentsLimitDescription')}
        status={null}
        action={
          <Switch
            checked={limitEnabled}
            onChange={setAttachmentLimits}
            label={t('attachmentsLimit')}
          />
        }
      />
      {limitEnabled ? null : <div className={styles.pipeline}>{t('attachmentsLimitsOff')}</div>}
      <SettingCell
        label={t('attachmentsMaxMB')}
        description={t('attachmentsMaxMBDescription')}
        status={null}
        action={
          <ParamControl
            label={t('attachmentsMaxMB')}
            value={maxMB}
            min={1}
            max={1024}
            step={1}
            optional
            onChange={setAttachmentMaxMB}
          />
        }
      />
      <SettingCell
        label={t('attachmentsMaxCount')}
        description={t('attachmentsMaxCountDescription')}
        status={null}
        action={
          <ParamControl
            label={t('attachmentsMaxCount')}
            value={maxCount}
            min={1}
            max={500}
            step={1}
            optional
            onChange={setAttachmentMaxCount}
          />
        }
      />
      <div className={styles.systemPrompt}>
        <div className={styles.systemPromptHead}>
          <div className={styles.systemPromptLabel}>{t('attachmentsExts')}</div>
          <div className={styles.systemPromptDescription}>{t('attachmentsExtsDescription')}</div>
        </div>
        <textarea
          className={styles.systemPromptTextarea}
          aria-label={t('attachmentsExts')}
          rows={4}
          spellCheck={false}
          placeholder={t('attachmentsExtsPlaceholder')}
          value={draft}
          onChange={(event) => commitExts(event.target.value)}
        />
        <div className={styles.systemPromptActions}>
          <span className={styles.systemPromptHint}>
            {exts === null
              ? t('attachmentsExtsPlaceholder')
              : t('attachmentsExtsCount', { count: exts.length })}
          </span>
          <Button
            variant="outlined"
            size="s"
            disabled={exts === null}
            onClick={() => setAttachmentExts(null)}
          >
            {t('attachmentsExtsReset')}
          </Button>
        </div>
      </div>
    </>
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      const count = await importHistory(file)
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, busy, status, select: setFile, cancel: () => setFile(null), confirm }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
