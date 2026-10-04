<script setup>
// Bank statement import. Choosing a file only shows a preview: every line can be checked and edited, and
// nothing reaches the books until Add is pressed and confirmed.
import { ref, computed } from 'vue';
import { store, api, loadMeta, toast, money, dollars, accountName, openTransaction } from '../store.js';
import { niceDate, isIsoDate } from '../../../shared/money.js';
import AccountPicker from '../AccountPicker.vue';
import QuickCodePicker from '../QuickCodePicker.vue';

const text = ref('');
const fileName = ref('');
const data = ref(null);
const mapping = ref(null);
const busy = ref(false);
const error = ref(null);
const show = ref('new');
const dragging = ref(false);
const confirming = ref(false);

async function readFile(file) {
  if (!file) return;
  fileName.value = file.name;
  text.value = await file.text();
  mapping.value = null;
  await run();
}
async function run() {
  busy.value = true; error.value = null; confirming.value = false;
  try {
    const d = await api('POST', '/api/bank/preview', { text: text.value, mapping: mapping.value });
    mapping.value = { ...d.mapping };
    if (!d.needs_mapping) {
      for (const l of d.lines) {
        l.bank_date_or_date = l.date;             // the bank's date, kept when the entry's date is edited
        if (l.status !== 'new') continue;
        l.bank_date = l.date;
        l.decision = null;                        // for a possible duplicate: 'same' or 'separate'
        l.include = !l.possible;                  // a possible duplicate is held back until decided
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
function reset() { data.value = null; text.value = ''; fileName.value = ''; mapping.value = null; error.value = null; confirming.value = false; }

const fresh = computed(() => (data.value?.lines || []).filter(l => l.status === 'new'));
const same = computed(() => fresh.value.filter(l => l.decision === 'same'));
const chosen = computed(() => fresh.value.filter(l => l.include && l.decision !== 'same'));
const undecided = computed(() => fresh.value.filter(l => l.possible && !l.decision));
const leftOut = computed(() => fresh.value.filter(l => !l.include && l.decision !== 'same' && !(l.possible && !l.decision)));
const known = code => store.accounts.some(a => a.code === code.trim());
const uncoded = computed(() => chosen.value.filter(l => !known(l.account_code)));
const badDate = computed(() => chosen.value.filter(l => !isIsoDate(l.date)));
const toTick = computed(() => data.value.lines.filter(l => l.status === 'matched').length + same.value.length);
const visible = computed(() => (show.value === 'new' ? fresh.value : data.value.lines));
const sum = (rows, sign) => rows.reduce((s, l) => s + (Math.sign(l.amount_cents) === sign ? Math.abs(l.amount_cents) : 0), 0);

function decide(l, what) {
  l.decision = what;
  l.include = what === 'separate';
}
// Choosing a quick code fills the payee name and the ledger code it normally goes to, as the Access
// Transactions form did (Payee_Name and Auto_Code from quick_codes).
function quickPicked(l, row) {
  l.payee_code = row.code;
  l.payee_name = row.name;
  if (row.account_code) l.account_code = row.account_code;
  l.suggestion.from = 'quick code ' + row.code;
  spread(l);
}
// Coding one line codes the other lines from the same payee that have no code yet.
function spread(l) {
  for (const o of fresh.value) if (o !== l && !o.account_code && o.description === l.description) { o.account_code = l.account_code; o.payee_name = l.payee_name; o.payee_code = l.payee_code; }
}
// The books' balance after each statement line, as it will be with the lines ticked now. Where everything is
// in order it equals the bank's balance on that line; the first line where they part is where to look.
const hasBankBalance = computed(() => (data.value?.lines || []).some(l => l.balance_cents !== null));
const running = computed(() => {
  const d = data.value;
  const out = new Map();
  if (!d?.running) return out;
  let base = d.running.base_cents;
  const claimed = new Set();
  for (const l of d.lines) if (l.decision === 'same') { claimed.add(l.possible.id); if (l.possible.date < d.from) base -= (l.possible.type === 'R' ? 1 : -1) * l.possible.amount_cents; }
  const others = d.running.others.filter(o => !claimed.has(o.id));
  let cum = 0;
  for (const l of d.lines) {
    const counts = l.status !== 'new' || l.decision === 'same' || (l.include && l.decision !== 'same');
    if (counts) cum += l.amount_cents;
    const books = base + cum + others.reduce((s, o) => s + (o.date <= l.bank_date_or_date ? o.signed_cents : 0), 0);
    out.set(l.fp, { books, differs: l.balance_cents !== null && l.balance_cents !== books });
  }
  return out;
});
function tickAll(on) { for (const l of fresh.value) if (!l.possible) l.include = on; }

// What the books will read at the statement's closing date once the ticked lines are added.
const closing = computed(() => {
  const c = data.value?.closing;
  if (!c) return null;
  const after = c.book_cents + chosen.value.reduce((s, l) => s + l.amount_cents, 0);
  return { ...c, after, diff: after - c.balance_cents };
});

function review() {
  error.value = null;
  if (uncoded.value.length) { error.value = `${uncoded.value.length} ticked ${uncoded.value.length === 1 ? 'line needs' : 'lines need'} a ledger code.`; return; }
  if (badDate.value.length) { error.value = 'A ticked line has no date.'; return; }
  confirming.value = true;
}
async function importNow() {
  busy.value = true; error.value = null;
  try {
    const d = data.value;
    const r = await api('POST', '/api/bank/import', {
      add: chosen.value.map(l => ({ n: l.n, fp: l.fp, date: l.date, bank_date: l.bank_date, amount_cents: l.amount_cents, description: l.description, payee_name: l.payee_name.trim(), payee_code: l.payee_code, account_code: l.account_code.trim(), allow_duplicate: l.decision === 'separate' })),
      matched: d.lines.filter(l => l.status === 'matched').map(l => ({ fp: l.fp, transaction_id: l.transaction.id })).concat(same.value.map(l => ({ fp: l.fp, transaction_id: l.possible.id }))),
      checkpoint: d.closing ? { date: d.closing.date, balance_cents: d.closing.balance_cents } : null
    });
    toast(`Added ${r.added} ${r.added === 1 ? 'entry' : 'entries'}; ${r.ticked} already in the books ticked off`);
    await loadMeta();
    await run();
  } catch (e) { error.value = e.message; confirming.value = false; }
  busy.value = false;
}
const roles = [['date', 'Date'], ['amount', 'Amount (payments negative)'], ['debit', 'Money out'], ['credit', 'Money in'], ['payee', 'Payee / description'], ['balance', 'Balance']];
</script>

<template>
  <div class="head"><h1>Bank statement import</h1><span class="grow"></span><button v-if="data" @click="reset">Choose another file</button></div>

  <label v-if="!data" class="card drop" :class="{ over: dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="dragging = false; readFile($event.dataTransfer.files[0])">
    <input type="file" accept=".csv,text/csv,text/plain" @change="readFile($event.target.files[0])" />
    <b>Choose the CSV file from internet banking</b>
    <span class="muted">or drop it here. You get a preview to check and edit first; nothing is added until you say so. Overlapping an earlier import is fine: nothing already in the books is added again.</span>
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
    <p v-if="data.counts.fresh || data.counts.matched" class="banner info"><b>Preview.</b> Nothing has been added to the books yet. Check the new lines, change the payee, ledger code or date where needed, untick any you do not want, then press Add.</p>
    <div class="tiles">
      <div class="card tile"><small>{{ fileName }}</small><b>{{ data.counts.total }} lines</b><small>{{ niceDate(data.from) }} to {{ niceDate(data.to) }}</small></div>
      <div class="card tile"><small>Already in the books</small><b>{{ data.counts.done + data.counts.matched }}</b><small>{{ data.counts.matched ? data.counts.matched + ' to tick off' : 'all ticked off' }}</small></div>
      <div class="card tile" :class="{ hot: data.counts.fresh }"><small>New, to add</small><b>{{ data.counts.fresh }}</b><small>{{ chosen.length }} ticked</small></div>
      <div v-if="data.counts.possible" class="card tile" :class="{ warn: undecided.length }"><small>Possibly already entered</small><b>{{ data.counts.possible }}</b><small>{{ undecided.length ? undecided.length + ' to decide' : 'all decided' }}</small></div>
      <div class="card tile" :class="{ warn: data.counts.book_only }"><small>In the books, not on the statement</small><b>{{ data.counts.book_only }}</b><small>{{ data.counts.book_only ? 'listed below' : 'none' }}</small></div>
      <div v-if="closing" class="card tile" :class="closing.diff === 0 ? 'good' : 'warn'">
        <small>Statement balance {{ niceDate(closing.date) }}</small><b>{{ dollars(closing.balance_cents) }}</b>
        <small>{{ closing.diff === 0 ? (chosen.length ? 'books will agree once added' : 'books agree') : `books ${chosen.length ? 'will be' : 'are'} ${dollars(Math.abs(closing.diff))} ${closing.diff > 0 ? 'higher' : 'lower'}` }}</small></div>
    </div>
    <p v-if="data.skipped?.length" class="muted">{{ data.skipped.length }} {{ data.skipped.length === 1 ? 'row was' : 'rows were' }} left out (no date or no amount): file {{ data.skipped.length === 1 ? 'row' : 'rows' }} {{ data.skipped.slice(0, 12).join(', ') }}{{ data.skipped.length > 12 ? '…' : '' }}.</p>

    <div class="card flush">
      <div class="bar">
        <div class="seg"><button :class="{ on: show === 'new' }" @click="show = 'new'">New lines ({{ data.counts.fresh }})</button><button :class="{ on: show === 'all' }" @click="show = 'all'">Whole statement</button></div>
        <button v-if="fresh.length" class="small" @click="tickAll(true)">Tick all</button><button v-if="fresh.length" class="small" @click="tickAll(false)">Untick all</button>
        <span class="grow"></span>
        <span v-if="undecided.length" class="pill warn">{{ undecided.length }} to decide</span>
        <span v-if="uncoded.length" class="pill warn">{{ uncoded.length }} need a ledger code</span>
        <button class="primary" :disabled="busy || (!chosen.length && !toTick)" @click="review">
          {{ chosen.length ? `Add ${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'}…` : 'Tick off matched entries…' }}</button>
      </div>
      <div v-if="visible.length" class="fit"><table class="review">
        <thead><tr><th></th><th>Date</th><th>Bank description</th><th class="num">Payment</th><th class="num">Receipt</th><th v-if="hasBankBalance" class="num">Bank bal.</th><th class="num">Books bal.</th><th>Quick code</th><th>Payee in the books</th><th>Ledger code</th></tr></thead>
        <tbody>
          <template v-for="l in visible" :key="l.fp">
            <tr :class="{ dim: l.status !== 'new' || !l.include, joined: l.possible }">
              <td class="tick"><input v-if="l.status === 'new' && !l.possible" type="checkbox" v-model="l.include" :aria-label="'Add ' + l.description" /></td>
              <td class="nowrap"><input v-if="l.status === 'new' && l.include" type="date" v-model="l.date" aria-label="Date" /><template v-else>{{ niceDate(l.date) }}</template></td>
              <td class="desc" :title="l.description + ' ' + l.detail">{{ l.description }} <small>{{ l.detail }}</small></td>
              <td class="num">{{ l.amount_cents < 0 ? money(-l.amount_cents) : '' }}</td>
              <td class="num">{{ l.amount_cents > 0 ? money(l.amount_cents) : '' }}</td>
              <td v-if="hasBankBalance" class="num muted">{{ l.balance_cents === null ? '' : money(l.balance_cents) }}</td>
              <td class="num bal" :class="{ off: running.get(l.fp)?.differs }" :title="running.get(l.fp)?.differs ? 'Differs from the bank balance on this line' : ''">{{ money(running.get(l.fp)?.books) }}</td>
              <template v-if="l.status === 'new'">
                <td class="nowrap"><QuickCodePicker :model-value="l.payee_code || ''" :disabled="!l.include" @update:model-value="l.payee_code = $event || null" @pick="quickPicked(l, $event)" /></td>
                <td class="payee"><input v-model="l.payee_name" :disabled="!l.include" @change="spread(l)" aria-label="Payee" />
                  <small :title="l.suggestion.from || ''">{{ l.suggestion.from || 'not seen before — choose a code' }}</small></td>
                <td class="nowrap"><AccountPicker v-model="l.account_code" :disabled="!l.include" :need="l.include && !known(l.account_code)" width="62px" @change="spread(l)" /></td>
              </template>
              <template v-else>
                <td>{{ l.transaction.payee_code }}</td>
                <td class="payee">{{ l.transaction.payee_name }}<small><span class="pill ok">In the books</span> {{ l.transaction.reference }}{{ l.transaction.date !== l.date ? ' · dated ' + niceDate(l.transaction.date) : '' }}</small></td>
                <td class="nowrap">{{ l.transaction.account_code }} <small>{{ accountName(l.transaction.account_code) }}</small></td>
              </template>
            </tr>
            <tr v-if="l.possible" class="ask">
              <td></td>
              <td :colspan="hasBankBalance ? 9 : 8">
                <span class="pill warn">Possibly already entered</span>
                The books have <b>{{ l.possible.reference }}</b> {{ l.possible.payee_name }} for the same amount, dated {{ niceDate(l.possible.date) }}.
                <span class="seg" style="margin-left: 8px"><button :class="{ on: l.decision === 'same' }" @click="decide(l, 'same')">Same entry — don’t add</button><button :class="{ on: l.decision === 'separate' }" @click="decide(l, 'separate')">Separate — add it</button></span>
              </td>
            </tr>
          </template>
        </tbody>
      </table></div>
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

    <div v-if="confirming" class="veil" @click.self="confirming = false">
      <div class="card dialog" role="dialog" aria-modal="true" aria-label="Confirm import">
        <h2>Add these to the books?</h2>
        <table>
          <tbody>
            <tr><td>New entries to add</td><td class="num"><b>{{ chosen.length }}</b></td></tr>
            <tr><td class="in">payments</td><td class="num">{{ money(sum(chosen, -1)) }}</td></tr>
            <tr><td class="in">receipts</td><td class="num">{{ money(sum(chosen, 1)) }}</td></tr>
            <tr><td>Entries already in the books to tick off</td><td class="num">{{ toTick }}</td></tr>
            <tr v-if="leftOut.length"><td>Lines unticked (not added)</td><td class="num">{{ leftOut.length }}</td></tr>
            <tr v-if="undecided.length"><td>Possible duplicates not decided (not added)</td><td class="num">{{ undecided.length }}</td></tr>
            <tr v-if="closing"><td>Bank balance in the books at {{ niceDate(closing.date) }} afterwards</td><td class="num">{{ money(closing.after) }}</td></tr>
            <tr v-if="closing"><td>Statement balance</td><td class="num">{{ money(closing.balance_cents) }} <span class="pill" :class="closing.diff === 0 ? 'ok' : 'warn'">{{ closing.diff === 0 ? 'agrees' : 'out by ' + money(Math.abs(closing.diff)) }}</span></td></tr>
          </tbody>
        </table>
        <div class="row" style="justify-content: flex-end; margin-top: 14px">
          <button @click="confirming = false">Back to the preview</button>
          <button class="primary" :disabled="busy" @click="importNow">{{ chosen.length ? `Add ${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'}` : 'Tick off' }}</button>
        </div>
      </div>
    </div>
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
tr.joined td { border-bottom: 0; }
tr.ask td { background: var(--amber-soft); padding-top: 8px; padding-bottom: 8px; }
.nowrap { white-space: nowrap; }
td input { padding: 4px 7px; }
td.off { color: var(--amber); font-weight: 650; }
/* The review table is kept narrow enough to show every column, balances included, without scrolling
   sideways on a laptop screen; if the window is narrower still, it scrolls rather than hiding columns. */
.fit { overflow-x: auto; }
.review { font-size: 12.5px; }
.review th, .review td { padding: 4px 6px; }
/* Every cell's first line is one 26px band - the height of the boxes - so dates, amounts, balances, boxes and
   tick boxes sit on the same line across the row. Notes under the payee box hang below that band. */
.review td { vertical-align: top; line-height: 26px; }
.review td small { line-height: inherit; }
.review input:not([type="checkbox"]) { height: 26px; padding: 0 6px; line-height: normal; vertical-align: top; }
.review input[type="checkbox"] { width: 15px; height: 15px; margin: 0; vertical-align: middle; position: relative; top: -2px; }
.review :deep(.picker) { height: 26px; vertical-align: top; }
.review :deep(.picker-name) { line-height: 26px; }
.review .pill { line-height: 1.5; }
.review td.payee .pill { line-height: 14px; font-size: 11px; padding: 0 6px; }
.review td.tick { width: 22px; padding-right: 0; }
.review td.desc { max-width: 165px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review td.payee { min-width: 125px; max-width: 175px; }
.review :deep(.picker-name) { max-width: 112px; }
.review :deep(.picker) { gap: 5px; }
.review td.payee input { width: 100%; display: block; }
.review td.payee small { display: block; line-height: 15px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review td.bal { font-weight: 600; }
.review input { font-size: 12.5px; }
.review input[type="date"] { width: 106px; }
.review .seg button { padding: 3px 9px; }
.veil { position: fixed; inset: 0; background: rgba(10, 20, 25, .55); display: grid; place-items: center; z-index: 30; padding: 16px; }
.dialog { width: min(520px, 100%); margin: 0; box-shadow: 0 20px 60px rgba(0, 0, 0, .35); }
.dialog td.in { padding-left: 28px; color: var(--muted); }
</style>
