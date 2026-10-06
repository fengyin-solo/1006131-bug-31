import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { reconcileExistingCutters } from './domain/cutter/service'
import './styles/global.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// 存量刀具按刀盘位置重新过一遍：迁移只跑一次，失败不阻塞页面，进刀具页时还会再兜底。
void reconcileExistingCutters()
