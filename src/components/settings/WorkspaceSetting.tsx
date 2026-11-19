import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  clearWorkspace,
  deleteWorkspaceFile,
  importWorkspaceFile,
  downloadWorkspaceFile,
  importWorkspace,
  importWorkspaceFiles,
  isTextFile,
  saveWorkspaceFile,
  setWorkspaceEnabled,
  setWorkspaceMode,
  useWorkspace,
  refreshWorkspaceQuota,
  workspaceLimits,
  workspaceUsage,
  type WorkspaceFile,
  type WorkspaceMode,
} from '../../services/workspace/store.js'
import { exportWorkspaceZip, readWorkspaceZip } from '../../services/workspace/archive.js'
import {
  isNativeApp,
  opfsSupported,
  readStorageStatus,
  requestPersistentStorage,
  type StorageStatus,
} from '../../services/workspace/opfs.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import { useIsMobile } from '../../app/viewport.js'
import { useSettings } from '../../services/settings.js'
import settingsStyles from './Settings.module.css'
import styles from './WorkspaceSetting.module.css'

/**
 * 设置 → 工作区。
 *
 * 浏览器本地的虚拟文件库：任意格式都能导入导出（文本、图片、PDF、压缩包……），
 * 可以新建文本文件、在线编辑、单个下载，也可以整包 ZIP 导入导出。
 * 存储可选 localStorage 或 OPFS，并支持申请持久化权限。默认关闭。
 */

/** 字节数按人类可读单位显示 */
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

const formatTime = (at: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at))

const fileKind = (file: WorkspaceFile): 'text' | 'image' | 'binary' => {
  if (isTextFile(file)) {
    return 'text'
  }
  return file.mime.startsWith('image/') ? 'image' : 'binary'
}

