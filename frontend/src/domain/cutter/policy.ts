/**
 * 磨损上限口径（权衡结论）
 * ------------------------------------------------------------
 * 现场存在两份口径：刀具厂家说明书偏松（多掘进几环），项目部换刀管理细则偏严
 * （偏保守、保掌子面安全）。清账是安全关口，这里只认一份：
 *   以《项目部换刀管理细则 v2026.03》为准；
 *   厂家说明书留作登记初值参考，不再参与「要不要换」的判定。
 * 历史台账里按旧口径判过结论的刀（数据来源=历史台账）保留原结论、不追溯翻案，
 * 但会在「磨损判定口径」里留痕；存量刀具按刀盘位置重过时只重判新口径入库的刀。
 */

export const WEAR_POLICY_VERSION = '项目部换刀管理细则 v2026.03'
export const LEGACY_POLICY_TAG = '历史台账（按当时口径保留）'
export const LEGACY_SOURCE = '历史台账'

/**
 * 按刀型给磨损上限（mm，直径方向磨损量）。
 * 中心滚刀/正面滚刀磨损到限风险最高，限得最紧；边缘刮刀以崩刃为主，磨损量限较宽。
 * 未登记刀型走「通用滚刀」档，宁严勿松。
 */
const WEAR_LIMIT_MM: Record<string, number> = {
  中心滚刀: 15,
  正面滚刀: 20,
  边缘滚刀: 25,
  边缘刮刀: 30,
  保径刀: 12,
  通用滚刀: 20,
}

export const FALLBACK_TYPE = '通用滚刀'

export function wearLimitMm(cutterType: string): number {
  return WEAR_LIMIT_MM[cutterType] ?? WEAR_LIMIT_MM[FALLBACK_TYPE]
}

/** 当前磨损量是否触限：达到上限即换（含等于，临界值按超限处理）。 */
export function isWearOut(cutterType: string, wearMm: number): boolean {
  return wearMm >= wearLimitMm(cutterType)
}

/** 列表/自检用：当前刀型还剩多少磨损余量。 */
export function wearMarginMm(cutterType: string, wearMm: number): number {
  return wearLimitMm(cutterType) - wearMm
}

export function allWearLimits(): { type: string; limitMm: number }[] {
  return Object.entries(WEAR_LIMIT_MM).map(([type, limitMm]) => ({ type, limitMm }))
}
