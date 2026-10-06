<template>
  <section class="page" data-module="cutter">
    <header class="page-head">
      <div>
        <h2>刀具磨损管理</h2>
        <p class="page-desc">维护刀具，围绕刀具编号、刀盘位置、刀具类型、初始直径做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记刀具</button>
        <button class="btn" type="button" @click="exportRows">导出刀具磨损清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="panel" data-panel="scrap">
      <h3 class="panel-title">批量报废（按刀盘位置清账）</h3>
      <p class="panel-desc">
        报废只走这一段逻辑：勾选、单把报废与其他入口同库同规则；有一把写不进去整组退回。
        操作人：{{ session.operator }}（{{ session.role }} · {{ session.workArea }}）
        <span v-if="!session.canScrapCutter" class="error-text">当前角色不是机械员，提交会被拒绝</span>
      </p>
      <div class="scrap-controls">
        <label class="filter-item">
          <span>刀盘位置</span>
          <select v-model="scrapPosition">
            <option value="">全部位置</option>
            <option v-for="position in positions" :key="position" :value="position">{{ position }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>报废日期</span>
          <input v-model="scrapForm.date" type="date" />
        </label>
        <label class="filter-item scrap-reason">
          <span>报废原因</span>
          <input v-model="scrapForm.reason" placeholder="如：磨损超限，无法修复" />
        </label>
        <button class="btn primary" type="button" :disabled="submitting" @click="submitScrap">
          {{ submitting ? '提交中…' : `提交批量报废（已选 ${scrapSelection.length} 把）` }}
        </button>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>勾选</th>
            <th>刀具编号</th>
            <th>刀盘位置</th>
            <th>当前状态</th>
            <th>当前磨损量</th>
            <th>超限（上限 {{ wearLimit }}mm）</th>
            <th>提交前提示</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="cutter in scrapCandidates" :key="Number(cutter.id)">
            <td>
              <input v-model="scrapSelection" type="checkbox" :value="Number(cutter.id)" />
            </td>
            <td>{{ cutter['刀具编号'] }}</td>
            <td>{{ cutter['刀盘位置'] }}</td>
            <td>{{ cutter.status }}</td>
            <td>{{ cutter['当前磨损量'] ?? '—' }}</td>
            <td>
              <span v-if="isOverLimit(cutter) && cutter.status !== '已报废'" class="tag warn">超限</span>
              <span v-else>—</span>
            </td>
            <td>{{ scrapHint(cutter) }}</td>
          </tr>
          <tr v-if="!scrapCandidates.length">
            <td colspan="7" class="empty-state">该刀盘位置下暂无刀具</td>
          </tr>
        </tbody>
      </table>
      <p v-if="scrapMessage" class="scrap-result" :class="{ 'error-text': scrapFailed }">{{ scrapMessage }}</p>
    </section>

    <section class="panel" data-panel="recon">
      <h3 class="panel-title">
        存量复核（按刀盘位置）
        <button class="link" type="button" @click="reloadWithRetry()">重新过一遍</button>
      </h3>
      <p class="panel-desc" :class="{ 'error-text': !pendingCountMatched }">
        台账待更换 {{ pendingCount }} 把 · 掘进中环次待换刀具数 {{ ringPendingCount }} 把
        <template v-if="pendingCountMatched">（两处一致）</template>
        <template v-else>（两处对不上，请重新复核）</template>
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>刀盘位置</th>
            <th>总数</th>
            <th>正常</th>
            <th>待更换</th>
            <th>已更换</th>
            <th>已报废</th>
            <th>超限未报废</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="group in recon" :key="group.position">
            <td>{{ group.position }}</td>
            <td>{{ group.total }}</td>
            <td>{{ group.normal }}</td>
            <td>{{ group.pending }}</td>
            <td>{{ group.replaced }}</td>
            <td>{{ group.scrapped }}</td>
            <td>
              <span v-if="group.overLimitActive" class="tag warn">{{ group.overLimitActive }}</span>
              <span v-else>0</span>
            </td>
          </tr>
          <tr v-if="!recon.length">
            <td colspan="7" class="empty-state">暂无存量刀具</td>
          </tr>
        </tbody>
      </table>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reloadWithRetry()">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无刀具磨损数据，可先登记刀具</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条刀具磨损记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  CUTTER_WEAR_LIMIT_MM,
  isOverLimit,
  reconcileCuttersByPosition,
  scrapCutters,
} from '@/api/cutter-scrap'
import type { PositionRecon } from '@/api/cutter-scrap'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('cutter')
const columns = ["刀具编号", "刀盘位置", "刀具类型", "初始直径", "当前磨损量", "更换日期", "报废日期", "报废原因", "检查人员", "刀具状态"]
const actions = ["登记检查", "安排更换", "报废刀具"]
const statuses = ["正常", "待更换", "已更换", "已报废"]
const wearLimit = CUTTER_WEAR_LIMIT_MM

