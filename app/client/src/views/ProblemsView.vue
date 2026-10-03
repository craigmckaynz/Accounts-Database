<script setup>
// The problem finder: check the books against bank statement balances, see which entries most likely
// explain a difference, and sweep for entries that look wrong.
import { ref, reactive, onMounted, computed } from 'vue';
import { store, api, loadMeta, toast, money, dollars, accountName, openTransaction } from '../store.js';
import { toCents, niceDate, addDays } from '../../../shared/money.js';

const data = ref(null);
const busy = ref(false);
const scope = ref('auto');
const cp = reactive({ date: '', balance: '', note: '' });
const cpError = ref(null);

async function load() {
  busy.value = true;
  try {
    const since = scope.value === 'all' ? '1900-01-01' : scope.value === 'year' ? addDays(store.today, -365) : '';
    data.value = await api('GET', '/api/problems' + (since ? '?since=' + since : ''));
  } catch (e) { toast(e.message, { kind: 'error' }); }
  busy.value = false;
}
onMounted(load);

async function addCheckpoint() {
  cpError.value = null;
  const cents = toCents(cp.balance);
  if (cents === null) { cpError.value = 'Enter the closing balance shown on the statement, e.g. 12,450.33 (use a minus sign if overdrawn).'; return; }
  try {
    await api('POST', '/api/checkpoints', { date: cp.date, balance_cents: cents, note: cp.note });
    cp.balance = ''; cp.note = '';
    await load();
  } catch (e) { cpError.value = e.message; }
}
async function removeCheckpoint(c) { await api('DELETE', '/api/checkpoints/' + c.id); await load(); }

async function applyFix(s) {
  try {
    await api('PUT', '/api/transactions/' + s.transaction.id, s.fix);
    toast(`Changed ${s.transaction.reference}`);
    await Promise.all([load(), loadMeta()]);
  } catch (e) { toast(e.message, { kind: 'error' }); }
}
async function removeEntry(t) {
  try {
    const r = await api('DELETE', '/api/transactions/' + t.id);
    toast(`Deleted ${t.reference}`, { label: 'Undo', ms: 10000, action: async () => { await api('POST', '/api/restore/' + r.change_id); await Promise.all([load(), loadMeta()]); } });
    await Promise.all([load(), loadMeta()]);
  } catch (e) { toast(e.message, { kind: 'error' }); }
}
async function restore(ch) {
  try { await api('POST', '/api/restore/' + ch.id); toast('Entry put back'); await Promise.all([load(), loadMeta()]); } catch (e) { toast(e.message, { kind: 'error' }); }
}

const allAgree = computed(() => data.value && data.value.checkpoints.length && data.value.checkpoints.every(c => c.ok));
const fixLabel = s => (s.fix.type ? `Change to ${s.fix.type === 'R' ? 'receipt' : 'payment'}` : `Change amount to ${money(s.fix.amount_cents)}`);
const severityLabel = { error: 'Needs fixing', warn: 'Check', info: 'For information' };
function describeChange(ch) {
  const b = ch.before, a = ch.after;
  if (ch.action === 'delete') return `Deleted ${b.reference}: ${b.payee_name}, ${money(b.amount_cents)}, dated ${niceDate(b.date)}`;
  const parts = [];
  if (b.amount_cents !== a.amount_cents) parts.push(`amount ${money(b.amount_cents)} → ${money(a.amount_cents)}`);
  if (b.date !== a.date) parts.push(`date ${niceDate(b.date)} → ${niceDate(a.date)}`);
  if (b.type !== a.type) parts.push(`type ${b.type === 'P' ? 'payment → receipt' : 'receipt → payment'}`);
  if (b.account_code !== a.account_code) parts.push(`code ${b.account_code} → ${a.account_code}`);
  if (b.payee_name !== a.payee_name) parts.push('payee');
  if (b.reference !== a.reference) parts.push(`reference ${b.reference} → ${a.reference}`);
  return `Edited ${a.reference}: ${parts.join(', ') || 'no figures changed'}`;
}
</script>

