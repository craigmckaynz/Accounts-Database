<script setup>
// Bank statement import. Choosing a file only shows a preview: every line can be checked and edited, and
// nothing reaches the books until Add is pressed and confirmed.
//
// A new statement line becomes one entry in the books, or several when it is split (one receipt covering
// three invoices, one payment across two ledger codes). Each line therefore carries `parts`: the first is
// the line itself and holds whatever amount the other parts leave.
import { ref, computed } from 'vue';
import { store, api, loadMeta, toast, money, dollars, accountName, openTransaction } from '../store.js';
import { niceDate, isIsoDate, toCents } from '../../../shared/money.js';
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

let partSeq = 0;
// Money going out is numbered automatically (bk26/08-18 ...). Money coming in starts with an empty reference:
// the invoice number goes there. Quick code and ledger code start empty on every part - nothing is guessed.
const newPart = l => ({ key: ++partSeq, amount: '', refMode: l.amount_cents > 0 ? 'manual' : 'auto', ref: '', payee_code: null, payee_name: l.payee_name, account_code: '' });

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
        l.bank_date = l.date;                     // the bank's date, kept when the entry's date is edited
        if (l.status !== 'new') continue;
        l.include = true;
        l.parts = [newPart(l)];
      }
      show.value = d.counts.fresh ? 'new' : 'all';
    }
    data.value = d;
  } catch (e) { error.value = e.message; data.value = null; }
  busy.value = false;
}
function reset() { data.value = null; text.value = ''; fileName.value = ''; mapping.value = null; error.value = null; confirming.value = false; }

const fresh = computed(() => (data.value?.lines || []).filter(l => l.status === 'new'));
const chosen = computed(() => fresh.value.filter(l => l.include));
const leftOut = computed(() => fresh.value.filter(l => !l.include));
const known = code => store.accounts.some(a => a.code === code.trim());
const badDate = computed(() => chosen.value.filter(l => !isIsoDate(l.date)));
const toTick = computed(() => data.value.lines.filter(l => l.status === 'matched').length);
const visible = computed(() => (show.value === 'new' ? fresh.value : data.value.lines));

// ---- parts and their amounts
const idOf = (l, p) => (p === l.parts[0] ? l.fp : `${l.fp}#${p.key}`);
// Positive cents for a part, or null when its amount is not a usable figure. The first part is what is left.
function partCents(l, p) {
  if (p !== l.parts[0]) { const c = toCents(p.amount); return c !== null && c > 0 ? c : null; }
  let rest = Math.abs(l.amount_cents);
  for (const o of l.parts.slice(1)) { const c = toCents(o.amount); if (c === null || c <= 0) return null; rest -= c; }
  return rest > 0 ? rest : null;
}
const splitBad = computed(() => chosen.value.filter(l => l.parts.length > 1 && l.parts.some(p => partCents(l, p) === null)));
function split(l) { l.parts.push(newPart(l)); }
function unsplit(l, p) { l.parts.splice(l.parts.indexOf(p), 1); }
// Every entry that would be added, in the order shown on screen.
const entries = computed(() => chosen.value.flatMap(l => l.parts.map(p => ({ id: idOf(l, p), line: l, part: p }))));
const uncoded = computed(() => entries.value.filter(e => !known(e.part.account_code)));
const total = sign => entries.value.reduce((s, e) => s + (Math.sign(e.line.amount_cents) === sign ? partCents(e.line, e.part) || 0 : 0), 0);

