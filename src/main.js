/**
 * Standalone entry: mounts the app shell. Library consumers import `./index.js`
 * instead — nothing here is part of the published surface.
 */
import { createApp } from 'vue'

import AppShell from './AppShell.vue'
import './styles/viewer.css'

createApp(AppShell).mount('#app')
