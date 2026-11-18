import { cityNames, regionCodes, regionNameOverrides, provinceNames } from './locationData.js'

export { regionCodes } from './locationData.js'

export const provinces = Object.entries(provinceNames).map(([code, name]) => ({
  code,
  name,
  cities: Object.entries(cityNames)
    .filter(([city]) => city.startsWith(code.slice(0, 2)))
    .map(([code, name]) => ({ code, name })),
}))

/** 科幻/特殊位置：空间站、月球、火星，覆盖普通行政区选择 */
export const specialPlaces = [
  { id: 'station-satellite', zh: '空间站 · 卫星', en: 'Space Station · Satellite' },
  { id: 'station-core', zh: '空间站 · 空间站', en: 'Space Station · Station' },
  { id: 'moon-near', zh: '月球 · 月之明面', en: 'Moon · Near Side' },
  { id: 'moon-far', zh: '月球 · 月之暗面', en: 'Moon · Far Side' },
  { id: 'mars-center', zh: '火星 · 时空管理中心', en: 'Mars · Spacetime Management Center' },
] as const

export type SpecialPlace = (typeof specialPlaces)[number]['id']

const specialPlaceIds = new Set<string>(specialPlaces.map((item) => item.id))

export const specialPlaceName = (id: SpecialPlace, locale: 'zh-CN' | 'en-US'): string =>
  specialPlaces.find((item) => item.id === id)?.[locale === 'zh-CN' ? 'zh' : 'en'] ?? id

export type UserLocation = {
  region: string
  province?: string
  city?: string
  /** 设置后忽略行政区，作为位置注入 latest_reminder */
  place?: SpecialPlace
  /** 用户手动输入的位置，优先于行政区与特殊位置；只影响 latest_reminder */
  custom?: string
}

/** 自定义位置只作为一行文本注入，去掉换行、逗号并限制长度，避免破坏 latest_reminder 字段 */
const normalizeCustomPlace = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const text = value
    .replace(/[\r\n,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? undefined : text.slice(0, 120)
}

const regions = new Set(regionCodes)
const regionNames = {
  'zh-CN': new Intl.DisplayNames(['zh-CN'], { type: 'region' }),
  'en-US': new Intl.DisplayNames(['en-US'], { type: 'region' }),
}

export const getRegionName = (code: string, locale: 'zh-CN' | 'en-US'): string =>
  regions.has(code)
    ? (regionNameOverrides[locale][code] ?? regionNames[locale].of(code) ?? code)
    : ''

export const normalizeLocation = (value: unknown): UserLocation | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const location = value as Record<string, unknown>
  const { region, province, city, place } = location
  const custom = normalizeCustomPlace(location.custom)
  if (custom) {
    return { region: 'CN', custom }
  }
  if (place !== undefined) {
    return typeof place === 'string' && specialPlaceIds.has(place)
      ? { region: 'CN', place: place as SpecialPlace }
      : null
  }
  if (typeof region !== 'string' || !regions.has(region)) {
    return null
  }
  if (region !== 'CN') {
    return { region }
  }
  if (province === undefined) {
    return city === undefined ? { region } : null
  }
  const selectedProvince = provinces.find((item) => item.code === province)
  if (!selectedProvince) {
    return null
  }
  if (city === undefined) {
    return { region, province: selectedProvince.code }
  }
  const selectedCity = selectedProvince.cities.find((item) => item.code === city)
  return selectedCity ? { region, province: selectedProvince.code, city: selectedCity.code } : null
}
