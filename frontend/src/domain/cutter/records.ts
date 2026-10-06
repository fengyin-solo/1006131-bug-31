import { CUTTER_STATUS, type CutterRecord, type Operator } from './types'
import {
  FALLBACK_TYPE,
  LEGACY_SOURCE,
  WEAR_POLICY_VERSION,
  isWearOut,
} from './policy'
import type { EntryRow } from '@/data/types'

/** 刀盘位置按「区域序号 + 编号」排，存量刀具重过时按这个顺序逐把过。 */
export function comparePosition(a: string, b: string): number {
  const pa = parsePosition(a)
  const pb = parsePosition(b)
  if (pa.zone !== pb.zone) {
    return pa.zone - pb.zone
  }
  if (pa.index !== pb.index) {
    return pa.index - pb.index
  }
  return a.localeCompare(b, 'zh-Hans-CN')
}

function parsePosition(raw: string): { zone: number; index: number } {
  // 形如 12#、中心-3#、正面-08#：抽出数字，第一段是区域、第二段是位置号。
  const digits = raw.match(/\d+/g)?.map((part) => Number(part)) ?? []
  if (digits.length === 0) {
    return { zone: Number.MAX_SAFE_INTEGER, index: 0 }
  }
  if (digits.length === 1) {
    // 纯编号按百位区间粗分区域：中心 1-20、正面 21-50、边缘 51+。
    const only = digits[0]
    return { zone: only <= 20 ? 0 : only <= 50 ? 1 : 2, index: only }
  }
  return { zone: digits[0], index: digits[1] }
}

export function sortByPosition(records: CutterRecord[]): CutterRecord[] {
  return [...records].sort((a, b) => {
    const byPosition = comparePosition(a.刀盘位置, b.刀盘位置)
    if (byPosition !== 0) {
      return byPosition
    }
    return a.id - b.id
  })
}

export function asCutter(row: EntryRow): CutterRecord {
  return {
    id: Number(row.id),
    status: String(row.status) as CutterRecord['status'],
    pending: Boolean(row.pending),
    abnormal: Boolean(row.abnormal),
    刀具编号: String(row['刀具编号'] ?? ''),
    刀盘位置: String(row['刀盘位置'] ?? ''),
    刀具类型: String(row['刀具类型'] ?? FALLBACK_TYPE),
    初始直径: toNumber(row['初始直径']),
    当前磨损量: toNumber(row['当前磨损量']),
    更换日期: String(row['更换日期'] ?? ''),
    检查人员: String(row['检查人员'] ?? ''),
    所属工区: String(row['所属工区'] ?? ''),
    掘进环号: String(row['掘进环号'] ?? ''),
    磨损判定口径: String(row['磨损判定口径'] ?? ''),
    更换确认人: String(row['更换确认人'] ?? ''),
    更换确认日期: String(row['更换确认日期'] ?? ''),
    报废日期: String(row['报废日期'] ?? ''),
    报废原因: String(row['报废原因'] ?? ''),
    报废申请人: String(row['报废申请人'] ?? ''),
    数据来源: String(row['数据来源'] ?? ''),
  }
}

export function asRow(record: CutterRecord): EntryRow {
  return { ...(record as unknown as EntryRow) }
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }
  const parsed = Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

/** 环次待换刀具清单：唯一口径，刀具页与环次页都从这里取数。 */
export function pendingByRing(records: CutterRecord[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const record of records) {
    if (record.status !== CUTTER_STATUS.pendingReplace) {
      continue
    }
    const ring = record.掘进环号 || '未挂环'
    result[ring] = (result[ring] ?? 0) + 1
  }
  return result
}

/** 某一环待换的刀具明细，环次页直接用，避免再写一套筛选。 */
export function pendingCuttersOfRing(
  records: CutterRecord[],
  ring: string,
): CutterRecord[] {
  return sortByPosition(
    records.filter(
      (record) =>
        record.status === CUTTER_STATUS.pendingReplace &&
        (ring === '未挂环' ? !record.掘进环号 : record.掘进环号 === ring),
    ),
  )
}

export function labelOf(record: CutterRecord): string {
  return `${record.刀盘位置 || '未登记位置'}（${record.刀具编号}）`
}

/** 越权判定：只有本工区的机械员能报废/确认刀具。 */
export function canOperateCutter(
  operator: Operator,
  record: CutterRecord,
): { allowed: boolean; reason?: string } {
  if (operator.role !== '机械员') {
    return {
      allowed: false,
      reason: `${operator.name} 的岗位是「${operator.role}」，只有机械员能动刀具报废/更换确认`,
    }
  }
  if (operator.section !== record.所属工区) {
    return {
      allowed: false,
      reason: `${operator.name} 属${operator.section}，${labelOf(record)} 挂在${record.所属工区}，跨工区操作一律拒绝`,
    }
  }
  return { allowed: true }
}

/**
 * 报废前置：必须走完「更换确认」。
 * 逐级点名缺哪一步，越级提交当场拦下。
 */
export function scrapGate(record: CutterRecord): string | null {
  switch (record.status) {
    case CUTTER_STATUS.normal:
      return `${labelOf(record)} 当前「正常」：需先登记检查判为待更换 → 安排更换 → 完成更换确认，才能报废，缺 3 步`
    case CUTTER_STATUS.pendingReplace:
      return `${labelOf(record)} 还挂在「待更换」：需先安排更换并完成更换确认，才能报废，缺 2 步`
    case CUTTER_STATUS.replaced:
      if (!record.更换确认人 || !record.更换确认日期) {
        return `${labelOf(record)} 状态虽是「已更换」，但更换确认没走完（缺更换确认人/确认日期），缺 1 步`
      }
      return null
    case CUTTER_STATUS.scrapped:
      return `${labelOf(record)} 已报废（报废日期 ${record.报废日期 || '未登记'}），重复报废只认最早日期`
    default:
      return `${labelOf(record)} 状态无法识别：${record.status}`
  }
}

/**
 * 存量重判：历史台账保留原结论；新口径入库的刀按当前磨损量与《项目部换刀管理细则》重过。
 * 只允许「正常 ↔ 待更换」这种同一关口的纠偏，不替现场跳过更换/报废流程。
 */
export function reevaluateStatus(record: CutterRecord): CutterRecord {
  if (record.数据来源 === LEGACY_SOURCE) {
    return { ...record, 磨损判定口径: record.磨损判定口径 || WEAR_POLICY_VERSION }
  }
  if (record.status !== CUTTER_STATUS.normal && record.status !== CUTTER_STATUS.pendingReplace) {
    return { ...record, 磨损判定口径: record.磨损判定口径 || WEAR_POLICY_VERSION }
  }
  const out = isWearOut(record.刀具类型 || FALLBACK_TYPE, record.当前磨损量)
  return {
    ...record,
    刀具类型: record.刀具类型 || FALLBACK_TYPE,
    磨损判定口径: WEAR_POLICY_VERSION,
    status: out ? CUTTER_STATUS.pendingReplace : CUTTER_STATUS.normal,
    // 正常刀不占待处理；待更换刀既待处理也算异常。
    pending: out,
    abnormal: out,
  }
}

/** 较早日期：只接受 YYYY-MM-DD；无法解析时把可解析的一侧当更早。 */
export function earlierDate(a: string, b: string): string {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta)) {
    return b
  }
  if (Number.isNaN(tb)) {
    return a
  }
  return ta <= tb ? a : b
}
