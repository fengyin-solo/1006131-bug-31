<template>
  <section class="page" data-module="ring">
    <header class="page-head">
      <div>
        <h2>掘进环次管理</h2>
        <p class="page-desc">维护掘进环，围绕环号、起始里程、掘进速度、总推力做登记、筛选与状态流转；报废结论同步反映在各环待换刀具清单。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出掘进环次清单</button>
        <button class="btn" type="button" @click="reload">刷新并核对刀具数</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="cutter-panel">
      <h3>各环待换刀具清单（与刀具磨损页同源）</h3>
      <p class="page-desc">
        合计待换 <strong>{{ totalPendingCutters }}</strong> 把；刀具在刀具页走完更换确认再报废后，
        会从对应环的待换口径里销掉，两处数量始终对同一份台账。
      </p>
      <table class="data-table">
        <thead>
          <tr><th>掘进环号</th><th>环次状态</th><th>待换刀具数</th><th>待换刀具位置（编号）</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in pendingRows" :key="row.ring">
            <td>{{ row.ring }}</td>
            <td>{{ row.ringStatus }}</td>
            <td>{{ row.count }}</td>
            <td>{{ row.positions || '—' }}</td>
          </tr>
          <tr v-if="!pendingRows.length">
            <td colspan="4" class="empty-state">当前没有挂账的待换刀具</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="status-legend" style="margin-top: 12px">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
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
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 1" class="empty-state">暂无掘进环次数据，可先登记掘进环</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条掘进环次记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { listCutters, pendingByRing, pendingCuttersOfRing } from '@/domain/cutter/service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('ring')
const columns = ['环号', '起始里程', '掘进速度', '总推力', '刀盘扭矩', '出土方量', '掘进班组', '环次状态']
const statuses = ['待掘进', '掘进中', '已贯通', '已纠偏']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 待换刀具数全部来自刀具领域的同一函数，刀具页统计用的也是它。
const pendingMap = ref<Record<string, number>>({})
const totalPendingCutters = computed(() =>
  Object.values(pendingMap.value).reduce((sum, count) => sum + count, 0),
)

const pendingRows = computed(() => {
  const cutters = listCutters().items
  return Object.keys(pendingMap.value)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map((ring) => {
      const ringRow = rows.value.find((item) => String(item['环号']) === ring)
      const positions = pendingCuttersOfRing(cutters, ring)
        .map((item) => `${item.刀盘位置}(${item.刀具编号})`)
        .join('、')
      return {
        ring,
        ringStatus: ringRow ? String(ringRow.status) : '环次未登记',
        count: pendingMap.value[ring],
        positions,
      }
    })
})

const stats = computed(() => [
  { label: '本月掘进环数', value: rows.value.length },
  { label: '掘进中', value: statusSummary.value.find((s) => s.status === '掘进中')?.count ?? 0 },
  { label: '待换刀具合计', value: totalPendingCutters.value },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 直接读刀具台账重新汇总，避免环次自己再维护一份会漂移的数。
    pendingMap.value = pendingByRing(listCutters().items)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '掘进环次列表读取失败'
  }
}

onMounted(reload)
</script>
