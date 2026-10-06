import { assert } from './assert'
import { useBackend, type StorageBackend } from '../src/data/local-store'
import { SEED_ROWS } from '../src/data/seed'
import {
  arrangeReplacement,
  confirmReplacement,
  inspectCutters,
  listCutters,
  pendingByRing,
  reconcileExistingCutters,
  scrapCutters,
} from '../src/domain/cutter/service'
import { CUTTER_STATUS, type Operator, type ScrapRequest } from '../src/domain/cutter/types'

const 李机械一工区: Operator = { name: '李机械', role: '机械员', section: '一工区' }
const 王机械二工区: Operator = { name: '王机械', role: '机械员', section: '二工区' }
const 张质检: Operator = { name: '张质检', role: '质检员', section: '一工区' }
const 管理员: Operator = { name: '值班管理员', role: '值班管理员', section: '一工区' }

class MemoryBackend implements StorageBackend {
  raw: string | null
  failWrites = 0
  nullReads = 0
  corruptReads = false
  /** 写入后立刻把盘上内容改回旧账，模拟提交成功但读回对不上（极端竞态）。 */
  tamperAfterWrite = false

  constructor(seed = true) {
    this.raw = seed ? JSON.stringify({ ...structuredClone(SEED_ROWS) }) : null
  }
  read() {
    if (this.nullReads > 0) {
      this.nullReads -= 1
      return null
    }
    if (this.corruptReads) {
      return '{坏数据'
    }
    return this.raw
  }
  write(value: string) {
    if (this.failWrites > 0) {
      this.failWrites -= 1
      throw new Error('配额已满，模拟存不下')
    }
    this.raw = value
    if (this.tamperAfterWrite) {
      const parsed = JSON.parse(value)
      parsed.cutter = parsed.cutter.map((row: (typeof SEED_ROWS.cutter)[number]) =>
        Number(row.id) === 5 ? { ...row, status: '已更换', 报废日期: '', 报废原因: '' } : row,
      )
      this.raw = JSON.stringify(parsed)
    }
  }
}

function resetStore(seed = true): MemoryBackend {
  const backend = new MemoryBackend(seed)
  useBackend(backend)
  return backend
}

function findCutter(id: number) {
  const row = listCutters().items.find((item) => item.id === id)
  assert(row, `种子里应存在刀具 id=${id}`)
  return row!
}

async function test(
  name: string,
  body: () => Promise<void> | void,
): Promise<void> {
  process.stdout.write(`• ${name}\n`)
  await body()
}

const tests: (() => Promise<void>)[] = []
const it = (name: string, body: () => Promise<void> | void) => {
  tests.push(() => test(name, body))
}

/* 1. 存量迁移：按刀盘位置排序、新口径重判、历史台账保留结论 */
it('存量刀具按刀盘位置重过：新口径入库的刀重判，历史台账结论保留', async () => {
  resetStore()
  await reconcileExistingCutters()
  const items = listCutters().items
  // 排序：1# → 3# → 12# → 18# → 22# …
  assert(items[0].刀盘位置 === '1#', `首把应为 1#，实际 ${items[0].刀盘位置}`)
  assert(items[1].刀盘位置 === '3#', `第二把应为 3#，实际 ${items[1].刀盘位置}`)
  assert(items[2].刀盘位置 === '12#', `第三把应为 12#，实际 ${items[2].刀盘位置}`)
  // 历史台账 id=10：磨损 19 < 正面滚刀上限 20，但保留「待更换」原结论
  const legacy = findCutter(10)
  assert(legacy.status === CUTTER_STATUS.pendingReplace, '历史台账刀不被新口径翻案')
  assert(legacy.磨损判定口径.includes('历史台账'), '历史刀保留历史口径标记')
  // 迁移幂等：再跑一次不动数据
  const before = JSON.stringify(listCutters().items)
  const ranAgain = await reconcileExistingCutters()
  assert(ranAgain === false, '迁移第二次应直接跳过')
  assert(JSON.stringify(listCutters().items) === before, '迁移重放不应改动数据')
})

