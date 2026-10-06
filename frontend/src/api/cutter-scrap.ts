import { listRows, restoreRows, saveModules, snapshotRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 只有本工区的机械员能报废刀具，其他角色一律拒绝。
export const SCRAP_ROLE = '机械员'

// 磨损上限全平台就按这一份算：数据层没有分刀具类型的上限表，历史记录里也缺字段，
// 单一常量最不容易算岔；以后若出分类型上限表，只改这一处。
export const CUTTER_WEAR_LIMIT_MM = 20

const CUTTER_KEY = 'cutter'
const RING_KEY = 'ring'
const STATUS_SCRAPPED = '已报废'
const STATUS_REPLACED = '已更换'

// 更换确认没走完的刀具不许报废：每种状态缺哪一步写死在这里，拦截时照实报。
const MISSING_STEPS: Record<string, string[]> = {
  正常: ['登记检查', '安排更换（更换确认）'],
  待更换: ['安排更换（更换确认）'],
}

export type ScrapOperator = {
  name: string
  role: string
  workArea: string
}

export type ScrapInput = {
  scrapDate: string
  reason: string
}

export type ScrapOutcome = {
  ok: boolean
  message: string
  scrapped: string[]
  merged: string[]
}

export type PositionRecon = {
  position: string
  total: number
  normal: number
  pending: number
  replaced: number
  scrapped: number
  overLimitActive: number
}

function cutterLabel(row: EntryRow | undefined, id: number): string {
  if (!row) {
    return `编号 ${id}`
  }
  return `${row['刀具编号'] ?? id}（${row['刀盘位置'] ?? '位置未知'}）`
}

// 历史记录的磨损量可能是「未测」「刀具磨损样例」这类非数值，解析不出来就返回 null，
// 不参与超限判断，也不拦报废。
export function parseWearMm(value: unknown): number | null {
  const match = String(value ?? '').match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : null
}

export function isOverLimit(row: EntryRow): boolean {
  const wear = parseWearMm(row['当前磨损量'])
  return wear !== null && wear >= CUTTER_WEAR_LIMIT_MM
}

// 掘进环次的待换刀具清单就认刀具台账这一份：每次台账变动后重算，
// 由调用方连同刀具改动在同一次 saveModules 里落库，两处看到的数天然对得上。
export function buildRingPendingSync(
  cutterRows: EntryRow[],
  ringRows: EntryRow[],
): { rows: EntryRow[]; count: number; changed: boolean } {
  const pending = cutterRows.filter((row) => String(row.status) === '待更换')
  const count = pending.length
  const list = pending.map((row) => `${row['刀具编号']}（${row['刀盘位置']}）`).join('、')
  let changed = false
  const rows = ringRows.map((row) => {
    if (String(row.status) !== '掘进中') {
      return row
    }
    if (Number(row['待换刀具数'] ?? -1) === count && String(row['待换刀具清单'] ?? '') === list) {
      return row
    }
    changed = true
    return { ...row, 待换刀具数: count, 待换刀具清单: list }
  })
  return { rows, count, changed }
}

// 存量刀具按刀盘位置重新过一遍：清账时账面与现场对照用。
export function reconcileCuttersByPosition(rows: EntryRow[] = listRows(CUTTER_KEY)): PositionRecon[] {
  const groups = new Map<string, PositionRecon>()
  for (const row of rows) {
    const position = String(row['刀盘位置'] ?? '') || '未登记位置'
    let group = groups.get(position)
    if (!group) {
      group = { position, total: 0, normal: 0, pending: 0, replaced: 0, scrapped: 0, overLimitActive: 0 }
      groups.set(position, group)
    }
    group.total += 1
    const status = String(row.status)
    if (status === '正常') group.normal += 1
    else if (status === '待更换') group.pending += 1
    else if (status === '已更换') group.replaced += 1
    else if (status === STATUS_SCRAPPED) group.scrapped += 1
    if (status !== STATUS_SCRAPPED && isOverLimit(row)) {
      group.overLimitActive += 1
    }
  }
  return [...groups.values()].sort((a, b) => a.position.localeCompare(b.position, 'zh-Hans-CN'))
}

/**
 * 批量报废唯一实现：单把报废、勾选报废、其他模块入口最终都调这里。
 * - 整组校验，有一把写不进去就全组退回，消息里逐把点名；
 * - 每把的状态、更换日期、报废日期、报废原因落在同一次写入；
 * - 已报废的刀重复提交只认最早的日期（取两次提交里较早的那天，与提交顺序无关）；
 * - 刀具台账与掘进环次待换清单同一次落库，写不进去就整体撤销；
 * - 落库后回读核对，对不上同样整体撤销。
 */
export function scrapCutters(ids: number[], input: ScrapInput, operator: ScrapOperator): ScrapOutcome {
  const none: string[] = []
  if (operator.role !== SCRAP_ROLE) {
    return {
      ok: false,
      message: `只有本工区的机械员能报废刀具，当前操作人「${operator.name}」的角色是「${operator.role || '未登记'}」，已拒绝`,
      scrapped: none,
      merged: none,
    }
  }
  const uniqueIds = [...new Set(ids.map(Number))].filter((id) => Number.isFinite(id))
  if (uniqueIds.length === 0) {
    return { ok: false, message: '先勾选要报废的刀具', scrapped: none, merged: none }
  }
  const scrapDate = input.scrapDate.trim()
  const reason = input.reason.trim()
  if (!scrapDate) {
    return { ok: false, message: '报废日期不能为空', scrapped: none, merged: none }
  }
  if (!reason) {
    return { ok: false, message: '报废原因不能为空', scrapped: none, merged: none }
  }

  const rows = listRows(CUTTER_KEY)
  const byId = new Map(rows.map((row) => [Number(row.id), row]))

  // 先整组校验：任何一把不合格就全组退回，一把都不写。
  const failures: string[] = []
  for (const id of uniqueIds) {
    const row = byId.get(id)
    if (!row) {
      failures.push(`编号 ${id}：台账里查不到这把刀`)
      continue
    }
    const area = String(row['所属工区'] ?? '')
    if (area && operator.workArea && area !== operator.workArea) {
      failures.push(`${cutterLabel(row, id)}：属于${area}，本工区（${operator.workArea}）的机械员无权报废`)
      continue
    }
    const missing = MISSING_STEPS[String(row.status)]
    if (missing) {
      failures.push(`${cutterLabel(row, id)}：当前「${row.status}」，越级提交已拦下，缺${missing.map((s) => `「${s}」`).join('、')}`)
    }
  }
  if (failures.length > 0) {
    return { ok: false, message: `整组退回，一把都没写：${failures.join('；')}`, scrapped: none, merged: none }
  }

  const scrapped: string[] = []
  const merged: string[] = []
  let changed = false
  const nextRows = rows.map((row) => {
    const id = Number(row.id)
    if (!uniqueIds.includes(id)) {
      return row
    }
    if (String(row.status) === STATUS_SCRAPPED) {
      // 重复报废只认最早的日期：本次日期更早就采用本次的日期与原因，否则原样保留。
      const existing = String(row['报废日期'] ?? row['更换日期'] ?? '')
      merged.push(String(row['刀具编号'] ?? id))
      if (existing && existing <= scrapDate) {
        return row
      }
      changed = true
      return { ...row, 更换日期: scrapDate, 报废日期: scrapDate, 报废原因: reason }
    }
    // 状态、更换日期、报废日期、报废原因同一把刀同一次写入。
    scrapped.push(String(row['刀具编号'] ?? id))
    changed = true
    return {
      ...row,
      status: STATUS_SCRAPPED,
      pending: false,
      abnormal: false,
      更换日期: scrapDate,
      报废日期: scrapDate,
      报废原因: reason,
      报废人: operator.name,
    }
  })

  const ringSync = buildRingPendingSync(nextRows, listRows(RING_KEY))
  const snapshot = snapshotRows()
  try {
    if (changed || ringSync.changed) {
      saveModules({ [CUTTER_KEY]: nextRows, [RING_KEY]: ringSync.rows })
    }
  } catch (error) {
    restoreRows(snapshot)
    const detail = error instanceof Error ? error.message : '本地存储写入失败'
    return { ok: false, message: `写入失败，整组已撤销：${detail}`, scrapped: none, merged: none }
  }

  // 提交之后回读核对一遍：每一把都应该是「已报废」，对不上就整体撤销。
  try {
    const after = new Map(listRows(CUTTER_KEY).map((row) => [Number(row.id), row]))
    for (const id of uniqueIds) {
      if (String(after.get(id)?.status) !== STATUS_SCRAPPED) {
        throw new Error(`编号 ${id} 回读状态不是已报废`)
      }
    }
  } catch (error) {
    restoreRows(snapshot)
    const detail = error instanceof Error ? error.message : '回读失败'
    return { ok: false, message: `提交后核对未通过，已整体撤销：${detail}`, scrapped: none, merged: none }
  }

  const parts = [`已报废 ${scrapped.length} 把：${scrapped.join('、') || '无'}`]
  if (merged.length > 0) {
    parts.push(`${merged.length} 把重复报废，只认最早的日期：${merged.join('、')}`)
  }
  parts.push(`掘进环次待换刀具数已同步为 ${ringSync.count}`)
  return { ok: true, message: parts.join('；'), scrapped, merged }
}
