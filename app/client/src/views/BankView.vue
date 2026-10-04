<script setup>
// Bank statement import: choose the CSV from internet banking, see how it lines up with the books,
// give the new lines a ledger code, and add them.
import { ref, computed } from 'vue';
import { store, api, loadMeta, toast, money, dollars, accountName, openTransaction } from '../store.js';
import { niceDate } from '../../../shared/money.js';

const text = ref('');
const fileName = ref('');
const data = ref(null);
const mapping = ref(null);
const busy = ref(false);
const error = ref(null);
const show = ref('new');
const dragging = ref(false);

async function readFile(file) {
  if (!file) return;
  fileName.value = file.name;
  text.value = await file.text();
  mapping.value = null;
  await run();
}
async function run() {
  busy.value = true; error.value = null;
  try {
    const d = await api('POST', '/api/bank/preview', { text: text.value, mapping: mapping.value });
    mapping.value = { ...d.mapping };
    if (!d.needs_mapping) {
      for (const l of d.lines) {
        if (l.status !== 'new') continue;
        l.include = true;
        l.payee_name = l.suggestion.payee_name;
        l.payee_code = l.suggestion.payee_code;
        l.account_code = l.suggestion.account_code || '';
      }
      show.value = d.counts.fresh ? 'new' : 'all';
    }
    data.value = d;
  } catch (e) { error.value = e.message; data.value = null; }
  busy.value = false;
}
function reset() { data.value = null; text.value = ''; fileName.value = ''; mapping.value = null; error.value = null; }

const fresh = computed(() => (data.value?.lines || []).filter(l => l.status === 'new'));
const chosen = computed(() => fresh.value.filter(l => l.include));
const uncoded = computed(() => chosen.value.filter(l => !store.accounts.some(a => a.code === l.account_code.trim())));
const visible = computed(() => (show.value === 'new' ? fresh.value : data.value.lines));

// A quick code typed into the payee box fills the name and ledger code, as on the Transactions screen.
function resolvePayee(l) {
  const p = store.payees.find(x => x.code === l.payee_name.trim().toUpperCase());
  if (p) { l.payee_name = p.name; l.payee_code = p.code; if (p.account_code) l.account_code = p.account_code; }
}
// Giving one line a code gives it to the other lines from the same payee that have none yet.
function spread(l) {
  for (const o of fresh.value) if (o !== l && !o.account_code && o.description === l.description) { o.account_code = l.account_code; o.payee_name = l.payee_name; o.payee_code = l.payee_code; }
}

// What the books will read at the statement's closing date once the ticked lines are added.
const closing = computed(() => {
  const c = data.value?.closing;
  if (!c) return null;
  const after = c.book_cents + chosen.value.reduce((s, l) => s + l.amount_cents, 0);
  return { ...c, after, diff: after - c.balance_cents };
});

async function importNow() {
  if (uncoded.value.length) { error.value = `${uncoded.value.length} ticked ${uncoded.value.length === 1 ? 'line needs' : 'lines need'} a ledger code.`; return; }
  busy.value = true; error.value = null;
  try {
    const d = data.value;
    const r = await api('POST', '/api/bank/import', {
      add: chosen.value.map(l => ({ n: l.n, fp: l.fp, date: l.date, amount_cents: l.amount_cents, description: l.description, payee_name: l.payee_name.trim(), payee_code: l.payee_code, account_code: l.account_code.trim() })),
      matched: d.lines.filter(l => l.status === 'matched').map(l => ({ fp: l.fp, transaction_id: l.transaction.id })),
      checkpoint: d.closing ? { date: d.closing.date, balance_cents: d.closing.balance_cents } : null
    });
    toast(`Added ${r.added} ${r.added === 1 ? 'entry' : 'entries'}; ${r.ticked} already in the books ticked off`);
    await loadMeta();
    await run();
  } catch (e) { error.value = e.message; }
  busy.value = false;
}
const roles = [['date', 'Date'], ['amount', 'Amount (payments negative)'], ['debit', 'Money out'], ['credit', 'Money in'], ['payee', 'Payee / description'], ['balance', 'Balance']];
const statusLabel = { done: 'In the books', matched: 'In the books', new: 'New' };
</script>

