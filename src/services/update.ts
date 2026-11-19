/**
 * 更新检测：读取当前版本（构建时注入的 meta），向 GitHub Releases 要最新版本。
 *
 * 只用公开的 `releases/latest` 接口，不带 token、不上传任何数据；失败时抛错由
 * 界面显示原因。安卓端下载页同时给出 APK 直链（有产物时）与 Release 页面。
 */

const REPO = 'dawangnailong/chat4code-unrestricted'
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`

export type UpdateInfo = {
  current: string
  latest: string
  hasUpdate: boolean
  /** 打开发布页（安卓端会跳到系统浏览器） */
  pageUrl: string
  /** Release 里第一个 .apk 的下载地址（没有则为空） */
  apkUrl: string
  publishedAt?: string
  notes?: string
}

/** 构建时注入的版本号 */
export const currentVersion = (): string =>
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? '0.0.0'

/** 是否运行在 Android 壳里（本地服务注入的 meta） */
export const isAndroidApp = (): boolean =>
  Boolean(document.querySelector('meta[name="nanovm-app"]'))

/** 比较 x.y.z：返回 1 表示 a 比 b 新 */
const compareVersion = (a: string, b: string): number => {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((value) => (Number.isFinite(value) ? value : 0))
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) {
      return diff > 0 ? 1 : -1
    }
  }
  return 0
}

type ReleasePayload = {
  tag_name?: string
  html_url?: string
  published_at?: string
  body?: string
  assets?: { name?: string; browser_download_url?: string }[]
}

export const checkForUpdate = async (signal?: AbortSignal): Promise<UpdateInfo> => {
  const current = currentVersion()
  const response = await fetch(API_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    signal,
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}`)
  }
  const payload = (await response.json()) as ReleasePayload
  const latest = (payload.tag_name ?? '').replace(/^v/i, '') || current
  const apk = (payload.assets ?? []).find((asset) =>
    (asset.name ?? '').toLowerCase().endsWith('.apk')
  )
  return {
    current,
    latest,
    hasUpdate: compareVersion(latest, current) > 0,
    pageUrl: payload.html_url || RELEASES_URL,
    apkUrl: apk?.browser_download_url ?? '',
    publishedAt: payload.published_at,
    notes: payload.body ?? '',
  }
}