export const WorkspaceSetting = () => {
  const native = isNativeApp()
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  const enabled = useWorkspace((state) => state.enabled)
  const mode = useWorkspace((state) => state.mode)
  const hydrated = useWorkspace((state) => state.hydrated)
  const persistError = useWorkspace((state) => state.persistError)
  const files = useWorkspace((state) => state.files)
  const quota = useWorkspace((state) => state.quota)
  const usage = workspaceUsage()
  const limits = workspaceLimits()
  const fileList = Object.values(files).sort((a, b) => a.path.localeCompare(b.path))

  const [draft, setDraft] = useState<{ path: string; content: string; editing: boolean } | null>(
    null
  )
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [preview, setPreview] = useState<WorkspaceFile | null>(null)
  const [mergeMode, setMergeMode] = useState<'merge' | 'replace'>('merge')
  const [storage, setStorage] = useState<StorageStatus | null>(null)
  const [storageBusy, setStorageBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const archiveInputRef = useRef<HTMLInputElement>(null)

  const refreshStorage = async () => {
    setStorage(await readStorageStatus())
    await refreshWorkspaceQuota()
  }

  useEffect(() => {
    void refreshStorage()
    void refreshWorkspaceQuota()
  }, [])

  const switchMode = async (next: WorkspaceMode) => {
    if (next === mode) {
      return
    }
    setStorageBusy(true)
    try {
      const applied = await setWorkspaceMode(next)
      if (applied !== next) {
        showToast({ key: 'workspaceModeUnsupported', type: 'error' })
      } else {
        showToast({ key: 'workspaceModeSwitched' })
        await refreshStorage()
      }
    } catch {
      showToast({ key: 'workspaceModeFailed', type: 'error' })
    } finally {
      setStorageBusy(false)
    }
  }

  const startEdit = (file: WorkspaceFile) => {
    if (!isTextFile(file)) {
      showToast({ key: 'workspaceBinaryReadonly', type: 'error' })
      return
    }
    setDraft({ path: file.path, content: file.content, editing: true })
  }

  const startCreate = () => {
    setDraft({ path: '', content: '', editing: true })
  }

  const save = () => {
    if (!draft) {
      return
    }
    const result = saveWorkspaceFile(draft.path, draft.content)
    if (!result.ok) {
      showToast({ key: `workspaceSaveFailed_${result.reason}` })
      return
    }
    showToast({ key: result.created ? 'workspaceFileCreated' : 'workspaceFileSaved' })
    setDraft(null)
  }

  /** 导入任意文件：文本与二进制都接受 */
  const onImportFiles = async (list: File[]) => {
    let imported = 0
    let skipped = 0
    let oversized = false
    for (const file of list) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const result = importWorkspaceFile(file.name, bytes, file.type || '')
      if (result.ok) {
        imported += 1
      } else {
        skipped += 1
        if (result.reason === 'tooLarge' || result.reason === 'totalTooLarge') {
          oversized = true
        }
      }
    }
    if (imported === 0) {
      showToast({
        key: oversized ? 'workspaceImportTooLarge' : 'workspaceImportFailed',
        type: 'error',
      })
      return
    }
    if (skipped > 0) {
      showToast({ key: 'workspaceImportPartial', params: { count: imported, skipped } })
    } else {
      showToast({ key: 'workspaceImported', params: { count: imported } })
    }
  }

  /** 导入工作区归档：ZIP（任意文件）或旧版 JSON 备份 */
  const onImportArchive = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const lower = file.name.toLowerCase()
    if (lower.endsWith('.zip')) {
      const entries = readWorkspaceZip(bytes)
      if (entries.length === 0) {
        showToast({ key: 'workspaceImportFailed', type: 'error' })
        return
      }
      if (mergeMode === 'replace') {
        clearWorkspace()
      }
      const result = importWorkspaceFiles(entries)
      showToast({ key: 'workspaceImported', params: { count: result.imported } })
      return
    }
    const text = new TextDecoder().decode(bytes)
    const result = importWorkspace(text, mergeMode)
    if (result.error) {
      showToast({ key: 'workspaceImportFailed', type: 'error' })
      return
    }
    showToast({ key: 'workspaceImported', params: { count: result.imported } })
  }

  const exportZip = () => {
    if (fileList.length === 0) {
      return
    }
    const blob = exportWorkspaceZip(fileList)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `chat-demo-workspace-${new Date().toISOString().slice(0, 10)}.zip`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    showToast({ key: 'workspaceExported' })
  }

  return (
    <>
      <div className={settingsStyles.groupTitle}>{t('workspaceSectionTitle')}</div>
      <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
        <div className={settingsStyles.text}>
          <div className={settingsStyles.label}>{t('workspaceEnableLabel')}</div>
          <div className={settingsStyles.description}>{t('workspaceEnableDesc')}</div>
        </div>
        <Switch
          checked={enabled}
          onChange={setWorkspaceEnabled}
          label={t('workspaceEnableLabel')}
        />
      </div>

      <div className={styles.storage} data-section="storage">
        <div className={styles.storageHead}>
          <span className={styles.storageTitle}>{t('workspaceStorageMode')}</span>
          <span className={styles.modeTabs} role="tablist" aria-label={t('workspaceStorageMode')}>
            {(
              [
                { value: 'local', label: 'workspaceModeLocal' },
                { value: 'opfs', label: 'workspaceModeOpfs' },
              ] as const
            ).map((item) => {
              const unsupported = item.value === 'opfs' && !opfsSupported()
              return (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  aria-selected={mode === item.value}
                  disabled={storageBusy || unsupported}
                  className={clsx(
                    styles.modeTab,
                    mode === item.value && styles.modeTabActive,
                    unsupported && styles.modeTabDisabled
                  )}
                  onClick={() => void switchMode(item.value)}
                >
                  {t(item.label)}
                </button>
              )
            })}
          </span>
        </div>
        <div className={styles.modeDesc}>
          {t(mode === 'opfs' ? 'workspaceModeOpfsDesc' : 'workspaceModeLocalDesc')}
        </div>
        <div className={styles.storageStats}>
          <div className={styles.storageFacts}>
            <span>
              {t('workspacePersistState')}：
              {storage === null
                ? '—'
                : !storage.supported
                  ? t('workspacePersistUnsupported')
                  : storage.persisted
                    ? // APK 里数据由 Android 管理，和浏览器的持久化授权不是一回事
                      t(isNativeApp() ? 'workspacePersistNative' : 'workspacePersistGranted')
                    : t('workspacePersistNotGranted')}
            </span>
            {storage?.usage !== null && storage?.usage !== undefined ? (
              <span>
                {t('workspaceStorageUsage', {
                  usage: formatBytes(storage.usage),
                  quota: formatBytes(storage.quota ?? 0),
                })}
              </span>
            ) : null}
          </div>
          <div className={styles.storageActions}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => void refreshStorage()}
            >
              {t('workspaceStorageRefresh')}
            </button>
            {/* APK 里没有「持久化授权」这个概念，按钮点了也没意义，直接不显示 */}
            {isNativeApp() ? null : (
              <Button
                size="s"
                variant="outlined"
                disabled={storageBusy || !storage?.supported || storage?.persisted}
                onClick={() => {
                  setStorageBusy(true)
                  void requestPersistentStorage()
                    .then(async (granted) => {
                      await refreshStorage()
                      showToast({
                        key: granted
                          ? 'workspacePersistGrantedToast'
                          : 'workspacePersistDeniedToast',
                        type: granted ? undefined : 'error',
                      })
                    })
                    .finally(() => setStorageBusy(false))
                }}
              >
                {t('workspacePersistRequest')}
              </Button>
            )}
          </div>
        </div>
        {persistError ? (
          <div className={styles.persistError}>
            {t('workspacePersistError', { message: persistError })}
          </div>
        ) : null}
        {mode === 'opfs' && !hydrated ? (
          <div className={styles.hydrating}>{t('workspaceHydrating')}</div>
        ) : null}
      </div>

      <div className={styles.usage}>
        <div className={styles.usageHead}>
          <span>{t('workspaceUsageTitle')}</span>
          <span className={styles.usageNumbers}>
            {t('workspaceUsageFiles', { files: usage.files, max: limits.files })} ·{' '}
            {t('workspaceUsageBytes', {
              used: formatBytes(usage.bytes),
              max: formatBytes(limits.total),
            })}
          </span>
        </div>
        <div className={styles.bar} aria-hidden>
          <span
            style={{ width: `${Math.min(100, Math.round((usage.bytes / limits.total) * 100))}%` }}
          />
        </div>
        <div className={styles.limitLine}>
          {t('workspaceLimitsDynamic', {
            file: formatBytes(limits.file),
            total: formatBytes(limits.total),
          })}
          {' · '}
          {mode === 'opfs'
            ? quota
              ? t(native ? 'workspaceLimitsNative' : 'workspaceLimitsQuota', {
                  quota: formatBytes(quota),
                  percent: native ? 90 : 80,
                })
              : t('workspaceLimitsFallback')
            : t('workspaceLimitsLocal')}
        </div>
      </div>

      <div className={styles.actions}>
        <Button size="s" onClick={startCreate}>
          {t('workspaceNewFile')}
        </Button>
        <Button size="s" variant="outlined" onClick={() => fileInputRef.current?.click()}>
          {t('workspaceImportFiles')}
        </Button>
        <Button size="s" variant="outlined" onClick={() => archiveInputRef.current?.click()}>
          {t('workspaceImportArchive')}
        </Button>
        <Button size="s" variant="outlined" disabled={fileList.length === 0} onClick={exportZip}>
          {t('workspaceExportZip')}
        </Button>
        <div className={styles.modeTabs} role="tablist" aria-label={t('workspaceImportMode')}>
          {(['merge', 'replace'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mergeMode === item}
              className={clsx(styles.modeTab, mergeMode === item && styles.modeTabActive)}
              onClick={() => setMergeMode(item)}
            >
              {t(item === 'merge' ? 'workspaceImportMerge' : 'workspaceImportReplace')}
            </button>
          ))}
        </div>
        <Button
          size="s"
          variant="dangerOutlined"
          disabled={fileList.length === 0}
          onClick={() => {
            clearWorkspace()
            setDraft(null)
            showToast({ key: 'workspaceCleared' })
          }}
        >
          {t('workspaceClear')}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            // 先拷贝成数组再清空 input，否则 FileList 会被清空
            const list = Array.from(event.target.files ?? [])
            event.target.value = ''
            if (list.length > 0) {
              void onImportFiles(list)
            }
          }}
        />
        <input
          ref={archiveInputRef}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) {
              void onImportArchive(file)
            }
          }}
        />
      </div>

      {draft ? (
        <div className={styles.editor}>
          <input
            className={styles.pathInput}
            value={draft.path}
            placeholder={t('workspacePathPlaceholder')}
            spellCheck={false}
            onChange={(event) => setDraft({ ...draft, path: event.target.value })}
          />
          <textarea
            className={styles.textarea}
            aria-label={t('workspaceContentLabel')}
            rows={8}
            value={draft.content}
            placeholder={t('workspaceContentPlaceholder')}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
          <div className={styles.editorFoot}>
            <span className={styles.counter}>
              {formatBytes(new TextEncoder().encode(draft.content).length)} · {draft.content.length}{' '}
              字符
            </span>
            <div className={styles.editorActions}>
              <Button size="s" variant="outlined" onClick={() => setDraft(null)}>
                {t('cancel')}
              </Button>
              <Button size="s" onClick={save} disabled={!draft.path.trim()}>
                {t('workspaceSave')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {fileList.length === 0 ? (
        <div className={styles.empty}>{t('workspaceEmpty')}</div>
      ) : (
        <div className={styles.list} role="list">
          {fileList.map((file) => {
            const kind = fileKind(file)
            return (
              <div key={file.path} className={styles.row} role="listitem">
                <div className={styles.rowMain}>
                  <span className={styles.path} title={file.path}>
                    {file.path}
                  </span>
                  <span className={styles.meta}>
                    {formatBytes(file.size)} · {t(`workspaceKind_${kind}`)} ·{' '}
                    {formatTime(file.updatedAt, locale)}
                  </span>
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => setPreview(file)}
                  >
                    {t('workspacePreview')}
                  </button>
                  {kind === 'text' ? (
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => startEdit(file)}
                    >
                      {t('workspaceEdit')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => downloadWorkspaceFile(file)}
                  >
                    {t('workspaceDownload')}
                  </button>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => setPendingDelete(file.path)}
                  >
                    {t('workspaceDelete')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className={styles.note}>{isMobile ? t('workspaceNoteMobile') : t('workspaceNote')}</div>

      {preview ? (
        <Modal
          title={preview.path}
          closable
          onClose={() => setPreview(null)}
          className={styles.previewDialog}
          footer={
            <div className={styles.confirmActions}>
              <Button
                variant="outlined"
                onClick={() => {
                  downloadWorkspaceFile(preview)
                }}
              >
                {t('workspaceDownload')}
              </Button>
              <Button onClick={() => setPreview(null)}>{t('close')}</Button>
            </div>
          }
        >
          {fileKind(preview) === 'image' ? (
            <img
              className={styles.previewImage}
              alt={preview.path}
              src={`data:${preview.mime};base64,${preview.content}`}
            />
          ) : fileKind(preview) === 'text' ? (
            <pre className={styles.previewText}>{preview.content}</pre>
          ) : (
            <div className={styles.previewBinary}>
              {t('workspaceBinaryPreview', { mime: preview.mime, size: formatBytes(preview.size) })}
            </div>
          )}
        </Modal>
      ) : null}

      {pendingDelete ? (
        <Modal
          title={t('workspaceDeleteConfirmTitle')}
          onClose={() => setPendingDelete(null)}
          className={styles.confirm}
          footer={
            <div className={styles.confirmActions}>
              <Button variant="outlined" onClick={() => setPendingDelete(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  deleteWorkspaceFile(pendingDelete)
                  setPendingDelete(null)
                  showToast({ key: 'workspaceFileDeleted' })
                }}
              >
                {t('workspaceDelete')}
              </Button>
            </div>
          }
        >
          {t('workspaceDeleteConfirmBody', { path: pendingDelete })}
        </Modal>
      ) : null}
    </>
  )
}
