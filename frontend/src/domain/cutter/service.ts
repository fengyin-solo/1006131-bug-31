/**
 * 刀具报废（及整条刀具状态线）的唯一写库实现。
 * 单把报废、勾选批量报废、环次页上的报废入口全部调用 scrapCutters，
 * 不允许任何页面绕过这里直接 saveRows。
 */
import {
  commit,
  getMeta,
  listRows,
  restoreSnapshot,
  runOnce,
} from '@/data/local-store'
import type { ScrapLedgerResult } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import { WEAR_POLICY_VERSION, isWearOut } from './policy'
import {
  asCutter,
  asRow,
  canOperateCutter,
  earlierDate,
  labelOf,
  pendingByRing,
  reevaluateStatus,
  scrapGate,
  sortByPosition,
} from './records'
import { CUTTER_STATUS } from './types'
import type {
  CutterActionOutcome,
  CutterRecord,
  Operator,
  ScrapItem,
  ScrapOutcome,
  ScrapRequest,
} from './types'

const MODULE_KEY = 'cutter'
const MIGRATION_ID = 'cutter-reconcile-2026-10'
const SUBMISSION_PREFIX = 'scrap:'

// 连点两回：同一幂等键在途时直接挂到第一回的 Promise 上，结果按头一回。
const inflight = new Map<string, Promise<ScrapOutcome>>()

function readCutters(): CutterRecord[] {
  return sortByPosition(listRows(MODULE_KEY).map(asCutter))
}

export function listCutters(
  filters: Record<string, string> = {},
): { items: CutterRecord[]; total: number } {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const items = readCutters().filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
  return { items, total: items.length }
}

export { pendingByRing, pendingCuttersOfRing, labelOf } from './records'
export { allWearLimits, wearLimitMm, WEAR_POLICY_VERSION } from './policy'

/**
 * 统一报废入口。规则：
 *  1. 只有本工区机械员能报，越权当场拒绝；
 *  2. 必须走完更换确认，逐级点名缺哪一步；
 *  3. 校验整组先跑完，任何一把不过，整组不触盘；
 *  4. 每把刀的状态、更换日期、报废日期、报废原因在同一次 commit 里落库；
 *  5. 同一把刀重复报废只认最早日期；同一请求重复提交只认最早那次；
 *  6. 存不下 / 提交后核对不过，由 commit 重试并整体撤销。
 */
export function scrapCutters(request: ScrapRequest): Promise<ScrapOutcome> {
  const dedupeKey = request.idempotencyKey
  const pendingPromise = inflight.get(dedupeKey)
  if (pendingPromise) {
    return pendingPromise
  }
  const promise = executeScrap(request).finally(() => {
    inflight.delete(dedupeKey)
  })
  inflight.set(dedupeKey, promise)
  return promise
}