/* 2. 新口径：正面滚刀 20mm 到限即待更换，未到限即正常 */
it('磨损上限统一按项目部细则：达到上限判待更换', async () => {
  resetStore()
  await reconcileExistingCutters()
  // id=1 中心滚刀磨损 8 < 15 → 正常
  assert(findCutter(1).status === CUTTER_STATUS.normal, '未到限应为正常')
  // id=3 正面滚刀 21 >= 20 → 待更换
  assert(findCutter(3).status === CUTTER_STATUS.pendingReplace, '到限应为待更换')
  // 登记检查再判一次：把 id=1 的磨损改不到限的检查仍给正常（直接调服务，磨损不变）
  const r = await inspectCutters(李机械一工区, [1])
  assert(r.ok, '登记检查应成功')
  assert(findCutter(1).status === CUTTER_STATUS.normal, '检查后仍为正常')
})

/* 3. 越级报废：未走完更换确认，整组拦下并点名缺哪一步 */
it('待更换 / 已更换未确认的刀越级报废，被拦且写明缺步', async () => {
  resetStore()
  await reconcileExistingCutters()
  const before = JSON.stringify(listCutters().items)
  const outcome = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-skip',
    items: [
      { id: 5, scrapDate: '2026-10-06', reason: '磨损到限' }, // 已确认，应能报
      { id: 4, scrapDate: '2026-10-06', reason: '磨损到限' }, // 已更换未确认，缺 1 步
      { id: 2, scrapDate: '2026-10-06', reason: '磨损到限' }, // 待更换，缺 2 步
      { id: 1, scrapDate: '2026-10-06', reason: '磨损到限' }, // 正常，缺 3 步
    ],
  })
  assert(!outcome.ok, '整组应被拒绝')
  if (outcome.ok) {
    throw new Error('unreachable')
  }
  assert(outcome.violations.length === 3, `应有 3 条点名，实际 ${outcome.violations.length}`)
  assert(outcome.violations.some((v) => v.includes('缺 1 步')), '应点名缺更换确认')
  assert(outcome.violations.some((v) => v.includes('缺 2 步')), '应点名缺安排更换+确认')
  assert(outcome.violations.some((v) => v.includes('缺 3 步')), '应点名缺全部三步')
  assert(JSON.stringify(listCutters().items) === before, '拦下后库内一行都不许变')
  assert(findCutter(5).status === CUTTER_STATUS.replaced, '连合规的那把也不许被捎带报废')
})

/* 4. 越权：非机械员、跨工区一律拒绝 */
it('质检员 / 管理员 / 跨工区机械员报废都被拒', async () => {
  resetStore()
  await reconcileExistingCutters()
  const payload: ScrapRequest = {
    operator: 张质检,
    idempotencyKey: 'k-qc',
    items: [{ id: 5, scrapDate: '2026-10-06', reason: '磨损到限' }],
  }
  const qc = await scrapCutters(payload)
  assert(!qc.ok && qc.violations[0].includes('只有机械员'), '质检员应被拒')
  const admin = await scrapCutters({ ...payload, operator: 管理员, idempotencyKey: 'k-ad' })
  assert(!admin.ok && admin.violations[0].includes('值班管理员'), '管理员应被拒')
  const cross = await scrapCutters({ ...payload, operator: 王机械二工区, idempotencyKey: 'k-cross' })
  assert(!cross.ok && cross.violations[0].includes('跨工区'), '跨工区机械员应被拒')
  assert(findCutter(5).status === CUTTER_STATUS.replaced, '越权拒绝后状态不变')
})