// Choosing a quick code fills the payee name and the ledger code it normally goes to, as the Access
// Transactions form did (Payee_Name and Auto_Code from quick_codes).
function quickPicked(p, row) {
  p.payee_code = row.code;
  p.payee_name = row.name;
  if (row.account_code) p.account_code = row.account_code;
}
// The books' balance after each statement line, as it will be with the lines ticked now. Where everything is
// in order it equals the bank's balance on that line; the first line where they part is where to look.
const hasBankBalance = computed(() => (data.value?.lines || []).some(l => l.balance_cents !== null));
const running = computed(() => {
  const d = data.value;
  const out = new Map();
  if (!d?.running) return out;
  const base = d.running.base_cents;
  const others = d.running.others;
  let cum = 0;
  for (const l of d.lines) {
    const counts = l.status !== 'new' || l.include;
    if (counts) cum += l.amount_cents;
    const books = base + cum + others.reduce((s, o) => s + (o.date <= l.bank_date ? o.signed_cents : 0), 0);
    out.set(l.fp, { books, differs: l.balance_cents !== null && l.balance_cents !== books });
  }
  return out;
});

// ---- references
// Bank references follow the Access form: prefix, year/month of the entry's date, and the next number in that
// month (bk26/08-18, -19 ...), carrying on from the last one in the books. They are worked out down the
// screen, so typing a bank reference over one of them renumbers every automatic one below it from there.
// Anything else typed (an invoice number) is kept as it is and uses up no bank number.
const prefix = computed(() => store.settings.bank_prefix || 'bk');
const bankRef = computed(() => new RegExp('^' + prefix.value + '(\\d\\d)/(\\d\\d)-(\\d+)$', 'i'));
const refs = computed(() => {
  const out = new Map();
  const next = {};
  for (const e of entries.value) {
    const p = e.part;
    if (p.refMode === 'manual') {
      const v = p.ref.trim();
      out.set(e.id, v);
      const m = bankRef.value.exec(v);
      if (m) next[`20${m[1]}-${m[2]}`] = Number(m[3]) + 1;       // the ones below carry on from this
      continue;
    }
    const month = (e.line.date || '').slice(0, 7);
    const start = data.value.next_refs?.[month];
    if (!start) { out.set(e.id, ''); continue; }                 // a month not known here: numbered when added
    const cut = start.lastIndexOf('-') + 1;
    if (!(month in next)) next[month] = Number(start.slice(cut));
    out.set(e.id, start.slice(0, cut) + String(next[month]++).padStart(2, '0'));
  }
  return out;
});
function setReference(l, p, value) {
  const v = value.trim();
  if (v === (refs.value.get(idOf(l, p)) || '') && p.refMode === 'auto') return;
  if (v === '') { p.ref = ''; p.refMode = l.amount_cents > 0 ? 'manual' : 'auto'; }        // back to how it started
  else if (v.toLowerCase() === prefix.value.toLowerCase()) { p.ref = ''; p.refMode = 'auto'; }   // just "bk": the next bank number
  else { p.ref = v; p.refMode = 'manual'; }
}
const clashes = computed(() => { const seen = new Set(), dup = new Set(); for (const r of refs.value.values()) { if (!r) continue; const k = r.toLowerCase(); if (seen.has(k)) dup.add(k); seen.add(k); } return dup; });
const clash = id => clashes.value.has((refs.value.get(id) || '').toLowerCase());
const needRef = computed(() => entries.value.filter(e => e.part.refMode === 'manual' && !e.part.ref.trim()));