async function executeScrap(request: ScrapRequest): Promise<ScrapOutcome> {
  // 0. 先看提交台账：头一回已经落账的，原样返回，绝不改日期、不再写一遍。
  const ledgerKey = SUBMISSION_PREFIX + request.idempotencyKey
  const recorded = getMeta().submissions[ledgerKey]
  if (recorded) {
    return replayOutcome(recorded.result, request.items)
  }

  const rows = readCutters()
  const byId = new Map(rows.map((row) => [row.id, row]))
  const violations: string[] = []

  // 1. 请求自身是否站得住：空组、重复点名、日期/原因缺失。
  if (request.items.length === 0) {
    return { ok: false, message: '没有选择要报废的刀具', violations, replayed: false }
  }
  const requestedIds = new Set<number>()
  for (const item of request.items) {
    if (requestedIds.has(item.id)) {
      violations.push(`刀具 id=${item.id} 在同一组里被勾选了多次，请合并为一条`)
    }
    requestedIds.add(item.id)
  }
  for (const item of request.items) {
    if (!Number.isFinite(Date.parse(item.scrapDate))) {
      violations.push(`刀具 id=${item.id} 报废日期缺失或不是有效日期`)
    }
    if (!item.reason.trim()) {
      violations.push(`刀具 id=${item.id} 报废原因为空，报废原因必须随状态同次写入`)
    }
  }

  // 2. 逐把：存在性 → 权限 → 状态机（含越级）→ 日期。
  const plan = new Map<number, { record: CutterRecord; item: ScrapItem }>()
  for (const item of request.items) {
    const record = byId.get(item.id)
    if (!record) {
      violations.push(`刀具 id=${item.id} 在台账里不存在，可能已被别人清掉，请刷新后重试`)
      continue
    }
    const auth = canOperateCutter(request.operator, record)
    if (!auth.allowed) {
      violations.push(auth.reason ?? `${labelOf(record)} 无权报废`)
      continue
    }
    const gate = scrapGate(record)
    if (gate) {
      violations.push(gate)
      continue
    }
    // 同一把刀重复报废只认最早日期：理论上 scrapGate 已拦已报废，这里是双保险。
    const effectiveDate = record.报废日期
      ? earlierDate(record.报废日期, item.scrapDate)
      : item.scrapDate
    plan.set(item.id, {
      record,
      item: { ...item, scrapDate: effectiveDate },
    })
  }

  if (violations.length > 0) {
    return {
      ok: false,
      message: `整组报废被拦下：${violations.length} 把刀不满足条件，未写入任何数据。`,
      violations,
      replayed: false,
    }
  }

  // 3. 一次性落库：状态、更换日期（原样保留）、报废日期、报废原因同生共死。
  const commitResult = await commit(
    (draft) => {
      const cutterRows = draft.entries[MODULE_KEY]
      for (const [id, choice] of plan) {
        const index = cutterRows.findIndex((row) => Number(row.id) === id)
        if (index < 0) {
          // 极端竞态：快照里有、草稿里没了。抛错即整组退回。
          throw new Error(`刀具 id=${id} 写入时找不到，整组退回`)
        }
        const before = asCutter(cutterRows[index])
        if (before.status === CUTTER_STATUS.scrapped) {
          throw new Error(`${labelOf(before)} 已经报废，重复报废只认最早日期，整组退回`)
        }
        const next: CutterRecord = {
          ...before,
          status: CUTTER_STATUS.scrapped,
          pending: false,
          abnormal: false,
          报废日期: choice.item.scrapDate,
          报废原因: choice.item.reason.trim(),
          报废申请人: request.operator.name,
          磨损判定口径: before.磨损判定口径 || WEAR_POLICY_VERSION,
        }
        cutterRows[index] = asRow(next)
      }
      // 提交台账随本次写入一起落盘：重复提交重放时拿得到头一回。
      const acceptedAt = new Date().toISOString()
      draft.meta.submissions[ledgerKey] = {
        key: ledgerKey,
        acceptedAt,
        result: [...plan.values()].map(({ record, item }) => ({
          id: record.id,
          code: record.刀具编号,
          position: record.刀盘位置,
          status: CUTTER_STATUS.scrapped,
          scrapDate: item.scrapDate,
          reason: item.reason.trim(),
        })),
      }
    },
    (count) => `本组 ${plan.size} 把刀具已一次性报废并销账（共核对 ${count} 行）`,
  )

  if (!commitResult.ok) {
    return { ok: false, message: commitResult.message, violations: [], replayed: false }
  }

  // 4. 提交后重新取列表核对：绝不用内存里拼出来的上一版。
  try {
    const fresh = readCutters()
    const verifiedItems = [...plan.values()].map(({ record, item }) => {
      const stored = fresh.find((row) => row.id === record.id)
      if (!stored || stored.status !== CUTTER_STATUS.scrapped) {
        throw new Error(`提交后核对失败：${labelOf(record)} 未读回报废状态`)
      }
      if (stored.报废日期 !== item.scrapDate || stored.报废原因 !== item.reason.trim()) {
        throw new Error(`提交后核对失败：${labelOf(record)} 报废日期/原因与提交不一致`)
      }
      return {
        id: stored.id,
        code: stored.刀具编号,
        position: stored.刀盘位置,
        ring: stored.掘进环号,
        status: CUTTER_STATUS.scrapped,
        replaceDate: stored.更换日期,
        scrapDate: stored.报废日期,
        reason: stored.报废原因,
      }
    })
    return {
      ok: true,
      message: commitResult.message,
      items: verifiedItems,
      pendingByRing: pendingByRing(fresh),
      replayed: false,
    }
  } catch (error) {
    // 写是成功的，但读回核对不过：按「存不下就整体撤销」的同一口径回滚整组。
    const rolledBack = restoreSnapshot(commitResult.snapshot)
    const why = error instanceof Error ? error.message : '读回数据不可用'
    return {
      ok: false,
      message: rolledBack
        ? `${why}；已整组撤销，账表恢复到提交前`
        : `${why}；尝试撤销但暂未读回，请立即刷新核对`,
      violations: [],
      replayed: false,
    }
  }
}

/** 台账重放：重复提交时还原头一回的明细给页面核对。 */
function replayOutcome(
  ledger: ScrapLedgerResult,
  requested: ScrapItem[],
): ScrapOutcome {
  const fresh = readCutters()
  const byId = new Map(fresh.map((row) => [row.id, row]))
  const items = ledger.map((entry) => {
    const stored = byId.get(entry.id)
    return {
      id: entry.id,
      code: entry.code,
      position: entry.position,
      ring: stored?.掘进环号 ?? '',
      status: CUTTER_STATUS.scrapped,
      replaceDate: stored?.更换日期 ?? '',
      scrapDate: entry.scrapDate,
      reason: entry.reason,
    }
  })
  const requestedAgain = requested.map((item) => item.id).join('、')
  return {
    ok: true,
    message: `这批报废已按最早一次提交落账，本次为重复提交，未重复销账（重复点选：${requestedAgain}）`,
    items,
    pendingByRing: pendingByRing(fresh),
    replayed: true,
  }
}

/* ------------------------------------------------------------------ */
/* 其余状态流转：登记检查 / 安排更换 / 确认更换，同样只有这一个实现。      */
/* ------------------------------------------------------------------ */

