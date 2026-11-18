import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'

/** 设置弹窗的分组：通用 / 模型 / 提示词 / 思维链 / 高级 / 搜索投毒 / 记忆 / 附件 / 附件投毒 / 统计 / 数据管理 / 关于 / 更新日志 */
export type SettingsSection =
  | 'general'
  | 'model'
  | 'prompt'
  | 'cot'
  | 'advanced'
  | 'poison'
  | 'memory'
  | 'attachments'
  | 'attachmentPoison'
  | 'stats'
  | 'data'
  | 'about'
  | 'changelog'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有可用凭据时打开设置并选中「数据管理」，返回是否已配置 */
export const ensureApiKey = () => {
  const { apiKey, apiProvider, bridgeExtensionId } = useSettings.getState()
  if (apiKey) {
    return true
  }
  // Bridge 模式的 Key 在扩展里，应用侧只要求填过扩展 ID
  if (apiProvider === 'opencode-bridge') {
    if (bridgeExtensionId.trim() !== '') {
      return true
    }
    openSettings('data')
    return false
  }
  openSettings('data')
  return false
}