// ---- keyboard in the review table
// Up and Down move to the same box on the row above or below (unless a list is open, where they move within
// the list). Ctrl+' copies the value from the same column of the row above, as in Access.
function reviewKey(e) {
  const box = e.target;
  if (!(box instanceof HTMLInputElement) || box.type === 'checkbox') return;
  const cell = box.closest('td[data-col]');
  const row = box.closest('tr[data-fp]');
  if (!cell || !row) return;
  const col = cell.dataset.col;
  const boxIn = tr => tr.querySelector(`td[data-col="${col}"] input:not([disabled])`);

  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (box.getAttribute('aria-expanded') === 'true') return;            // an open list keeps the arrows
    e.preventDefault();
    e.stopPropagation();
    const step = e.key === 'ArrowDown' ? 'nextElementSibling' : 'previousElementSibling';
    for (let tr = row[step]; tr; tr = tr[step]) {
      const next = tr.dataset.fp ? boxIn(tr) : null;
      if (next) { next.focus(); if (next.type !== 'date') next.select(); break; }
    }
    return;
  }
  if ((e.key === "'" || e.code === 'Quote') && (e.ctrlKey || e.metaKey) && !e.altKey) {
    e.preventDefault();
    e.stopPropagation();
    const list = entries.value;
    const at = list.findIndex(x => x.id === row.dataset.fp);
    if (at < 1) return;
    const here = list[at], above = list[at - 1];
    if (col === 'date') here.line.date = above.line.date;
    else if (col === 'amount') here.part.amount = above.part === above.line.parts[0] ? '' : above.part.amount;
    else if (col === 'reference') setReference(here.line, here.part, refs.value.get(above.id) || '');
    else if (col === 'payee_code') {
      const q = store.payees.find(p => p.code === above.part.payee_code);
      if (q) quickPicked(here.part, { code: q.code, name: q.name, account_code: q.account_code || '' }); else here.part.payee_code = null;
    } else here.part[col] = above.part[col];
  }
}
function tickAll(on) { for (const l of fresh.value) l.include = on; }

