<script setup>
import { onMounted, onBeforeUnmount, computed } from 'vue';
import { store, loadMeta, go, dollars } from './store.js';
import { niceDate } from '../../shared/money.js';
import TransactionsView from './views/TransactionsView.vue';
import BankView from './views/BankView.vue';
import ReportsView from './views/ReportsView.vue';
import ProblemsView from './views/ProblemsView.vue';
import SetupView from './views/SetupView.vue';

const views = [
  { key: 'transactions', label: 'Transactions', icon: 'M4 6h16M4 12h16M4 18h10' },
  { key: 'bank', label: 'Bank import', icon: 'M12 3v12M7 10l5 5 5-5M4 20h16' },
  { key: 'reports', label: 'Reports', icon: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6' },
  { key: 'problems', label: 'Problem finder', icon: 'M11 4a7 7 0 1 0 4.2 12.6L20 21M11 8v3.5M11 14.5v.01' },
  { key: 'setup', label: 'Setup', icon: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 4v6M8 14v6' }
];
const current = computed(() => ({ transactions: TransactionsView, bank: BankView, reports: ReportsView, problems: ProblemsView, setup: SetupView })[store.view]);
const error = computed(() => store.loadError);

// The program behind this window is told the window is still open (and when it closes), so that when the
// accounts are run from the shared folder it can stop and let someone else in. If it has stopped, say so.
let pingTimer = null;
const ping = () => fetch('/api/ping').then(r => { store.stopped = !r.ok; }).catch(() => { store.stopped = true; });
const closing = () => { try { navigator.sendBeacon('/api/closing'); } catch { /* the program will notice the silence instead */ } };

onMounted(async () => {
  const h = location.hash.slice(1);
  if (views.some(v => v.key === h)) store.view = h;
  try { await loadMeta(); } catch (e) { store.loadError = e.message; }
  pingTimer = setInterval(ping, 30000);
  window.addEventListener('pagehide', closing);
});
onBeforeUnmount(() => { clearInterval(pingTimer); window.removeEventListener('pagehide', closing); });
</script>

<template>
  <div class="shell">
    <aside class="side no-print">
      <div class="brand">
        <span class="logo">M</span>
        <div><strong>McKay Accounts</strong><small>{{ store.settings.bank_account }}</small></div>
      </div>
      <div class="balance">
        <small>Bank balance</small>
        <b :class="{ neg: store.balance_cents < 0 }">{{ store.ready ? dollars(store.balance_cents) : '…' }}</b>
        <small v-if="store.last_date">last entry {{ niceDate(store.last_date) }}</small>
      </div>
      <nav>
        <button v-for="v in views" :key="v.key" :class="{ on: store.view === v.key }" @click="go(v.key)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="v.icon" /></svg>
          {{ v.label }}
        </button>
      </nav>
      <small class="foot" v-if="store.settings.locked_to">Locked up to {{ niceDate(store.settings.locked_to) }}</small>
    </aside>
    <main>
      <p v-if="store.stopped" class="banner error" role="alert">The accounts program has stopped, so nothing more can be saved from this window. Close it and open McKay Accounts again from the shortcut. Work on a bank import was saved as you went.</p>
      <p v-if="error" class="banner error">{{ error }}</p>
      <component v-else-if="store.ready" :is="current" />
    </main>
    <div v-if="store.toast" class="toast no-print" :class="store.toast.kind" role="status">
      {{ store.toast.text }}
      <button v-if="store.toast.action" class="link" @click="store.toast.action(); store.toast = null">{{ store.toast.label }}</button>
    </div>
  </div>
</template>
