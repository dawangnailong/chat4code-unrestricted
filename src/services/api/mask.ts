/**
 * API Key 脱敏展示。
 *
 * 界面上任何只读展示 Key 的位置都用这个函数，避免把完整密钥直接打印在页面里
 * （截图、录屏、共享屏幕时都会泄露）。保留 `sk-` 前缀与末 4 位，中间固定四颗星：
 * 既能确认当前用的是哪一把 Key，又不足以还原。
 */

/** 掩码占位：没有 Key 时展示 */
export const NO_API_KEY = 'sk-****'

/** 只保留前缀与末 4 位；短于 8 位时全部隐藏 */
export const maskApiKey = (key: string | null | undefined): string => {
  const value = (key ?? '').trim()
  if (value === '') {
    return ''
  }
  if (value.length < 8) {
    return '****'
  }
  const prefix = value.startsWith('sk-') ? 'sk-' : ''
  return `${prefix}****${value.slice(-4)}`
}
