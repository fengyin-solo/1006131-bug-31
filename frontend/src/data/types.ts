/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/**
 * 写库结果：整组写入要么全成要么全退。
 * snapshot 是提交前的全量快照，供调用方在「提交后核对」失败时整体撤销。
 */
export type CommitResult = {
  ok: boolean
  message: string
  snapshot: Record<string, EntryRow[]>
}

/** 按刀盘位置定位一把刀具时的稳定标识。 */
export type CutterLocator = {
  /** 刀具编号，例如 CUTT-0107 */
  code: string
  /** 刀盘位置，例如 12# */
  position: string
}
