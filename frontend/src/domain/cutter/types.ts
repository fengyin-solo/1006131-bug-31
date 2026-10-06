/**
 * 刀具领域：所有入口（单把、勾选批量、环次清单）写库都走 src/domain/cutter/service.ts 这一段。
 * 这里放领域类型，与页面、存储无关，方便单测。
 */

/** 刀具四态：正常 → 待更换 → 已更换 → 已报废，报废只能从「已更换且更换确认完成」过来。 */
export const CUTTER_STATUS = {
  normal: '正常',
  pendingReplace: '待更换',
  replaced: '已更换',
  scrapped: '已报废',
} as const

export type CutterStatus = (typeof CUTTER_STATUS)[keyof typeof CUTTER_STATUS]

/** 作业角色与工区：只有本工区的机械员能报废刀具。 */
export type OperatorRole = '机械员' | '值班管理员' | '质检员'

export type Operator = {
  name: string
  role: OperatorRole
  /** 所属工区，例如 一工区；跨工区报废一律拒绝。 */
  section: string
}

/** 每把刀在台账里的扩展字段（沿用 EntryRow 的开放结构，这里给出有名字的列）。 */
export type CutterRecord = {
  id: number
  status: CutterStatus
  pending: boolean
  abnormal: boolean
  刀具编号: string
  刀盘位置: string
  刀具类型: string
  初始直径: number
  当前磨损量: number
  /** 更换日期：走完「更换确认」时落下；报废同一次写入不再改它。 */
  更换日期: string
  检查人员: string
  所属工区: string
  /** 挂账的掘进环：待换刀具清单按环归并，两处看同一个数。 */
  掘进环号: string
  磨损判定口径: string
  /** 更换确认：未确认的「已更换」仍不许报废，防越级。 */
  更换确认人: string
  更换确认日期: string
  /** 报废三要素：状态、更换日期之外，报废日期与原因必须落在同一次写入。 */
  报废日期: string
  报废原因: string
  报废申请人: string
  数据来源: string
  [field: string]: string | number | boolean
}

export type ScrapItem = {
  id: number
  /** 报废日期；同一把刀重复报废只认最早日期（由服务端台账裁断，页面传值不算数）。 */
  scrapDate: string
  reason: string
}

export type ScrapRequest = {
  operator: Operator
  items: ScrapItem[]
  /** 幂等键：同一请求连点两回，第二回直接返回头一回的结果。 */
  idempotencyKey: string
}

export type ScrapItemResult = {
  id: number
  code: string
  position: string
  ring: string
  status: CutterStatus
  replaceDate: string
  scrapDate: string
  reason: string
}

export type ScrapOutcome =
  | {
      ok: true
      message: string
      /** 提交成功后读回的整组明细：页面拿它核对，不用本地拼出来的上一版。 */
      items: ScrapItemResult[]
      /** 环次待换刀具数快照：与环次页同源，应与报废后读回的数对得上。 */
      pendingByRing: Record<string, number>
      /** 本次是否直接命中了最早那次提交（重复提交）。 */
      replayed: boolean
    }
  | {
      ok: false
      message: string
      /** 整体退回时逐条点名是哪把刀、缺哪一步。 */
      violations: string[]
      replayed: boolean
    }

/** 通用整组动作结果（登记检查/安排更换/确认更换也统一走服务）。 */
export type CutterActionOutcome = {
  ok: boolean
  message: string
  violations?: string[]
}
