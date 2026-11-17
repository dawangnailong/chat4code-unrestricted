import { useTranslate } from '../../i18n/index.js'
import { useBridgeMode, useSettings } from '../../services/settings.js'
import clsx from 'clsx'
import { memo, useMemo, useState } from 'react'
import {
  IconCheckOutline16,
  IconCloseOutline16,
  IconEditOutline16,
  IconRefreshOutline16,
  IconWarningOutline16,
} from '../base/icons.js'
import { describeReply } from '../../services/chat/describe.js'
import { canContinueReply, getReplyThinking, hasReplyContent } from '../../services/chat/reply.js'
import {
  continueReply,
  editReplyContent,
  regenerateReply,
  revertReplyContent,
} from '../../services/chat/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'
import { applySTMs, getEnabledModules } from '../../services/unrestricted/stm.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { rateReply } from '../../services/chat/feedbackStore.js'
import { Markdown } from '../markdown/Markdown.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { ReadAloudButton } from './ReadAloudButton.js'
import { CopyButton } from './CopyButton.js'
import { ReplyArea } from './ReplyArea.js'
import { ReplyEditor } from './ReplyEditor.js'
import { useReplyView } from './useReplyView.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import styles from './AssistantMessage.module.css'

const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

export const AssistantMessage = memo(function AssistantMessage({
  sessionId,
  message,
  isLast,
  streaming,
  busy,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const bridgeMode = useBridgeMode()
  const [editing, setEditing] = useState(false)
  // 拒绝后继续生成：设置开关或越狱模式下允许续写被拒绝的回复。
  const allowRefused = useSettings((state) => state.continueRefused || state.unrestricted)
  const view = useReplyView(message, streaming)
  const panelEntry = useSearchPanel((state) => state.entry)
  const notice = streaming ? null : describeReply(message)
  // 安全拒绝：默认已下发内容按协议丢弃，只显示模板答复；防撤回保留了内容时按正常回复展示。
  const refused = message.stopReason === 'refusal' && !hasReplyContent(message)
  const answer = refused ? null : view.answer
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  // 输出整形只在生成结束后作用于展示与复制，不改写已保存的正文
  const stmModules = useSettings((state) => state.stmModules)
  const shapedText = useMemo(
    () =>
      stmModules.length === 0 || streaming
        ? null
        : applySTMs(responseText, getEnabledModules(stmModules)),
    [responseText, stmModules, streaming]
  )
  const shapedMarkdown = useMemo(
    () =>
      stmModules.length === 0 || streaming || !answer
        ? null
        : applySTMs(answer.markdown, getEnabledModules(stmModules)),
    [answer, stmModules, streaming]
  )
  const copyText = (shapedText ?? responseText) || notice?.text
  const waiting = streaming && view.steps.length === 0 && !view.answer && !message.thinking
  const summaryEntry = `${message.id}-summary`
  // 失败、拒绝与模板提示没有可改写的模型正文；生成中不允许改写。
  const editable =
    !streaming && !refused && message.status !== 'error' && notice?.presentation !== 'response'
  if (editing) {
    return (
      <div className={styles.message}>
        <ReplyEditor
          hasThinking={message.blocks.some(
            (block) => block.type === 'thinking' && block.thinking.trim() !== ''
          )}
          canRevert={Boolean(message.edited)}
          busy={busy}
          initialThinking={getReplyThinking(message)}
          initialText={view.answer?.text ?? ''}
          onCancel={() => setEditing(false)}
          onSave={(draft) => {
            if (editReplyContent(sessionId, message.id, draft)) {
              setEditing(false)
              showToast({ key: 'replyEditSaved' })
            }
          }}
          onRevert={() => {
            if (revertReplyContent(sessionId, message.id)) {
              setEditing(false)
              showToast({ key: 'replyEditReverted' })
            }
          }}
        />
      </div>
    )
  }
  return (
    <div className={styles.message}>
      {refused ? null : (
        <ReplyArea
          message={message}
          view={view}
          streaming={streaming}
          hasResponse={!!responseText}
        />
      )}
      {answer ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={shapedMarkdown ?? answer.markdown}
          loading={streaming}
          cacheKey={shapedMarkdown === null ? message.id : `${message.id}-stm`}
          disableLink={false}
          sources={view.sources}
        />
      ) : null}
      {waiting ? (
        <div className={styles.waiting}>
          {[0, 1, 2].map((index) => (
            <span key={index} className={styles.waitingDot} />
          ))}
        </div>
      ) : null}
      {notice?.presentation === 'response' ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={notice.text}
          loading={false}
          cacheKey={`${message.id}-template`}
          disableLink={false}
        />
      ) : notice ? (
        <div className={styles.notice}>
          <IconWarningOutline16 />
          <span>
            {notice.text}
            {notice.action === 'apiKey' ? (
              <>
                {' '}
                <button
                  type="button"
                  className={styles.noticeAction}
                  onClick={() => openSettings('data')}
                >
                  {t('changeApiKey')}
                </button>
              </>
            ) : null}
            {notice.action === 'topUp' ? (
              <>
                {' '}
                <a
                  className={styles.noticeAction}
                  href={TOP_UP_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('topUp')}
                </a>
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      {!streaming && !refused && view.searchResults.length > 0 ? (
        <div
          className={clsx(styles.summary, panelEntry === summaryEntry && styles.summaryActive)}
          onClick={() => toggleSearchPanel(summaryEntry, view.searchResults)}
        >
          <SiteThumbnails sources={view.searchResults} />
          <span>
            {t(
              view.searchResults.length === 1 ? 'messageSearchSummary' : 'messageSearchSummaries',
              { count: view.searchResults.length }
            )}
          </span>
        </div>
      ) : null}
      {streaming ? null : (
        <div className={styles.bottom}>
          <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
            {copyText ? <CopyButton text={copyText} /> : null}
            {responseText && !refused && !bridgeMode ? (
              <ReadAloudButton
                sessionId={sessionId}
                messageId={message.id}
                text={shapedText ?? responseText}
              />
            ) : null}
            {responseText && !refused ? (
              <>
                <IconButton
                  icon={<IconCheckOutline16 />}
                  tooltip={t('feedbackHelpful')}
                  tooltipPlacement="bottom"
                  disabled={busy}
                  onClick={() => {
                    rateReply(message.id, shapedText ?? responseText, 1)
                    showToast({ key: 'feedbackThanks' })
                  }}
                />
                <IconButton
                  icon={<IconCloseOutline16 />}
                  tooltip={t('feedbackNotHelpful')}
                  tooltipPlacement="bottom"
                  disabled={busy}
                  onClick={() => {
                    rateReply(message.id, shapedText ?? responseText, -1)
                    showToast({ key: 'feedbackThanks' })
                  }}
                />
              </>
            ) : null}
            {editable ? (
              <IconButton
                icon={<IconEditOutline16 />}
                tooltip={t('editReply')}
                tooltipPlacement="bottom"
                disabled={busy}
                onClick={() => setEditing(true)}
              />
            ) : null}
            <IconButton
              icon={<IconRefreshOutline16 />}
              tooltip={t('regenerate')}
              tooltipPlacement="bottom"
              disabled={busy || refused}
              onClick={() => {
                stopReadAloud()
                regenerateReply(sessionId, message.id)
              }}
            />
          </div>
          {isLast && canContinueReply(message, allowRefused) ? (
            <Button
              variant="outlined"
              size="s"
              className={styles.continueButton}
              disabled={busy}
              onClick={() => {
                stopReadAloud()
                continueReply(sessionId, message.id)
              }}
            >
              {t('continueGenerating')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
})