/* 5. 正常批量报废：三要素同次写入，环次待换数两处对得上 */
it('本工区机械员批量报废：状态/更换日期/报废日期/原因一次写入并销账', async () => {
  resetStore()
  await reconcileExistingCutters()
  const pendingBeforeR107 = pendingByRing(listCutters().items)['R-107'] ?? 0
  assert(pendingBeforeR107 === 1, `R-107 报前应有 1 把待换（id=3，id=4 已更换不占待换），实际 ${pendingBeforeR107}`)
  const outcome = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-ok',
    items: [
      { id: 5, scrapDate: '2026-10-06', reason: '磨损到限' },
      { id: 6, scrapDate: '2026-10-06', reason: '刀圈崩裂' },
    ],
  })
  assert(outcome.ok, outcome.ok ? '' : outcome.message)
  if (!outcome.ok) {
    throw new Error('unreachable')
  }
  const c5 = findCutter(5)
  const c6 = findCutter(6)
  assert(c5.status === CUTTER_STATUS.scrapped && c6.status === CUTTER_STATUS.scrapped, '两把都应已报废')
  assert(c5.报废日期 === '2026-10-06' && c5.报废原因 === '磨损到限', 'id=5 报废三要素落账')
  assert(c6.报废日期 === '2026-10-06' && c6.报废原因 === '刀圈崩裂', 'id=6 报废三要素落账')
  assert(c5.更换日期 === '2026-10-03', '更换日期保留为更换确认时的值，不被报废覆盖')
  assert(c5.报废申请人 === '李机械', '申请人留痕')
  assert(c5.pending === false && c5.abnormal === false, '报废刀不占待处理/异常')
  // id=5/6 本来是「已更换」，不在 R-107 待换口径；关键核对读回的 pendingByRing
  const afterMap = pendingByRing(listCutters().items)
  assert(
    JSON.stringify(outcome.pendingByRing) === JSON.stringify(afterMap),
    '提交结果里的环次待换数与报废后重读的数必须一致',
  )
  assert((afterMap['R-107'] ?? 0) === 1, 'R-107 待换仍是 id=3 一把（报废的是已更换刀，不影响待换口径）')
})

/* 6. 重复报废只认最早日期 */
it('同一把刀再次报废：只认最早日期，不覆盖', async () => {
  resetStore()
  await reconcileExistingCutters()
  const first = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-first',
    items: [{ id: 5, scrapDate: '2026-10-05', reason: '磨损到限' }],
  })
  assert(first.ok, '首次报废应成功')
  const second = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-second',
    items: [{ id: 5, scrapDate: '2026-10-07', reason: '又报一次' }],
  })
  assert(!second.ok, '已报废刀再次报废应被拒绝')
  const c5 = findCutter(5)
  assert(c5.报废日期 === '2026-10-05', '报废日期必须保留最早的 10-05')
  assert(c5.报废原因 === '磨损到限', '报废原因也不被第二次覆盖')
})

/* 7. 重复提交（连点两回）只认头一回 */
it('同一请求并发点两回：第二回挂头一回的结果，不重复销账', async () => {
  resetStore()
  await reconcileExistingCutters()
  const key = 'k-double'
  const items = [{ id: 6, scrapDate: '2026-10-06', reason: '磨损到限' }]
  const [a, b] = await Promise.all([
    scrapCutters({ operator: 李机械一工区, idempotencyKey: key, items }),
    scrapCutters({ operator: 李机械一工区, idempotencyKey: key, items }),
  ])
  assert(a.ok && b.ok, '两回都应返回成功')
  // 连点两回挂的是同一个 Promise，拿到的就是头一回的落账结果（同一对象）。
  assert(a === b, '并发第二回必须直接返回头一回的 Promise，绝不执行第二遍')
  assert(!a.replayed, '执行的那一回不是重放')
  // 头一回落账后，用同键再串行调一次：从台账重放
  const c = await scrapCutters({ operator: 李机械一工区, idempotencyKey: key, items })
  assert(c.ok && c.replayed && c.message.includes('重复提交'), '串行重复提交应重放最早一次')
  const scrapped = listCutters().items.filter((x) => x.status === CUTTER_STATUS.scrapped)
  assert(scrapped.length === 2, `只有 id=6 新报废 + 种子 id=8，共 2 把，实际 ${scrapped.length}`)
})

/* 8. 存不下：整体撤销，账表不变 */
it('写库失败重试后仍存不下：整组撤销并点名', async () => {
  const backend = resetStore()
  await reconcileExistingCutters()
  backend.failWrites = 99
  const before = backend.raw
  const outcome = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-diskfull',
    items: [{ id: 5, scrapDate: '2026-10-06', reason: '磨损到限' }],
  })
  assert(!outcome.ok, '存不下时应失败')
  assert(outcome.message.includes('撤销'), '应提示已整体撤销')
  assert(findCutter(5).status === CUTTER_STATUS.replaced, '撤销后刀具仍为已更换')
  assert(backend.raw === before, '存储内容与提交前快照完全一致')
})

