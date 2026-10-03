<script setup>
// Entering and browsing transactions. The form at the top adds an entry (or edits the one clicked below);
// Enter saves and leaves the cursor ready for the next line of the bank statement.
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue';
import { store, api, loadMeta, toast, money, dollars, accountName } from '../store.js';
import { toCents, fromCents, gstInside, rateOn, niceDate, isIsoDate } from '../../../shared/money.js';

const rows = ref([]);
const loading = ref(false);
const search = ref('');
const period = ref('');                      // 'YYYY-MM'
const form = reactive({ id: null, date: '', type: 'P', amount: '', payee: '', payee_code: null, account_code: '', reference: '', refTouched: false, gstManual: false, gst: '' });
const error = ref(null);
const saving = ref(false);
const payeeBox = ref(null);
const dateBox = ref(null);

const monthLabel = computed(() => {
  if (!period.value) return '';
  const [y, m] = period.value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-NZ', { month: 'long', year: 'numeric', timeZone: 'UTC' });
});
function monthRange(p) {
  const [y, m] = p.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${p}-01`, to: `${p}-${String(last).padStart(2, '0')}` };
}
function shiftMonth(n) {
  const [y, m] = period.value.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  period.value = d.toISOString().slice(0, 7);
}

async function load() {
  loading.value = true;
  try {
    const q = search.value.trim();
    const params = q ? new URLSearchParams({ q }) : new URLSearchParams(monthRange(period.value));
    rows.value = await api('GET', '/api/transactions?' + params);
  } catch (e) { toast(e.message, { kind: 'error' }); }
  loading.value = false;
}
let searchTimer = null;
watch(search, () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 250); });
watch(period, load);

const totals = computed(() => {
  let p = 0, r = 0, g = 0;
  for (const t of rows.value) { if (t.type === 'R') { r += t.amount_cents || 0; g += t.gst_cents; } else { p += t.amount_cents || 0; g -= t.gst_cents; } }
  return { p, r, g };
});

// ---- the entry form
const amountCents = computed(() => toCents(form.amount));
const account = computed(() => store.accounts.find(a => a.code === form.account_code.trim()));
const autoGst = computed(() => {
  if (!amountCents.value || !account.value) return null;
  if (account.value.gst_exempt) return 0;
  const rate = rateOn(store.gst_rates, form.date);
  return rate === null ? null : gstInside(amountCents.value, rate);
});
const gstNote = computed(() => {
  if (!account.value) return '';
  if (account.value.gst_exempt) return 'exempt';
  const rate = rateOn(store.gst_rates, form.date);
  return rate === null ? 'no rate' : rate / 100 + '%';
});
const editing = computed(() => form.id !== null);
const locked = computed(() => Boolean(store.settings.locked_to && form.date && form.date <= store.settings.locked_to && editing.value));

async function refreshReference() {
  if (editing.value || form.refTouched || !isIsoDate(form.date)) return;
  try { form.reference = (await api('GET', '/api/next-reference?date=' + form.date)).reference; } catch { /* keep what is there */ }
}
watch(() => form.date, refreshReference);

function resolvePayee() {
  const typed = form.payee.trim();
  const p = store.payees.find(x => x.code === typed.toUpperCase());
  if (p) {
    form.payee = p.name;
    form.payee_code = p.code;
    if (p.account_code) form.account_code = p.account_code;
  } else if (!store.payees.some(x => x.code === form.payee_code && x.name === typed)) {
    form.payee_code = null;
  }
}

function blank(keepDate = true) {
  Object.assign(form, { id: null, date: keepDate && form.date ? form.date : store.today, type: 'P', amount: '', payee: '', payee_code: null, account_code: '', reference: '', refTouched: false, gstManual: false, gst: '' });
  error.value = null;
  refreshReference();
}

function edit(t) {
  Object.assign(form, { id: t.id, date: t.date || '', type: t.type, amount: t.amount_cents ? fromCents(t.amount_cents).replace(/,/g, '') : '', payee: t.payee_name, payee_code: t.payee_code,
    account_code: t.account_code || '', reference: t.reference, refTouched: true, gstManual: Boolean(t.gst_manual), gst: fromCents(t.gst_cents) });
  error.value = null;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function save() {
  if (saving.value) return;
  resolvePayee();
  error.value = null;
  if (amountCents.value === null) { error.value = { message: 'Enter the amount, e.g. 125.50', field: 'amount_cents' }; return; }
  const body = { date: form.date, type: form.type, amount_cents: amountCents.value, payee_name: form.payee.trim(), payee_code: form.payee_code, account_code: form.account_code.trim(), reference: form.reference.trim() };
  if (form.gstManual) { body.gst_manual = 1; body.gst_cents = toCents(form.gst); }
  saving.value = true;
  try {
    const wasEdit = editing.value;
    const t = wasEdit ? await api('PUT', '/api/transactions/' + form.id, body) : await api('POST', '/api/transactions', body);
    toast(`${wasEdit ? 'Updated' : 'Saved'} ${t.reference} — ${t.type === 'P' ? 'payment' : 'receipt'} of ${dollars(t.amount_cents)}`);
    if (t.date && t.date.slice(0, 7) !== period.value && !search.value) period.value = t.date.slice(0, 7); else await load();
    await loadMeta();
    blank();
    await nextTick();
    payeeBox.value?.focus();
  } catch (e) { error.value = { message: e.message, field: e.field }; }
  saving.value = false;
}

async function remove() {
  if (!editing.value) return;
  try {
    const r = await api('DELETE', '/api/transactions/' + form.id);
    toast(`Deleted ${r.deleted.reference}`, { label: 'Undo', action: async () => { await api('POST', '/api/restore/' + r.change_id); await load(); await loadMeta(); toast('Put back ' + r.deleted.reference); } , ms: 10000 });
    blank();
    await load();
    await loadMeta();
  } catch (e) { error.value = { message: e.message }; }
}

// Another screen (the problem finder) asked for an entry to be opened.
async function openRequested() {
  const req = store.openTransaction;
  if (!req) return;
  store.openTransaction = null;
  search.value = '';
  if (req.date) { period.value = req.date.slice(0, 7); await load(); } else { search.value = ''; rows.value = await api('GET', '/api/transactions?' + new URLSearchParams({ q: req.reference || '' })); }
  const t = rows.value.find(x => x.id === req.id);
  if (t) edit(t);
}
watch(() => store.openTransaction, openRequested);

onMounted(async () => {
  period.value = (store.last_date || store.today).slice(0, 7);
  blank(false);
  form.date = store.today;
  await openRequested();
  dateBox.value?.focus();
});
const bad = f => ({ bad: error.value?.field === f });
</script>

<template>
  <div class="head">
    <h1>Transactions</h1>
    <span class="grow"></span>
    <input v-model="search" type="search" placeholder="Search payee, reference, code or amount" style="width: 300px" aria-label="Search all transactions" />
  </div>

  <form class="card entry" :class="{ editing }" @submit.prevent="save">
    <div class="row">
      <label class="field" :class="bad('date')"><span>Date</span><input ref="dateBox" v-model="form.date" type="date" required /></label>
      <label class="field grow2" :class="bad('payee_name')"><span>Payee or quick code</span>
        <input ref="payeeBox" v-model="form.payee" list="payee-list" autocomplete="off" placeholder="e.g. FUEL, or type a name" @change="resolvePayee" @blur="resolvePayee" /></label>
      <div class="field"><span>Type</span>
        <div class="seg" role="group" aria-label="Payment or receipt">
          <button type="button" :class="{ on: form.type === 'P' }" @click="form.type = 'P'">Payment</button>
          <button type="button" :class="{ on: form.type === 'R' }" @click="form.type = 'R'">Receipt</button>
        </div></div>
      <label class="field" :class="bad('amount_cents')"><span>Amount</span><input v-model="form.amount" class="num" inputmode="decimal" placeholder="0.00" style="width: 120px" /></label>
      <label class="field" :class="bad('account_code')"><span>Ledger code</span><input v-model="form.account_code" list="account-list" autocomplete="off" style="width: 110px" /></label>
      <label class="field" :class="bad('reference')"><span>Reference</span><input v-model="form.reference" style="width: 120px" @input="form.refTouched = true" /></label>
    </div>
    <div class="row under">
      <span class="muted desc">{{ accountName(form.account_code.trim()) || (form.account_code ? 'Unknown ledger code' : 'Ledger code fills in from the quick code') }}</span>
      <span class="gst">
        GST <template v-if="!form.gstManual"><b>{{ autoGst === null ? '–' : money(autoGst) }}</b> <small v-if="gstNote">({{ gstNote }})</small>
          <button type="button" class="link" @click="form.gstManual = true; form.gst = autoGst === null ? '' : money(autoGst)">change</button></template>
        <template v-else><input v-model="form.gst" class="num" style="width: 90px" aria-label="GST amount" /> <button type="button" class="link" @click="form.gstManual = false">automatic</button></template>
      </span>
      <span class="grow"></span>
      <span v-if="locked" class="pill warn">Locked period</span>
      <button v-if="editing" type="button" class="danger" :disabled="locked" @click="remove">Delete</button>
      <button v-if="editing" type="button" @click="blank()">Cancel</button>
      <button class="primary" :disabled="saving || locked">{{ editing ? 'Save changes' : 'Add transaction' }}</button>
    </div>
    <p v-if="error" class="banner error" role="alert">{{ error.message }}</p>
    <datalist id="payee-list"><option v-for="p in store.payees" :key="p.code" :value="p.code">{{ p.name }}</option></datalist>
    <datalist id="account-list"><option v-for="a in store.accounts.filter(a => a.active)" :key="a.code" :value="a.code">{{ a.description }}{{ a.sub_description ? ' / ' + a.sub_description : '' }}</option></datalist>
  </form>

  <div class="card flush">
    <div class="bar">
      <template v-if="!search">
        <button class="small" @click="shiftMonth(-1)" aria-label="Previous month">‹</button>
        <input type="month" v-model="period" aria-label="Month" />
        <button class="small" @click="shiftMonth(1)" aria-label="Next month">›</button>
        <strong>{{ monthLabel }}</strong>
      </template>
      <strong v-else>Search results for “{{ search }}”</strong>
      <span class="grow"></span>
      <span class="muted">{{ rows.length }} {{ rows.length === 1 ? 'entry' : 'entries' }}</span>
    </div>
    <table>
      <thead><tr><th>Date</th><th>Reference</th><th>Payee</th><th>Ledger code</th><th class="num">Payment</th><th class="num">Receipt</th><th class="num">GST</th><th class="num">Balance</th></tr></thead>
      <tbody>
        <tr v-for="t in rows" :key="t.id" class="click" :class="{ sel: t.id === form.id }" tabindex="0" @click="edit(t)" @keydown.enter="edit(t)">
          <td>{{ t.date ? niceDate(t.date) : '— no date —' }}</td>
          <td>{{ t.reference }}</td>
          <td>{{ t.payee_name }}</td>
          <td><b>{{ t.account_code }}</b> <span class="muted">{{ accountName(t.account_code) }}</span></td>
          <td class="num">{{ t.type === 'P' ? money(t.amount_cents) : '' }}</td>
          <td class="num">{{ t.type === 'R' ? money(t.amount_cents) : '' }}</td>
          <td class="num muted">{{ money(t.gst_cents, { blankZero: true }) }}</td>
          <td class="num" :class="{ neg: t.balance_cents < 0 }">{{ money(t.balance_cents) }}</td>
        </tr>
      </tbody>
      <tfoot v-if="rows.length"><tr><td colspan="4">Totals</td><td class="num">{{ money(totals.p) }}</td><td class="num">{{ money(totals.r) }}</td><td class="num">{{ money(totals.g) }}</td><td></td></tr></tfoot>
    </table>
    <p v-if="!rows.length && !loading" class="empty">{{ search ? 'Nothing matches that search.' : 'No transactions in this month.' }}</p>
  </div>
</template>

<style scoped>
.entry.editing { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.grow2 { flex: 1; min-width: 200px; }
.grow2 input { width: 100%; }
.under { margin-top: 12px; align-items: center; }
.under .grow { flex: 1; }
.desc { min-width: 220px; }
.gst input { padding: 4px 7px; }
.bar { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.bar .grow { flex: 1; }
.bar input[type="month"] { padding: 4px 8px; }
</style>
