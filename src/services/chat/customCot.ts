import { translate } from '../../i18n/index.js'
import { CUSTOM_COT_MAX_CHARS } from '../settings.js'

/**
 * 自定义思维链：用户在设置里预先写好推理步骤，请求前作为 system 分块注入。
 *
 * - 关闭深度思考时可用：服务端没有独立 reasoning 通道，这段文本直接约束模型的作答过程；
 * - 开启深度思考时属于实验性：服务端自己生成 thinking，本段文本只能作为方向引导，可能被忽略或重写。
 *
 * 客户端不伪造 thinking 块：Anthropic 兼容接口的 thinking 需要服务端签名，伪造块既不可靠也会破坏续写。
 */

/** 自定义思维链的最大字符数；每轮都会注入 system，过长的文本会明显增加输入 token */
export { CUSTOM_COT_MAX_CHARS }

/** 统一换行并去掉首尾空白；空内容表示不注入 */
export const normalizeCustomCot = (text: string): string =>
  text.replace(/\r\n?/g, '\n').trim().slice(0, CUSTOM_COT_MAX_CHARS)

/** 开关打开且正文非空时才真正生效 */
export const isCustomCotActive = (enabled: boolean, text: string): boolean =>
  enabled && normalizeCustomCot(text) !== ''

/** 创建回复时保存本轮注入的思维链快照；关闭或空白时为 undefined */
export const customCotSnapshot = (enabled: boolean, text: string): string | undefined => {
  const chain = enabled ? normalizeCustomCot(text) : ''
  return chain === '' ? undefined : chain
}

/**
 * 生成注入 system 的分块。thinking 取本轮回复创建时的快照，而不是当前开关，
 * 避免生成过程中拖动思考强度导致同一轮前后文案不一致。
 */
export const formatCustomCotContext = (text: string, thinking: boolean): string => {
  const chain = normalizeCustomCot(text)
  if (chain === '') {
    return ''
  }
  return translate(thinking ? 'customCotInjectionThinking' : 'customCotInjectionDirect', {
    chain,
  })
}