<template>
  <div class="head"><h1>Problem finder</h1><span class="grow"></span><button @click="load" :disabled="busy">Check again</button></div>

  <div class="card">
    <h2>Check against a bank statement</h2>
    <p class="muted" style="margin-top: 0">Enter the closing balance from a statement. If the books disagree, the finder searches the entries since the last statement that agreed.</p>
    <form class="row" @submit.prevent="addCheckpoint">
      <label class="field"><span>Statement date</span><input v-model="cp.date" type="date" required /></label>
      <label class="field"><span>Closing balance</span><input v-model="cp.balance" class="num" inputmode="decimal" placeholder="0.00" style="width: 140px" /></label>
      <label class="field" style="flex: 1; min-width: 160px"><span>Note (optional)</span><input v-model="cp.note" placeholder="e.g. statement 214" /></label>
      <button class="primary">Check</button>
    </form>
    <p v-if="cpError" class="banner error" style="margin-top: 10px">{{ cpError }}</p>
  </div>

  <template v-if="data">
    <div v-if="data.first_break" class="card alert">
      <h2>
        The books are {{ dollars(Math.abs(data.first_break.diff_cents)) }} {{ data.first_break.diff_cents > 0 ? 'higher' : 'lower' }} than the bank
        <span class="muted" style="font-weight: 400">— somewhere {{ data.first_break.from ? 'after ' + niceDate(data.first_break.from) + ' and ' : '' }}up to {{ niceDate(data.first_break.to) }} ({{ data.first_break.count }} entries)</span>
      </h2>
      <table v-if="data.first_break.suspects.length">
        <thead><tr><th>Most likely first</th><th>Date</th><th>Payee</th><th class="num">Amount</th><th>Why</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(s, i) in data.first_break.suspects" :key="i">
            <td><b>{{ s.transaction.reference }}</b></td>
            <td>{{ niceDate(s.transaction.date) }}</td>
            <td>{{ s.transaction.payee_name }}</td>
            <td class="num">{{ money(s.transaction.amount_cents) }} <small>{{ s.transaction.type === 'P' ? 'payment' : 'receipt' }}</small></td>
            <td>{{ s.why }}</td>
            <td class="num">
              <button v-if="s.fix" class="small primary" @click="applyFix(s)">{{ fixLabel(s) }}</button>
              <button v-if="s.kind === 'duplicate'" class="small danger" @click="removeEntry(s.transaction)">Delete this one</button>
              <button class="small" @click="openTransaction(s.transaction)">Open</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="banner info">No single entry explains this difference. It is probably an entry missing from the books, or more than one slip. Compare the statement line by line with the running balance on the Transactions screen for this period.</p>
      <p v-if="data.first_break.gaps.length" style="margin-bottom: 0"><b>Reference numbers skipped in this period</b> (an entry may be missing):
        <span v-for="g in data.first_break.gaps" :key="g.month"> {{ g.missing.join(', ') }}</span></p>
      <div v-if="data.first_break.changed.length" style="margin-top: 10px"><b>Entries in this period that were edited or deleted</b>
        <ul><li v-for="ch in data.first_break.changed" :key="ch.id">{{ describeChange(ch) }} <small>({{ new Date(ch.at).toLocaleString('en-NZ') }})</small>
          <button v-if="ch.action === 'delete'" class="link" @click="restore(ch)">Put back</button></li></ul></div>
    </div>
    <p v-else-if="allAgree" class="banner ok">Every statement balance entered agrees with the books.</p>

    <div class="card flush" v-if="data.checkpoints.length">
      <table>
        <thead><tr><th>Statement date</th><th class="num">Statement balance</th><th class="num">Books</th><th class="num">Difference</th><th></th><th>Note</th><th></th></tr></thead>
        <tbody>
          <tr v-for="c in data.checkpoints" :key="c.id">
            <td>{{ niceDate(c.date) }}</td>
            <td class="num">{{ money(c.balance_cents) }}</td>
            <td class="num">{{ money(c.book_cents) }}</td>
            <td class="num" :class="{ neg: !c.ok }">{{ c.ok ? '' : money(c.diff_cents) }}</td>
            <td><span class="pill" :class="c.ok ? 'ok' : 'error'">{{ c.ok ? 'Agrees' : 'Out' }}</span></td>
            <td class="muted">{{ c.note }}</td>
            <td class="num"><button class="small" @click="removeCheckpoint(c)" :aria-label="'Remove statement balance for ' + c.date">Remove</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="head" style="margin-top: 24px">
      <h1 style="font-size: 16px">Checks on the entries</h1>
      <span class="grow"></span>
      <label class="muted">Look at <select v-model="scope" @change="load">
        <option value="auto">entries since the last statement that agreed (or 12 months)</option>
        <option value="year">the last 12 months</option>
        <option value="all">everything</option>
      </select></label>
    </div>
    <p v-if="!data.checks.length" class="banner ok">Nothing found{{ data.sweep_from ? ' since ' + niceDate(data.sweep_from) : '' }}.</p>
    <details v-for="c in data.checks" :key="c.key" class="card" :open="c.severity === 'error'">
      <summary><span class="pill" :class="c.severity">{{ severityLabel[c.severity] }}</span><b>{{ c.title }}</b><span class="muted">{{ c.count }}</span></summary>
      <p class="muted">{{ c.help }}</p>
      <ul v-if="c.gaps"><li v-for="g in c.gaps" :key="g.month">{{ g.missing.join(', ') }}</li></ul>
      <table v-else>
        <thead><tr><th>Reference</th><th>Date</th><th>Payee</th><th>Ledger code</th><th class="num">Amount</th><th class="num">GST</th></tr></thead>
        <tbody>
          <tr v-for="t in c.items" :key="t.id" class="click" tabindex="0" @click="openTransaction(t)" @keydown.enter="openTransaction(t)">
            <td><b>{{ t.reference }}</b></td><td>{{ t.date ? niceDate(t.date) : '— none —' }}</td><td>{{ t.payee_name }}</td>
            <td>{{ t.account_code }} <span class="muted">{{ accountName(t.account_code) }}</span></td>
            <td class="num">{{ money(t.amount_cents) }} <small>{{ t.type === 'P' ? 'payment' : 'receipt' }}</small></td><td class="num">{{ money(t.gst_cents) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="c.items && c.count > c.items.length" class="muted">Showing the first {{ c.items.length }} of {{ c.count }}.</p>
    </details>

    <details v-if="data.recent.length" class="card">
      <summary><b>Recently edited or deleted entries</b><span class="muted">{{ data.recent.length }}</span></summary>
      <ul><li v-for="ch in data.recent" :key="ch.id">{{ describeChange(ch) }} <small>({{ new Date(ch.at).toLocaleString('en-NZ') }})</small>
        <button v-if="ch.action === 'delete'" class="link" @click="restore(ch)">Put back</button></li></ul>
    </details>
  </template>
</template>