/* 9. 提交后核对：取不到数据就重试，重试不过整体撤销，且不拿上一版顶账 */
it('提交后连续取不到数据：重试不过就撤销，绝不拿内存上一版顶成功', async () => {
  const backend = resetStore()
  await reconcileExistingCutters()
  const before = backend.raw
  // 写入其实成功落盘，但连续 3 次读回都「取不到」，超过重试次数后必须撤销。
  backend.nullReads = 99
  const outcome = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-noread',
    items: [{ id: 5, scrapDate: '2026-10-06', reason: '磨损到限' }],
  })
  assert(!outcome.ok, '读不到数据时应失败')
  assert(outcome.message.includes('取不到数据') || outcome.message.includes('撤销'), '应说明取不到并撤销')
  backend.nullReads = 0
  useBackend(backend)
  assert(findCutter(5).status === CUTTER_STATUS.replaced, '撤销后重读，刀具仍是原状态')
  assert(backend.raw === before, '盘上内容与提交前一致，报废没有半截落账')
})

/* 9b. 读回内容与提交不一致（被别的通道改写）：同样撤销 */
it('提交后读回与提交不一致：重试后撤销', async () => {
  const backend = resetStore()
  await reconcileExistingCutters()
  const before = backend.raw
  backend.corruptReads = true
  const outcome = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-corrupt',
    items: [{ id: 5, scrapDate: '2026-10-06', reason: '磨损到限' }],
  })
  assert(!outcome.ok, '读回损坏导致不一致时应失败')
  assert(outcome.message.includes('撤销'), '应撤销')
  backend.corruptReads = false
  useBackend(backend)
  assert(findCutter(5).status === CUTTER_STATUS.replaced, '故障恢复后库里仍是原账')
  assert(backend.raw === before, '盘上内容与提交前一致')
})

/* 10. 报废原因/日期缺失，不触盘 */
it('报废原因或日期缺失：整组拒，不写库', async () => {
  resetStore()
  await reconcileExistingCutters()
  const before = JSON.stringify(listCutters().items)
  const noReason = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-noreason',
    items: [{ id: 5, scrapDate: '2026-10-06', reason: '   ' }],
  })
  assert(!noReason.ok && noReason.violations.some((v) => v.includes('报废原因为空')), '空原因应点名')
  const badDate = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-baddate',
    items: [{ id: 5, scrapDate: '', reason: '磨损到限' }],
  })
  assert(!badDate.ok && badDate.violations.some((v) => v.includes('报废日期')), '坏日期应点名')
  assert(JSON.stringify(listCutters().items) === before, '参数类拒绝不触盘')
})

/* 11. 更换确认必须本工区机械员；确认前不能报废，确认后可以 */
it('更换流程权限：非机械员不能确认，确认后报废闸口才放行', async () => {
  resetStore()
  await reconcileExistingCutters()
  // 先安排 id=2（待更换 → 已更换，未确认）
  const arranged = await arrangeReplacement(张质检, [2])
  assert(arranged.ok, '安排更换不限制岗位')
  const confirmByQc = await confirmReplacement(张质检, [2])
  assert(
    !confirmByQc.ok && (confirmByQc.violations ?? []).some((v) => v.includes('机械员')),
    '质检员不能确认更换',
  )
  const confirmByOther = await confirmReplacement(王机械二工区, [2])
  assert(
    !confirmByOther.ok && (confirmByOther.violations ?? []).some((v) => v.includes('跨工区')),
    '跨工区不能确认',
  )
  const confirmOk = await confirmReplacement(李机械一工区, [2])
  assert(confirmOk.ok, '本工区机械员确认成功')
  const c2 = findCutter(2)
  assert(c2.更换确认人 === '李机械' && Boolean(c2.更换确认日期), '确认人/日期落账')
  const scrap = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-flow',
    items: [{ id: 2, scrapDate: '2026-10-06', reason: '磨损到限' }],
  })
  assert(scrap.ok, '走完确认后报废应放行')
})