<template>
  <div class="head"><h1>Bank statement import</h1><span class="grow"></span><button v-if="data" @click="reset">Choose another file</button></div>

  <label v-if="!data" class="card drop" :class="{ over: dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="dragging = false; readFile($event.dataTransfer.files[0])">
    <input type="file" accept=".csv,text/csv,text/plain" @change="readFile($event.target.files[0])" />
    <b>Choose the CSV file from internet banking</b>
    <span class="muted">or drop it here. Export the account's transactions as CSV for the dates you want; overlapping an earlier import is fine, nothing is added twice.</span>
    <span v-if="busy" class="muted">Reading…</span>
  </label>
  <p v-if="error" class="banner error" role="alert">{{ error }}</p>

  <div v-if="data?.needs_mapping" class="card">
    <h2>Which column is which?</h2>
    <p class="banner info">{{ data.needs_mapping }}</p>
    <div class="row">
      <label v-for="[key, label] in roles" :key="key" class="field"><span>{{ label }}</span>
        <select v-model.number="mapping[key]"><option :value="-1">—</option><option v-for="(c, i) in data.columns" :key="i" :value="i">{{ c || 'Column ' + (i + 1) }}</option></select></label>
      <button class="primary" @click="run">Read the file</button>
    </div>
    <table style="margin-top: 12px"><thead><tr><th v-for="(c, i) in data.columns" :key="i">{{ c }}</th></tr></thead>
      <tbody><tr v-for="(r, i) in data.sample" :key="i"><td v-for="(c, k) in r" :key="k">{{ c }}</td></tr></tbody></table>
  </div>

  <template v-else-if="data">
    <div class="tiles">
      <div class="card tile"><small>{{ fileName }}</small><b>{{ data.counts.total }} lines</b><small>{{ niceDate(data.from) }} to {{ niceDate(data.to) }}</small></div>
      <div class="card tile"><small>Already in the books</small><b>{{ data.counts.done + data.counts.matched }}</b><small>{{ data.counts.matched ? data.counts.matched + ' to tick off' : 'all ticked off' }}</small></div>
      <div class="card tile" :class="{ hot: data.counts.fresh }"><small>New, to add</small><b>{{ data.counts.fresh }}</b><small>{{ chosen.length }} ticked</small></div>
      <div class="card tile" :class="{ warn: data.counts.book_only }"><small>In the books, not on the statement</small><b>{{ data.counts.book_only }}</b><small>{{ data.counts.book_only ? 'listed below' : 'none' }}</small></div>
      <div v-if="closing" class="card tile" :class="closing.diff === 0 ? 'good' : 'warn'">
        <small>Statement balance {{ niceDate(closing.date) }}</small><b>{{ dollars(closing.balance_cents) }}</b>
        <small>{{ closing.diff === 0 ? (chosen.length ? 'books will agree once added' : 'books agree') : `books ${chosen.length ? 'will be' : 'are'} ${dollars(Math.abs(closing.diff))} ${closing.diff > 0 ? 'higher' : 'lower'}` }}</small></div>
    </div>
    <p v-if="data.skipped?.length" class="muted">{{ data.skipped.length }} {{ data.skipped.length === 1 ? 'row was' : 'rows were' }} left out (no date or no amount): file {{ data.skipped.length === 1 ? 'row' : 'rows' }} {{ data.skipped.slice(0, 12).join(', ') }}{{ data.skipped.length > 12 ? '…' : '' }}.</p>

    <div class="card flush">
      <div class="bar">
        <div class="seg"><button :class="{ on: show === 'new' }" @click="show = 'new'">New lines ({{ data.counts.fresh }})</button><button :class="{ on: show === 'all' }" @click="show = 'all'">Whole statement</button></div>
        <span class="grow"></span>
        <span v-if="uncoded.length" class="pill warn">{{ uncoded.length }} need a ledger code</span>
        <button class="primary" :disabled="busy || (!chosen.length && !data.counts.matched)" @click="importNow">
          {{ chosen.length ? `Add ${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'}` : 'Tick off matched entries' }}</button>
      </div>
      <table v-if="visible.length">
        <thead><tr><th></th><th>Date</th><th>Bank description</th><th class="num">Payment</th><th class="num">Receipt</th><th>Payee in the books</th><th>Ledger code</th><th></th></tr></thead>
        <tbody>
          <tr v-for="l in visible" :key="l.fp" :class="{ dim: l.status !== 'new' || !l.include }">
            <td><input v-if="l.status === 'new'" type="checkbox" v-model="l.include" :aria-label="'Add ' + l.description" /></td>
            <td class="nowrap">{{ niceDate(l.date) }}</td>
            <td>{{ l.description }} <small>{{ l.detail }}</small></td>
            <td class="num">{{ l.amount_cents < 0 ? money(-l.amount_cents) : '' }}</td>
            <td class="num">{{ l.amount_cents > 0 ? money(l.amount_cents) : '' }}</td>
            <template v-if="l.status === 'new'">
              <td><input v-model="l.payee_name" list="bank-payees" :disabled="!l.include" style="width: 100%" @change="resolvePayee(l); spread(l)" aria-label="Payee" /></td>
              <td class="nowrap"><input v-model="l.account_code" list="bank-accounts" :disabled="!l.include" style="width: 90px" :class="{ need: l.include && !accountName(l.account_code.trim()) }" @change="spread(l)" aria-label="Ledger code" />
                <small> {{ accountName(l.account_code.trim()) }}</small></td>
              <td><span class="pill info">{{ l.suggestion.from ? 'New · ' + l.suggestion.from : 'New' }}</span></td>
            </template>
            <template v-else>
              <td>{{ l.transaction.payee_name }} <small>{{ l.transaction.reference }}{{ l.transaction.date !== l.date ? ' · dated ' + niceDate(l.transaction.date) : '' }}</small></td>
              <td>{{ l.transaction.account_code }} <small>{{ accountName(l.transaction.account_code) }}</small></td>
              <td><span class="pill ok">{{ statusLabel[l.status] }}</span></td>
            </template>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">Every line of this statement is already in the books.</p>
    </div>

    <div v-if="data.book_only.length" class="card flush">
      <div class="bar"><b>In the books but not on this statement</b><span class="muted">{{ niceDate(data.from) }} to {{ niceDate(data.to) }} — entered twice, wrong amount, wrong date, or not through the bank yet</span></div>
      <table>
        <thead><tr><th>Date</th><th>Reference</th><th>Payee</th><th>Ledger code</th><th class="num">Payment</th><th class="num">Receipt</th></tr></thead>
        <tbody><tr v-for="t in data.book_only" :key="t.id" class="click" tabindex="0" @click="openTransaction(t)" @keydown.enter="openTransaction(t)">
          <td>{{ niceDate(t.date) }}</td><td><b>{{ t.reference }}</b></td><td>{{ t.payee_name }}</td><td>{{ t.account_code }} <small>{{ accountName(t.account_code) }}</small></td>
          <td class="num">{{ t.type === 'P' ? money(t.amount_cents) : '' }}</td><td class="num">{{ t.type === 'R' ? money(t.amount_cents) : '' }}</td></tr></tbody>
      </table>
    </div>
    <datalist id="bank-payees"><option v-for="p in store.payees" :key="p.code" :value="p.code">{{ p.name }}</option></datalist>
    <datalist id="bank-accounts"><option v-for="a in store.accounts.filter(a => a.active)" :key="a.code" :value="a.code">{{ a.description }}{{ a.sub_description ? ' / ' + a.sub_description : '' }}</option></datalist>
  </template>
</template>

<style scoped>
.drop { display: grid; gap: 6px; place-items: center; text-align: center; padding: 44px 20px; border-style: dashed; border-width: 2px; cursor: pointer; }
.drop.over, .drop:hover { border-color: var(--accent); background: var(--accent-soft); }
.drop input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.drop:focus-within { outline: 2px solid var(--accent); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 4px; }
.tile { display: grid; gap: 2px; padding: 12px 14px; }
.tile b { font-size: 20px; font-variant-numeric: tabular-nums; }
.tile.hot { border-color: var(--accent); }
.tile.good { border-color: var(--green); background: var(--green-soft); }
.tile.warn { border-color: var(--amber); background: var(--amber-soft); }
.bar { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.bar .grow { flex: 1; }
tr.dim td { color: var(--muted); }
.nowrap { white-space: nowrap; }
td input { padding: 4px 7px; }
input.need { border-color: var(--amber); box-shadow: 0 0 0 2px var(--amber-soft); }
</style>
