// 报废逻辑冒烟测试：esbuild 打包后跑在 node 里，localStorage 用内存桩。
import { execSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'

const dir = mkdtempSync(join(tmpdir(), 'scrap-test-'))
const entry = join(dir, 'entry.ts')
const bundle = join(dir, 'bundle.mjs')

writeFileSync(entry, `
import { scrapCutters, reconcileCuttersByPosition, parseWearMm } from '@/api/cutter-scrap'
import { runAction, listEntries } from '@/api/local-service'
import { listRows, resetRows, saveModules } from '@/data/local-store'

const mech = { name: '王工', role: '机械员', workArea: '一工区' }
const boss = { name: '张队', role: '值班管理员', workArea: '一工区' }
let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log('ok  - ' + name)
  else { failures += 1; console.log('FAIL- ' + name + (extra ? ' :: ' + extra : '')) }
}
const cutter = (id: number) => listRows('cutter').find((r) => Number(r.id) === id)!
const ringPending = () => listRows('ring').filter((r) => String(r.status) === '掘进中')
  .reduce((s, r) => s + Number(r['待换刀具数'] ?? 0), 0)

// 1. 越权：非机械员一律拒绝
resetRows('cutter'); resetRows('ring')
let r = scrapCutters([3, 4], { scrapDate: '2026-10-06', reason: '磨损超限' }, boss)
check('非机械员报废被拒', !r.ok && r.message.includes('机械员') && r.message.includes('值班管理员'))
check('越权后台账未动', String(cutter(3).status) === '已更换')

// 2. 越级：待更换/正常没走完更换确认，整组退回并点名
r = scrapCutters([2, 3], { scrapDate: '2026-10-06', reason: '磨损超限' }, mech)
check('待更换刀具越级报废整组退回', !r.ok && r.message.includes('CUTT-0002') && r.message.includes('安排更换'))
check('越级时同组的已更换刀也没写', String(cutter(3).status) === '已更换')
r = scrapCutters([1], { scrapDate: '2026-10-06', reason: 'x' }, mech)
check('正常刀具报废被拦且写清缺步', !r.ok && r.message.includes('登记检查') && r.message.includes('更换确认'))

// 3. 正常批量报废：状态/更换日期/报废原因同一次写入，环次清单同步
r = scrapCutters([3, 4], { scrapDate: '2026-10-06', reason: '磨损超限，无法修复' }, mech)
check('批量报废成功', r.ok && r.scrapped.length === 2, r.message)
check('状态落为已报废', String(cutter(3).status) === '已报废' && String(cutter(4).status) === '已报废')
check('更换日期与报废原因同次落库', cutter(3)['更换日期'] === '2026-10-06' && cutter(3)['报废原因'] === '磨损超限，无法修复' && cutter(3)['报废日期'] === '2026-10-06')
check('环次待换数与台账待更换一致', ringPending() === listRows('cutter').filter((x) => String(x.status) === '待更换').length)

// 4. 重复报废只认最早的日期
r = scrapCutters([3], { scrapDate: '2026-10-08', reason: '重复提交' }, mech)
check('重复报废更晚日期不覆盖', r.ok && r.merged.includes('CUTT-0003') && cutter(3)['报废日期'] === '2026-10-06')
r = scrapCutters([3], { scrapDate: '2026-10-01', reason: '更早的补录' }, mech)
check('更早日期被采用', cutter(3)['报废日期'] === '2026-10-01' && cutter(3)['报废原因'] === '更早的补录')

// 5. 连着点两回（相同提交）仍按头一回
const before = JSON.stringify(listRows('cutter'))
r = scrapCutters([4], { scrapDate: '2026-10-06', reason: '重复点击' }, mech)
check('重复提交不动存量', r.ok && JSON.stringify(listRows('cutter')) === before)

// 6. 空选/缺日期/缺原因当场拦下
check('空勾选被拦', !scrapCutters([], { scrapDate: '2026-10-06', reason: 'x' }, mech).ok)
check('缺报废日期被拦', !scrapCutters([1], { scrapDate: '', reason: 'x' }, mech).ok)
check('缺报废原因被拦', !scrapCutters([1], { scrapDate: '2026-10-06', reason: ' ' }, mech).ok)

// 7. 写不进去就整体撤销
resetRows('cutter'); resetRows('ring')
const realSet = (globalThis as any).window.localStorage.setItem
;(globalThis as any).window.localStorage.setItem = () => { throw new Error('QuotaExceededError') }
r = scrapCutters([3, 4], { scrapDate: '2026-10-06', reason: '超限' }, mech)
;(globalThis as any).window.localStorage.setItem = realSet
check('写库失败整组撤销', !r.ok && r.message.includes('撤销') && String(cutter(3).status) === '已更换' && String(cutter(4).status) === '已更换')

// 8. 其他入口同一段逻辑：runAction 的报废刀具也走统一实现（无会话时按未登记拦下）
r2: {
  const res = runAction('cutter', 3, '报废刀具')
  check('runAction 报废同样被权限拦下', !res.ok && res.message.includes('机械员'))
}
// 9. 登记检查后环次待换清单同步
const res2 = runAction('cutter', 1, '登记检查')
check('登记检查成功', res2.ok && String(cutter(1).status) === '待更换')
check('待换清单两处对得上', ringPending() === listRows('cutter').filter((x) => String(x.status) === '待更换').length)

// 10. 存量按刀盘位置复核 + 历史非数值磨损兼容
resetRows('cutter')
const recon = reconcileCuttersByPosition()
check('按位置分组', recon.some((g) => g.position === '刀盘A区-02' && g.pending === 1 && g.overLimitActive === 1))
check('历史非数值磨损不误报超限', recon.find((g) => g.position === '刀盘B区-03')!.overLimitActive === 0)
check('parseWearMm 解析', parseWearMm('21mm') === 21 && parseWearMm('未测（历史台账）') === null)

// 11. 列表读取（提交后核对用）
check('列表读取正常', listEntries('cutter').total === listRows('cutter').length)

if (failures > 0) { console.error(failures + ' 项未通过'); process.exit(1) }
console.log('全部通过')
`)

buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
  alias: { '@': '/workspace/frontend/src' },
  banner: {
    js: `globalThis.window = { localStorage: { _d: {},
      getItem(k) { return k in this._d ? this._d[k] : null },
      setItem(k, v) { this._d[k] = String(v) },
      removeItem(k) { delete this._d[k] } } }`,
  },
})
execSync(`node ${bundle}`, { stdio: 'inherit' })
