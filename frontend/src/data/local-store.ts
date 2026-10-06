import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveModules({ [key]: rows })
}

// 多模块一次写入：整个 storage 只有一个键，setItem 要么全成要么全不成，
// 所以跨模块的改动（比如刀具报废 + 掘进环次待换清单）不会写一半。
// setItem 抛错时 cache 不切换，内存里还是旧数据，等于整体撤销。
export function saveModules(patch: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...patch }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

export function snapshotRows(): Record<string, EntryRow[]> {
  return clone(allRows())
}

// 写入后核对不通过时整体回滚到快照；localStorage 写不进去也只能尽量恢复内存态。
export function restoreRows(snapshot: Record<string, EntryRow[]>): void {
  const next = clone(snapshot)
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // 撤销本身也写不进去时，至少内存态已经回到快照，页面重载前数据一致。
    }
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
