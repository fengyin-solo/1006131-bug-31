<template>
  <section class="page" data-module="cutter">
    <header class="page-head">
      <div>
        <h2>刀具磨损管理</h2>
        <p class="page-desc">
          按刀盘位置清账：登记检查 → 安排更换 → 更换确认 → 报废。报废只有一个实现，单把与勾选批量同路，
          磨损上限按《{{ policyVersion }}》判定，历史台账保留原结论。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" :disabled="busy" @click="batchInspect">登记检查所选</button>
        <button class="btn" type="button" :disabled="busy" @click="batchArrange">安排更换所选</button>
        <button class="btn" type="button" :disabled="busy" @click="batchConfirm">更换确认所选</button>
        <button class="btn primary" type="button" @click="openScrapDialog()">批量报废所选</button>
        <button class="btn" type="button" @click="exportRows">导出刀具磨损清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">当前身份：{{ identity.name }} · {{ identity.role }} · {{ identity.section }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      <button class="btn ghost" type="button" :disabled="busy" @click="reconcile">按刀盘位置重过存量</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th style="width: 34px"><input type="checkbox" :checked="allChecked" @change="toggleAll" /></th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td><input type="checkbox" :value="row.id" v-model="selected" /></td>
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>
            <span :class="['status-tag', statusClass(row.status)]">{{ row.status }}</span>
            <small v-if="row.status === '已更换' && !row.更换确认人" class="warn-text">（未确认，不可报废）</small>
          </td>
          <td class="row-actions">
            <button class="link" type="button" :disabled="busy" @click="singleInspect(row)">登记检查</button>
            <button class="link" type="button" :disabled="busy" @click="singleArrange(row)">安排更换</button>
            <button class="link" type="button" :disabled="busy" @click="singleConfirm(row)">更换确认</button>
            <button class="link danger" type="button" :disabled="busy" @click="openScrapDialog(row)">报废</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无刀具磨损数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条刀具记录 · 待换刀具合计 {{ totalPending }} 把（与掘进环次页同源同数）</span>
      <span v-if="infoMessage" class="ok-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 批量报废弹窗：报废日期每次打开都重置，不残留上一次的值 -->
    <div v-if="scrapOpen" class="modal-mask" @click.self="closeScrapDialog">
      <div class="modal" role="dialog" aria-modal="true" aria-label="批量报废">
        <h3>批量报废（{{ scrapTargets.length }} 把）</h3>
        <p class="modal-hint">
          每把刀的状态、更换日期、报废日期与报废原因在同一次写入里落账；有一把写不进，整组退回并点名。
          同一把刀重复报废只认最早日期；只有本工区机械员可提交。
        </p>
        <div class="form-row">
          <label>
            <span>报废日期（默认今天，可改）</span>
            <input v-model="scrapDate" type="date" />
          </label>
        </div>
        <table class="data-table modal-table">
          <thead>
            <tr><th>刀盘位置</th><th>刀具编号</th><th>掘进环号</th><th>状态</th><th>更换确认</th><th>报废原因</th></tr>
          </thead>
          <tbody>
            <tr v-for="target in scrapTargets" :key="target.id">
              <td>{{ target.刀盘位置 }}</td>
              <td>{{ target.刀具编号 }}</td>
              <td>{{ target.掘进环号 }}</td>
              <td>{{ target.status }}</td>
              <td>{{ target.更换确认人 ? target.更换确认人 + ' / ' + target.更换确认日期 : '未确认' }}</td>
              <td><input v-model="reasonMap[target.id]" placeholder="如：磨损到限、刀圈崩裂" /></td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn" type="button" :disabled="busy" @click="closeScrapDialog">取消</button>
          <button class="btn primary" type="button" :disabled="busy" @click="submitScrap">
            {{ busy ? '提交中…' : '确认报废整组' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  WEAR_POLICY_VERSION,
  arrangeReplacement,
  confirmReplacement,
  inspectCutters,
  listCutters,
  reconcileExistingCutters,
  scrapCutters,
} from '@/domain/cutter/service'
import type { CutterRecord } from '@/domain/cutter/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('cutter')
const session = useSessionStore()
const identity = computed(() => session.identity)

// 展示列从模块元数据里取，但「数据来源」放在状态旁说明，不占主表宽度。
const columns = [
  '刀具编号', '刀盘位置', '刀具类型', '初始直径', '当前磨损量',
  '掘进环号', '所属工区', '更换日期', '更换确认人', '更换确认日期',
  '报废日期', '报废原因', '磨损判定口径', '检查人员',
]
const filterFields = ['刀具编号', '刀盘位置', '掘进环号']
const statuses = ['正常', '待更换', '已更换', '已报废']
const policyVersion = WEAR_POLICY_VERSION

const rows = ref<CutterRecord[]>([])
const total = ref(0)
const selected = ref<number[]>([])
const busy = ref(false)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})

const stats = computed(() => [
  { label: '正常刀具', value: countByStatus('正常') },
  { label: '待更换刀具', value: countByStatus('待更换') },
  { label: '已更换未确认', value: rows.value.filter((r) => r.status === '已更换' && !r.更换确认人).length },
  { label: '累计报废数', value: countByStatus('已报废') },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: countByStatus(status) })),
)
const totalPending = computed(() => countByStatus('待更换'))
const allChecked = computed(() => rows.value.length > 0 && rows.value.every((row) => selected.value.includes(row.id)))

