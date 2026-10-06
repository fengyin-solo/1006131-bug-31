import { defineStore } from 'pinia'

import type { Operator, OperatorRole } from '@/domain/cutter/types'

// 演示用在岗名册：切换身份即可看到越权被拒、本工区放行的差异。
export const OPERATOR_ROSTER: Operator[] = [
  { name: '李机械', role: '机械员', section: '一工区' },
  { name: '王机械', role: '机械员', section: '二工区' },
  { name: '张质检', role: '质检员', section: '一工区' },
  { name: '值班管理员', role: '值班管理员', section: '一工区' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '李机械',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
    role: '机械员' as OperatorRole,
    section: '一工区',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    /** 领域层要的操作员身份：姓名、岗位、工区三样齐全。 */
    identity(state): Operator {
      return { name: state.operator, role: state.role, section: state.section }
    },
    isMechanic(state): boolean {
      return state.role === '机械员'
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    switchOperator(next: Operator) {
      this.operator = next.name
      this.role = next.role
      this.section = next.section
    },
  },
})