async function applyTransition(args: {
  operator: Operator
  ids: number[]
  check: (record: CutterRecord, operator: Operator) => string | null
  build: (record: CutterRecord, operator: Operator, today: string) => CutterRecord
  actionName: string
}): Promise<CutterActionOutcome> {
  const { operator, ids } = args
  const rows = readCutters()
  const byId = new Map(rows.map((row) => [row.id, row]))
  const violations: string[] = []
  const targets: CutterRecord[] = []
  for (const id of ids) {
    const record = byId.get(id)
    if (!record) {
      violations.push(`刀具 id=${id} 不存在`)
      continue
    }
    const issue = args.check(record, operator)
    if (issue) {
      violations.push(issue)
      continue
    }
    targets.push(record)
  }
  if (ids.length === 0) {
    return { ok: false, message: '没有选中刀具', violations: [] }
  }
  if (violations.length > 0) {
    return {
      ok: false,
      message: `${args.actionName}被拦下：${violations.length} 把不满足条件，未写入任何数据。`,
      violations,
    }
  }
  const today = new Date().toISOString().slice(0, 10)
  const idsSet = new Set(targets.map((record) => record.id))
  const result = await commit(
    (draft) => {
      for (const row of draft.entries[MODULE_KEY]) {
        if (!idsSet.has(Number(row.id))) {
          continue
        }
        const before = asCutter(row)
        const next = args.build(before, operator, today)
        Object.assign(row, asRow(next))
      }
    },
    () => `${args.actionName}完成，共 ${targets.length} 把`,
  )
  if (!result.ok) {
    return { ok: false, message: result.message }
  }
  // 提交后核对。
  const fresh = new Map(readCutters().map((row) => [row.id, row]))
  for (const target of targets) {
    if (!fresh.has(target.id)) {
      return { ok: false, message: `${args.actionName}后读不到 ${labelOf(target)}，请刷新核对` }
    }
  }
  return { ok: true, message: result.message }
}

/** 登记检查：磨损触限即判「待更换」，未触限维持「正常」，任何岗位都可登记检查结果。 */
export function inspectCutters(operator: Operator, ids: number[]): Promise<CutterActionOutcome> {
  return applyTransition({
    operator,
    ids,
    actionName: '登记检查',
    check: (record) => {
      if (record.status === CUTTER_STATUS.scrapped) {
        return `${labelOf(record)} 已报废，不再检查`
      }
      if (record.status === CUTTER_STATUS.replaced) {
        return `${labelOf(record)} 已更换完成，检查请登记到新刀上`
      }
      return null
    },
    build: (record) => {
      const out = isWearOut(record.刀具类型, record.当前磨损量)
      return {
        ...record,
        status: out ? CUTTER_STATUS.pendingReplace : CUTTER_STATUS.normal,
        pending: out,
        abnormal: out,
        检查人员: record.检查人员 || operator.name,
        磨损判定口径: WEAR_POLICY_VERSION,
      }
    },
  })
}

/** 安排更换：待更换 → 已更换，但还没确认；未确认前不能报废。任何在岗位人员都可安排。 */
export function arrangeReplacement(
  operator: Operator,
  ids: number[],
): Promise<CutterActionOutcome> {
  return applyTransition({
    operator,
    ids,
    actionName: '安排更换',
    check: (record) => {
      if (record.status !== CUTTER_STATUS.pendingReplace) {
        return `${labelOf(record)} 当前「${record.status}」，只有「待更换」的刀能安排更换，越级操作拦下`
      }
      return null
    },
    build: (record, _operator, today) => ({
      ...record,
      status: CUTTER_STATUS.replaced,
      pending: true,
      abnormal: false,
      更换日期: record.更换日期 || today,
    }),
  })
}

/** 确认更换：本工区机械员专属，走完这一步才允许报废。 */
export function confirmReplacement(
  operator: Operator,
  ids: number[],
): Promise<CutterActionOutcome> {
  return applyTransition({
    operator,
    ids,
    actionName: '更换确认',
    check: (record, currentOperator) => {
      if (record.status === CUTTER_STATUS.scrapped) {
        return `${labelOf(record)} 已报废，无需确认`
      }
      if (record.status !== CUTTER_STATUS.replaced) {
        return `${labelOf(record)} 当前「${record.status}」，需先安排更换才能确认，越级操作拦下`
      }
      const auth = canOperateCutter(currentOperator, record)
      return auth.allowed ? null : auth.reason ?? null
    },
    build: (record, currentOperator, today) => ({
      ...record,
      status: CUTTER_STATUS.replaced,
      pending: false,
      abnormal: false,
      更换日期: record.更换日期 || today,
      更换确认人: currentOperator.name,
      更换确认日期: today,
    }),
  })
}

/* ------------------------------------------------------------------ */
/* 存量刀具按刀盘位置重新过一遍：迁移只跑一次，幂等可重放。               */
/* ------------------------------------------------------------------ */

export async function reconcileExistingCutters(): Promise<boolean> {
  return runOnce(MIGRATION_ID, (draft) => {
    const rows = (draft.entries[MODULE_KEY] ?? []).map(asCutter)
    const next = sortByPosition(rows.map(reevaluateStatus)).map(asRow)
    draft.entries[MODULE_KEY] = next as EntryRow[]
  })
}