function countByStatus(status: string): number {
  return rows.value.filter((row) => row.status === status).length
}

function statusClass(status: string): string {
  return {
    正常: 'tag-normal',
    待更换: 'tag-warn',
    已更换: 'tag-info',
    已报废: 'tag-dead',
  }[status] ?? ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selected.value = checked ? rows.value.map((row) => row.id) : []
}

function selectedOr(row: CutterRecord | null): number[] {
  if (row) {
    return [row.id]
  }
  return [...selected.value]
}

async function runGuarded(
  action: () => Promise<{ ok: boolean; message: string; violations?: string[] }>,
  successReload = true,
) {
  errorMessage.value = ''
  infoMessage.value = ''
  busy.value = true
  try {
    const result = await action()
    if (!result.ok) {
      errorMessage.value = result.violations?.length
        ? `${result.message} ① ${result.violations.join('；② ')}`
        : result.message
      return
    }
    infoMessage.value = result.message
    if (successReload) {
      reload()
    }
  } finally {
    busy.value = false
  }
}

function singleInspect(row: CutterRecord) {
  return runGuarded(() => inspectCutters(identity.value, [row.id]))
}
function singleArrange(row: CutterRecord) {
  return runGuarded(() => arrangeReplacement(identity.value, [row.id]))
}
function singleConfirm(row: CutterRecord) {
  return runGuarded(() => confirmReplacement(identity.value, [row.id]))
}
function batchInspect() {
  return runGuarded(() => inspectCutters(identity.value, selected.value))
}
function batchArrange() {
  return runGuarded(() => arrangeReplacement(identity.value, selected.value))
}
function batchConfirm() {
  return runGuarded(() => confirmReplacement(identity.value, selected.value))
}
function reconcile() {
  return runGuarded(async () => {
    await reconcileExistingCutters()
    return { ok: true, message: '存量刀具已按刀盘位置重过一遍并统一口径' }
  })
}

/* ---------------- 报废弹窗（单把与批量共用） ---------------- */

const scrapOpen = ref(false)
const scrapDate = ref('')
const scrapReasons = ref<Record<number, string>>({})
const scrapIds = ref<number[]>([])
// 每次弹窗生成一个新的幂等键；同一次提交连点两回只认头一回。
let scrapKey = ''

const scrapTargets = computed(() =>
  scrapIds.value
    .map((id) => rows.value.find((row) => row.id === id))
    .filter((row): row is CutterRecord => Boolean(row)),
)
const reasonMap = scrapReasons

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function openScrapDialog(row?: CutterRecord) {
  const ids = row ? [row.id] : [...selected.value]
  if (ids.length === 0) {
    errorMessage.value = '请先勾选要报废的刀具，或在某一行点「报废」'
    return
  }
  errorMessage.value = ''
  infoMessage.value = ''
  scrapIds.value = ids
  scrapReasons.value = {}
  // 关键：报废日期不残留上一次，每次打开重新给今天。
  scrapDate.value = todayText()
  scrapKey = `scrap-${Date.now()}-${ids.join('_')}`
  scrapOpen.value = true
}

function closeScrapDialog() {
  scrapOpen.value = false
  scrapIds.value = []
  scrapReasons.value = {}
  scrapDate.value = ''
}

async function submitScrap() {
  const items = scrapTargets.value.map((target) => ({
    id: target.id,
    scrapDate: scrapDate.value,
    reason: (scrapReasons.value[target.id] ?? '').trim(),
  }))
  await runGuarded(
    () =>
      scrapCutters({
        operator: identity.value,
        items,
        idempotencyKey: scrapKey,
      }).then((outcome) => {
        if (!outcome.ok) {
          return { ok: false, message: outcome.message, violations: outcome.violations }
        }
        // 提交后按服务读回的明细核对一遍，并用读回的环次待换数校验两处一致。
        const perRing = Object.entries(outcome.pendingByRing)
          .map(([ring, count]) => `${ring}:${count}`)
          .join('，')
        const readback = outcome.items
          .map((item) => `${item.position}/${item.code} 报废日期 ${item.scrapDate}`)
          .join('；')
        return {
          ok: true,
          message: `${outcome.message} 读回核对：${readback}。各环待换数 [${perRing || '无'}]${
            outcome.replayed ? '（重复提交，按最早一次）' : ''
          }`,
        }
      }),
  )
  if (!errorMessage.value) {
    closeScrapDialog()
  }
}

function reload() {
  errorMessage.value = ''
  try {
    // 取不到数据时 service 会保留旧缓存并在写入路径重试；这里只读已落账的数据。
    const payload = listCutters(filters.value)
    rows.value = payload.items
    total.value = payload.total
    selected.value = selected.value.filter((id) => rows.value.some((row) => row.id === id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '刀具列表读取失败'
  }
}

onMounted(async () => {
  // 存量刀具按刀盘位置重新过一遍（迁移只跑一次，老缓存也会补上）。
  await reconcileExistingCutters()
  reload()
})
</script>
