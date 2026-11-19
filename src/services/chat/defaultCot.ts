import source from '../../assets/default-cot.txt'

/**
 * 默认自定义思维链。
 *
 * 内容来自仓库根目录的 thinking_prompt.txt（随包内联，不依赖运行时文件）。
 * 首次使用、清空自定义思维链后「填入示例」、以及恢复默认设置都回落到这段文本；
 * 仍然受 CUSTOM_COT_MAX_CHARS 限制，超长由写入方截断。
 */
export const DEFAULT_CUSTOM_COT = source.replace(/\r\n?/g, '\n').trim()