const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 批量报废面板：候选列表与存量复核都基于全量台账，不受上面筛选条件影响。
const allCutters = ref<EntryRow[]>([])
const recon = ref<PositionRecon[]>([])
const ringPendingCount = ref(0)
const scrapPosition = ref('')
const scrapSelection = ref<number[]>([])
const scrapForm = reactive({ date: todayIso(), reason: '' })
const scrapMessage = ref('')
const scrapFailed = ref(false)
const submitting = ref(false)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: allCutters.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '正常刀具', value: countByStatus('正常') },
  { label: '待更换刀具', value: countByStatus('待更换') },
  { label: '累计报废数', value: countByStatus('已报废') },
])

const pendingCount = computed(() => countByStatus('待更换'))
const pendingCountMatched = computed(() => pendingCount.value === ringPendingCount.value)

const positions = computed(() => recon.value.map((group) => group.position))

const scrapCandidates = computed(() =>
  scrapPosition.value
    ? allCutters.value.filter((row) => String(row['刀盘位置']) === scrapPosition.value)
    : allCutters.value,
)

function countByStatus(status: string): number {
  return allCutters.value.filter((row) => String(row.status) === status).length
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function scrapHint(cutter: EntryRow): string {
  const status = String(cutter.status)
  if (status === '已报废') return '已报废，重复提交只认最早的日期'
  if (status === '待更换') return '更换确认未走完，提交会被拦下'
  if (status === '正常') return '未登记检查，提交会被拦下'
  return '可报废'
}

function resetFilters() {
  filters.value = {}
  reloadWithRetry()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '刀具登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '报废刀具') {
    // 单把报废不另起路子：定位到批量面板，同一段提交逻辑。
    scrapPosition.value = String(row['刀盘位置'] ?? '')
    scrapSelection.value = [Number(row.id)]
    scrapForm.date = todayIso()
    scrapForm.reason = ''
    scrapMessage.value = `已选中 ${row['刀具编号']}，确认报废日期与原因后统一提交`
    scrapFailed.value = false
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reloadWithRetry()
}

// 连着点两回仍按头一回：提交中途直接忽略后续点击。
async function submitScrap() {
  if (submitting.value) {
    return
  }
  submitting.value = true
  scrapMessage.value = ''
  scrapFailed.value = false
  try {
    const outcome = scrapCutters(
      scrapSelection.value,
      { scrapDate: scrapForm.date, reason: scrapForm.reason },
      { name: session.operator, role: session.role, workArea: session.workArea },
    )
    scrapMessage.value = outcome.message
    if (!outcome.ok) {
      scrapFailed.value = true
      return
    }
    // 成功后表单归位，报废日期不残留上一次的值。
    scrapSelection.value = []
    scrapForm.date = todayIso()
    scrapForm.reason = ''
    await reloadWithRetry()
  } finally {
    submitting.value = false
  }
}

// 提交之后返回列表核对一遍：取不到就重试，几次都取不到就保留当前页面数据，
// 不把旧版顶上来；序号守卫保证慢的旧响应覆盖不了新数据。
let loadSeq = 0
async function reloadWithRetry(attempts = 3) {
  const seq = ++loadSeq
  let lastError = '刀具磨损列表读取失败'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const payload = listEntries(meta.key, filters.value)
      if (seq !== loadSeq) {
        return
      }
      rows.value = payload.items
      total.value = payload.total
      allCutters.value = listRows(meta.key)
      recon.value = reconcileCuttersByPosition()
      ringPendingCount.value = listRows('ring')
        .filter((row) => String(row.status) === '掘进中')
        .reduce((sum, row) => sum + Number(row['待换刀具数'] ?? 0), 0)
      errorMessage.value = ''
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError
    }
  }
  if (seq === loadSeq) {
    errorMessage.value = `列表核对失败，已保留当前页面数据，请重新查询：${lastError}`
  }
}

onMounted(reloadWithRetry)
</script>