/* 12. 环次待换清单就是刀具台账的派生视图，报废销账两边同步 */
it('两处待换数同源：环次页统计与刀具页统计永远相等', async () => {
  resetStore()
  await reconcileExistingCutters()
  const initial = pendingByRing(listCutters().items)
  // 把 R-107 的 id=3 走完更换+确认+报废，待换数应从 2 降到 1（剩 id=4 未确认）
  await arrangeReplacement(李机械一工区, [3])
  await confirmReplacement(李机械一工区, [3])
  const result = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-ring-sync',
    items: [{ id: 3, scrapDate: '2026-10-06', reason: '磨损到限' }],
  })
  assert(result.ok, 'id=3 报废成功')
  const after = pendingByRing(listCutters().items)
  assert((initial['R-107'] ?? 0) === 1 && (after['R-107'] ?? 0) === 0, `R-107 待换应 1 → 0，实际 ${after['R-107']}`)
  assert(JSON.stringify(result.ok ? result.pendingByRing : {}) === JSON.stringify(after), '返回值与重读同源')
})

/* 15. 历史版本缓存（旧 schema、无 __meta__）：迁移兜底，不崩、按新账重过 */
it('老版本浏览器缓存（无元数据、旧刀具字段）也能平滑迁到新台账', async () => {
  const backend = new MemoryBackend(false)
  // 模拟上线前用户本地已有的旧账：没有工区/环号/确认字段，元数据键也不存在。
  backend.raw = JSON.stringify({
    cutter: [
      {
        id: 1,
        status: '待更换',
        pending: true,
        abnormal: false,
        刀具编号: 'CUTT-OLD-1',
        刀盘位置: '9#',
        刀具类型: '中心滚刀',
        初始直径: '432',
        当前磨损量: '6',
        更换日期: '',
        检查人员: '老周',
        刀具状态: '旧字段',
      },
    ],
  })
  useBackend(backend)
  const ran = await reconcileExistingCutters()
  assert(ran, '老缓存应触发一次迁移')
  const items = listCutters().items
  assert(items.length === 1, '老缓存刀具保留，不应被种子覆盖')
  const only = items[0]
  // 磨损 6 < 中心滚刀 15，按新口径纠回正常；缺工区字段为空串。
  assert(only.status === CUTTER_STATUS.normal, `新口径应纠为正常，实际 ${only.status}`)
  assert(only.所属工区 === '', '缺工区不崩，留空待补')
  assert(only.磨损判定口径.includes('v2026.03'), '打上现行口径标记')
  // 无工区的刀，机械员报废应被「跨工区/工区不符」拦下，而不是放行。
  const outcome = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-oldauth',
    items: [{ id: 1, scrapDate: '2026-10-06', reason: '磨损到限' }],
  })
  assert(!outcome.ok, '工区不全的历史刀不许直接报废')
})

/* 16. 通用入口已对刀具上锁 */
it('刀具写操作不能再走通用 runAction 那条老路', async () => {
  resetStore()
  await reconcileExistingCutters()
  const { runAction } = await import('../src/api/local-service')
  const blocked = runAction('cutter', 5, '报废刀具')
  assert(!blocked.ok && blocked.message.includes('统一入口'), '老路必须被拒')
})

/* 14. commit 成功但业务核对读回对不上：按同一口径整组撤销 */
it('写后读回被篡改：业务核对不过，整组撤销不留半账', async () => {
  const backend = resetStore()
  await reconcileExistingCutters()
  const before = JSON.stringify(listCutters().items)
  backend.tamperAfterWrite = true
  const outcome = await scrapCutters({
    operator: 李机械一工区,
    idempotencyKey: 'k-tamper',
    items: [{ id: 5, scrapDate: '2026-10-06', reason: '磨损到限' }],
  })
  assert(!outcome.ok, '业务核对不过应报失败')
  assert(outcome.message.includes('撤销'), '应整组撤销')
  // restoreSnapshot 再写一次也会被篡改，所以磁盘仍不一致；关掉篡改重新挂载后应看到撤销后的原账。
  backend.tamperAfterWrite = false
  useBackend(backend)
  const c5 = findCutter(5)
  assert(c5.status === CUTTER_STATUS.replaced, '恢复后 id=5 仍为已更换')
  assert(JSON.stringify(listCutters().items) === before, '内存账表恢复为提交前')
})

async function main() {
  for (const t of tests) {
    await t()
  }
  process.stdout.write(`\n全部 ${tests.length} 组场景通过 ✅\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