// What the books will read at the statement's closing date once the ticked lines are added.
const closing = computed(() => {
  const c = data.value?.closing;
  if (!c) return null;
  const after = c.book_cents + chosen.value.reduce((s, l) => s + l.amount_cents, 0);
  return { ...c, after, diff: after - c.balance_cents };
});

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function review() {
  error.value = null;
  if (splitBad.value.length) { const l = splitBad.value[0]; error.value = `The split of ${l.description} (${money(Math.abs(l.amount_cents))}) does not work: each part needs an amount, and together they must come to less than the line, leaving something for the first part.`; return; }
  if (uncoded.value.length) { error.value = `${plural(uncoded.value.length, 'entry needs', 'entries need')} a ledger code.`; return; }
  if (needRef.value.length) { error.value = `${plural(needRef.value.length, 'receipt needs', 'receipts need')} a reference: the invoice number, or type ${prefix.value} for the next bank number.`; return; }
  if (badDate.value.length) { error.value = 'A ticked line has no date.'; return; }
  if (clashes.value.size) { error.value = `Reference ${[...refs.value.values()].find(r => clashes.value.has(r.toLowerCase()))} is on more than one entry.`; return; }
  confirming.value = true;
}
async function importNow() {
  busy.value = true; error.value = null;
  try {
    const d = data.value;
    const r = await api('POST', '/api/bank/import', {
      add: entries.value.map(e => ({
        n: e.line.n, fp: e.id, reference: refs.value.get(e.id) || '', date: e.line.date, bank_date: e.line.bank_date,
        amount_cents: Math.sign(e.line.amount_cents) * partCents(e.line, e.part), line_cents: e.line.amount_cents, description: e.line.description,
        payee_name: e.part.payee_name.trim(), payee_code: e.part.payee_code, account_code: e.part.account_code.trim(),
        // The line itself was checked against the books as a whole; its parts are not each checked again.
        allow_duplicate: e.line.parts.length > 1
      })),
      matched: d.lines.filter(l => l.status === 'matched').map(l => ({ fp: l.fp, transaction_id: l.transaction.id })),
      checkpoint: d.closing ? { date: d.closing.date, balance_cents: d.closing.balance_cents } : null
    });
    toast(`Added ${plural(r.added, 'entry', 'entries')}; ${r.ticked} already in the books ticked off`);
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
    <p v-if="data.counts.fresh || data.counts.matched" class="banner info"><b>Preview.</b> Nothing has been added to the books yet. Give each new line its quick code or ledger code (none are filled in for you) and each receipt its invoice number as the reference; split a line that covers more than one thing; untick any you do not want; then press Add.</p>
    <div class="tiles">
      <div class="card tile"><small>{{ fileName }}</small><b>{{ data.counts.total }} lines</b><small>{{ niceDate(data.from) }} to {{ niceDate(data.to) }}</small></div>
      <div class="card tile"><small>Already in the books</small><b>{{ data.counts.done + data.counts.matched }}</b><small>{{ data.counts.matched ? data.counts.matched + ' to tick off' : 'all ticked off' }}</small></div>
      <div class="card tile" :class="{ hot: data.counts.fresh }"><small>New, to add</small><b>{{ data.counts.fresh }}</b><small>{{ chosen.length }} ticked{{ entries.length > chosen.length ? ', ' + entries.length + ' entries' : '' }}</small></div>
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
        <span v-if="fresh.length" class="muted keys"><kbd>↑</kbd> <kbd>↓</kbd> move between lines · <kbd>Ctrl</kbd>+<kbd>'</kbd> copies the value above · <kbd>F4</kbd> opens a list</span>
        <span class="grow"></span>
        <span v-if="needRef.length" class="pill warn">{{ needRef.length }} need a reference</span>
        <span v-if="uncoded.length" class="pill warn">{{ uncoded.length }} need a ledger code</span>
        <button class="primary" :disabled="busy || (!entries.length && !toTick)" @click="review">
          {{ entries.length ? `Add ${plural(entries.length, 'entry', 'entries')}…` : 'Tick off matched entries…' }}</button>
      </div>
      <div v-if="visible.length" class="fit"><table class="review" @keydown.capture="reviewKey">
        <thead><tr><th></th><th>Date</th><th>Reference</th><th>Bank description</th><th class="num">Payment</th><th class="num">Receipt</th><th v-if="hasBankBalance" class="num">Bank bal.</th><th class="num">Books bal.</th><th>Quick code</th><th>Payee in the books</th><th>Ledger code</th><th></th></tr></thead>
        <tbody>
          <template v-for="l in visible" :key="l.fp">
            <tr :data-fp="l.fp" :class="{ dim: l.status !== 'new' || !l.include, joined: l.include && l.parts?.length > 1 }">
              <td class="tick"><input v-if="l.status === 'new'" type="checkbox" v-model="l.include" :aria-label="'Add ' + l.description" /></td>
              <td class="nowrap" data-col="date"><input v-if="l.status === 'new' && l.include" type="date" v-model="l.date" aria-label="Date" /><template v-else>{{ niceDate(l.date) }}</template></td>
              <td class="nowrap" data-col="reference">
                <input v-if="l.status === 'new' && l.include" class="ref" :class="{ need: clash(l.fp) || (l.parts[0].refMode === 'manual' && !l.parts[0].ref) }" :value="refs.get(l.fp) || ''" :placeholder="l.amount_cents > 0 ? 'invoice no.' : 'automatic'" aria-label="Reference" @change="setReference(l, l.parts[0], $event.target.value)" />
                <template v-else-if="l.transaction">{{ l.transaction.reference }}</template>
              </td>
              <td class="desc" :title="l.description + ' ' + l.detail">{{ l.description }} <small>{{ l.detail }}</small></td>
              <template v-if="l.status === 'new' && l.include && l.parts.length > 1">
                <td class="num" :class="{ off: partCents(l, l.parts[0]) === null }">{{ l.amount_cents < 0 ? (partCents(l, l.parts[0]) === null ? '?' : money(partCents(l, l.parts[0]))) : '' }}</td>
                <td class="num" :class="{ off: partCents(l, l.parts[0]) === null }">{{ l.amount_cents > 0 ? (partCents(l, l.parts[0]) === null ? '?' : money(partCents(l, l.parts[0]))) : '' }}</td>
              </template>
              <template v-else>
                <td class="num">{{ l.amount_cents < 0 ? money(-l.amount_cents) : '' }}</td>
                <td class="num">{{ l.amount_cents > 0 ? money(l.amount_cents) : '' }}</td>
              </template>
              <td v-if="hasBankBalance" class="num muted">{{ l.balance_cents === null ? '' : money(l.balance_cents) }}</td>
              <td class="num bal" :class="{ off: running.get(l.fp)?.differs }" :title="running.get(l.fp)?.differs ? 'Differs from the bank balance on this line' : ''">{{ money(running.get(l.fp)?.books) }}</td>
              <template v-if="l.status === 'new'">
                <td class="nowrap" data-col="payee_code"><QuickCodePicker :model-value="l.parts[0].payee_code || ''" :open-on-focus="false" :disabled="!l.include" @update:model-value="l.parts[0].payee_code = $event || null" @pick="quickPicked(l.parts[0], $event)" /></td>
                <td class="payee" data-col="payee_name"><input v-model="l.parts[0].payee_name" :disabled="!l.include" aria-label="Payee" /></td>
                <td class="nowrap" data-col="account_code"><AccountPicker v-model="l.parts[0].account_code" :open-on-focus="false" :disabled="!l.include" :need="l.include && !known(l.parts[0].account_code)" width="62px" /></td>
                <td class="act"><button v-if="l.include" class="small" title="Split this line into separate amounts" @click="split(l)">Split</button></td>
              </template>
              <template v-else>
                <td>{{ l.transaction.payee_code }}</td>
                <td class="payee">{{ l.transaction.payee_name }}<small><span class="pill ok">In the books</span>{{ l.transaction.date !== l.date ? ' dated ' + niceDate(l.transaction.date) : '' }}</small></td>
                <td class="nowrap">{{ l.transaction.account_code }} <small>{{ accountName(l.transaction.account_code) }}</small></td>
                <td></td>
              </template>
            </tr>
            <template v-if="l.status === 'new' && l.include">
              <tr v-for="(p, i) in l.parts.slice(1)" :key="p.key" :data-fp="idOf(l, p)" class="part" :class="{ joined: i < l.parts.length - 2 }">
                <td></td>
                <td class="muted">↳ part {{ i + 2 }}</td>
                <td class="nowrap" data-col="reference"><input class="ref" :class="{ need: clash(idOf(l, p)) || (p.refMode === 'manual' && !p.ref) }" :value="refs.get(idOf(l, p)) || ''" :placeholder="l.amount_cents > 0 ? 'invoice no.' : 'automatic'" aria-label="Reference" @change="setReference(l, p, $event.target.value)" /></td>
                <td class="muted desc">of {{ money(Math.abs(l.amount_cents)) }}</td>
                <td class="num" :data-col="l.amount_cents < 0 ? 'amount' : null"><input v-if="l.amount_cents < 0" v-model="p.amount" class="num amt" :class="{ need: partCents(l, p) === null }" inputmode="decimal" placeholder="0.00" aria-label="Amount of this part" /></td>
                <td class="num" :data-col="l.amount_cents > 0 ? 'amount' : null"><input v-if="l.amount_cents > 0" v-model="p.amount" class="num amt" :class="{ need: partCents(l, p) === null }" inputmode="decimal" placeholder="0.00" aria-label="Amount of this part" /></td>
                <td v-if="hasBankBalance"></td>
                <td></td>
                <td class="nowrap" data-col="payee_code"><QuickCodePicker :model-value="p.payee_code || ''" :open-on-focus="false" @update:model-value="p.payee_code = $event || null" @pick="quickPicked(p, $event)" /></td>
                <td class="payee" data-col="payee_name"><input v-model="p.payee_name" aria-label="Payee" /></td>
                <td class="nowrap" data-col="account_code"><AccountPicker v-model="p.account_code" :open-on-focus="false" :need="!known(p.account_code)" width="62px" /></td>
                <td class="act"><button class="small" title="Remove this part" :aria-label="'Remove part ' + (i + 2)" @click="unsplit(l, p)">Remove</button></td>
              </tr>
            </template>
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
            <tr><td>New entries to add</td><td class="num"><b>{{ entries.length }}</b></td></tr>
            <tr v-if="entries.length > chosen.length"><td class="in">from statement lines</td><td class="num">{{ chosen.length }}</td></tr>
            <tr><td class="in">payments</td><td class="num">{{ money(total(-1)) }}</td></tr>
            <tr><td class="in">receipts</td><td class="num">{{ money(total(1)) }}</td></tr>
            <tr><td>Entries already in the books to tick off</td><td class="num">{{ toTick }}</td></tr>
            <tr v-if="leftOut.length"><td>Lines unticked (not added)</td><td class="num">{{ leftOut.length }}</td></tr>
            <tr v-if="closing"><td>Bank balance in the books at {{ niceDate(closing.date) }} afterwards</td><td class="num">{{ money(closing.after) }}</td></tr>
            <tr v-if="closing"><td>Statement balance</td><td class="num">{{ money(closing.balance_cents) }} <span class="pill" :class="closing.diff === 0 ? 'ok' : 'warn'">{{ closing.diff === 0 ? 'agrees' : 'out by ' + money(Math.abs(closing.diff)) }}</span></td></tr>
          </tbody>
        </table>
        <div class="row" style="justify-content: flex-end; margin-top: 14px">
          <button @click="confirming = false">Back to the preview</button>
          <button class="primary" :disabled="busy" @click="importNow">{{ entries.length ? `Add ${plural(entries.length, 'entry', 'entries')}` : 'Tick off' }}</button>
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
.nowrap { white-space: nowrap; }
td.off { color: var(--amber); font-weight: 650; }
/* The review table is kept narrow enough to show every column, balances included, without scrolling
   sideways on a laptop screen; if the window is narrower still, it scrolls rather than hiding columns. */
.fit { overflow-x: auto; }
.review { font-size: 12.5px; }
.keys { font-size: 12px; }
.keys kbd { font: inherit; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; background: var(--soft); }
.review th, .review td { padding: 4px 6px; }
/* Every cell's first line is one 26px band - the height of the boxes - so dates, amounts, balances, boxes and
   tick boxes sit on the same line across the row. */
.review td { vertical-align: top; line-height: 26px; }
.review td small { line-height: inherit; }
.review input:not([type="checkbox"]) { height: 26px; padding: 0 6px; line-height: normal; vertical-align: top; font-size: 12.5px; }
.review input[type="checkbox"] { width: 15px; height: 15px; margin: 0; vertical-align: middle; position: relative; top: -2px; }
.review :deep(.picker) { height: 26px; vertical-align: top; gap: 5px; }
.review :deep(.picker input) { height: 26px; padding: 0 6px; font-size: 12.5px; }
.review :deep(.picker-name) { line-height: 26px; max-width: 92px; }
.review .pill { line-height: 1.5; }
.review td.payee .pill { line-height: 14px; font-size: 11px; padding: 0 6px; }
.review td.tick { width: 22px; padding-right: 0; }
.review input.ref { width: 84px; }
.review input.amt { width: 78px; }
.review input.need { border-color: var(--amber); box-shadow: 0 0 0 2px var(--amber-soft); }
.review td.desc { max-width: 132px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review td.payee { min-width: 112px; max-width: 150px; }
.review td.payee input { width: 100%; display: block; }
.review td.payee small { display: block; line-height: 15px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review td.bal { font-weight: 600; }
.review input[type="date"] { width: 106px; }
.review td.act { padding-left: 0; }
.review td.act button { padding: 0 7px; height: 24px; font-size: 12px; vertical-align: top; margin-top: 1px; }
.review tr.part td { background: var(--soft); }
.veil { position: fixed; inset: 0; background: rgba(10, 20, 25, .55); display: grid; place-items: center; z-index: 30; padding: 16px; }
.dialog { width: min(520px, 100%); margin: 0; box-shadow: 0 20px 60px rgba(0, 0, 0, .35); }
.dialog td.in { padding-left: 28px; color: var(--muted); }
</style>
