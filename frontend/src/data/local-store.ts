import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
// 与业务数据放在同一个 JSON 里的元数据键：迁移标记、提交台账都在这里，保证一次写入同生共死。
const META_KEY = '__meta__'
// 写库后核对：最多重试 3 次（首次 + 2 次重试），仍不一致就按存不下处理、整体撤销。
const COMMIT_ATTEMPTS = 3
const RETRY_DELAY_MS = 60

export type StoreMeta = {
  migrations: Record<string, boolean>
  /** 提交台账：同一批刀具重复提交时只认最早落账的那一次。 */
  submissions: Record<string, SubmissionRecord>
}

export type SubmissionRecord = {
  key: string
  acceptedAt: string
  result: ScrapLedgerResult
}

/** 报废台账里对每一把刀的落账结果，重放时原样返回，保证连点两回按头一回。 */
export type ScrapLedgerResult = {
  id: number
  code: string
  position: string
  status: string
  scrapDate: string
  reason: string
}[]

export type Database = {
  entries: Record<string, EntryRow[]>
  meta: StoreMeta
}

export type CommitResult = {
  ok: boolean
  message: string
  /** 提交前全量快照：核对不过时用它整体撤销，不留半截账。 */
  snapshot: Database
}

/** 存储后端可替换：浏览器用 localStorage，自检用内存实现，也可以塞一个故意写失败的实现。 */
export interface StorageBackend {
  read(): string | null
  write(raw: string): void
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emptyMeta(): StoreMeta {
  return { migrations: {}, submissions: {} }
}

const browserBackend: StorageBackend = {
  read() {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null
    }
    return window.localStorage.getItem(STORAGE_KEY)
  },
  write(raw) {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, raw)
    }
  },
}

let backend: StorageBackend = browserBackend
let cache: Database | null = null

/** 从后端原始 JSON 解出业务数据与元数据；历史版本（只有业务数据）自动补空元数据。 */
function decode(raw: string | null): Database {
  const fallback: Database = { entries: clone(SEED_ROWS), meta: emptyMeta() }
  if (!raw) {
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null) {
      return fallback
    }
    const meta = (parsed[META_KEY] as StoreMeta | undefined) ?? emptyMeta()
    const entries = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key !== META_KEY),
    ) as Record<string, EntryRow[]>
    // 新模块、新字段以种子数据兜底，老数据覆盖同名模块。
    return {
      entries: { ...fallback.entries, ...entries },
      meta: {
        migrations: { ...meta.migrations },
        submissions: { ...meta.submissions },
      },
    }
  } catch {
    return fallback
  }
}

function encode(db: Database): string {
  return JSON.stringify({ ...db.entries, [META_KEY]: db.meta })
}

function all(): Database {
  if (cache === null) {
    cache = decode(backend.read())
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return all().entries
}

export function listRows(key: string): EntryRow[] {
  return all().entries[key] ?? []
}

export function getMeta(): StoreMeta {
  return all().meta
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const db = all()
  const next: Database = {
    entries: { ...db.entries, [key]: rows },
    meta: clone(db.meta),
  }
  backend.write(encode(next))
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 唯一的写库入口：在内存快照上改，整组一次落盘；落盘后立即读回核对，
 * 读不回或对不上就重试，重试不过就用提交前快照整体撤销。
 * mutate 抛错属于「整组里有不合法项」，当场退回，不触盘。
 */
export async function commit(
  mutate: (draft: Database) => void,
  describe: (count: number) => string,
): Promise<CommitResult> {
  const base = all()
  const snapshot = clone(base)
  const draft = clone(base)
  try {
    mutate(draft)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '写入前校验未通过，整组退回',
      snapshot,
    }
  }
  const intended = encode(draft)
  let lastMessage = '写入失败'
  for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt += 1) {
    try {
      backend.write(intended)
    } catch (error) {
      lastMessage = `存不下（第 ${attempt} 次）：${error instanceof Error ? error.message : '存储不可用'}`
      await sleep(RETRY_DELAY_MS)
      continue
    }
    // 提交后核对：必须重新从后端读，读不到绝不拿内存里的上一版充当成功。
    const raw = backend.read()
    if (raw === null || raw === undefined) {
      lastMessage = `提交后取不到数据（第 ${attempt} 次），已保留原账等待重试`
      await sleep(RETRY_DELAY_MS)
      continue
    }
    const readback = decode(raw)
    if (encode(readback) === intended) {
      // 只有核对通过才把缓存切到新账；坏数据绝不污染内存里的最后一份好账。
      cache = readback
      const changed = countChangedRows(snapshot.entries, draft.entries)
      return { ok: true, message: describe(changed), snapshot }
    }
    lastMessage = `提交后读回的数据与提交不一致（第 ${attempt} 次）`
    await sleep(RETRY_DELAY_MS)
  }
  // 全部重试失败：尝试把提交前快照写回去撤销，撤销后同样要读回核对。
  try {
    backend.write(encode(snapshot))
    const rollbackRaw = backend.read()
    if (rollbackRaw !== null && rollbackRaw !== undefined) {
      const rollback = decode(rollbackRaw)
      if (encode(rollback) === encode(snapshot)) {
        cache = rollback
        lastMessage += '；已整体撤销，账表未变'
      } else {
        lastMessage += '；撤销写回后读回仍不一致，请立即核对本地存储'
      }
    } else {
      cache = snapshot
      lastMessage += '；撤销已写盘但暂时读不回，已保留提交前账表'
    }
  } catch {
    lastMessage += '；撤销写回也失败，请核对本地存储'
  }
  return { ok: false, message: lastMessage, snapshot }
}

function countChangedRows(
  before: Record<string, EntryRow[]>,
  after: Record<string, EntryRow[]>,
): number {
  let count = 0
  for (const key of Object.keys(after)) {
    const left = before[key] ?? []
    const right = after[key] ?? []
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      count += Math.max(left.length, right.length)
    }
  }
  return count
}

/**
 * 只跑一次的迁移：以 meta.migrations 为闸，重放安全。
 * 注意迁移本身也走 commit，所以它同样满足「要么整体成功，要么不动账」。
 */
export async function runOnce(
  migrationId: string,
  migrate: (draft: Database) => void,
): Promise<boolean> {
  if (all().meta.migrations[migrationId]) {
    return false
  }
  const result = await commit(
    (draft) => {
      if (draft.meta.migrations[migrationId]) {
        return
      }
      migrate(draft)
      draft.meta.migrations[migrationId] = true
    },
    () => '存量数据已按最新口径重过一遍',
  )
  return result.ok
}

/** 替换存储后端（自检用），并清空内存缓存强制重读。 */
export function useBackend(next: StorageBackend | null): void {
  backend = next ?? browserBackend
  cache = null
}

/** 测试辅助：直接预置一份库。 */
export function seedDatabase(next: Database): void {
  backend.write(encode(next))
  cache = clone(next)
}

/**
 * 用快照恢复账表：供领域层在「commit 已成功、但提交后业务核对失败」时兜底回滚。
 * 恢复同样要读回核对，失败返回 false，由调用方如实上报。
 */
export function restoreSnapshot(snapshot: Database): boolean {
  try {
    backend.write(encode(snapshot))
    const raw = backend.read()
    if (raw === null || raw === undefined) {
      cache = clone(snapshot)
      return false
    }
    const readback = decode(raw)
    if (encode(readback) !== encode(snapshot)) {
      cache = clone(snapshot)
      return false
    }
    cache = readback
    return true
  } catch {
    cache = clone(snapshot)
    return false
  }
}
