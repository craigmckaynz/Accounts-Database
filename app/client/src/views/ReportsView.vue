<script setup>
// Reports for the accountant: ledger report (by ledger code), transaction listing and GST summary.
// Print gives a clean page (or Save as PDF from the print dialog); Download gives a file Excel opens.
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { store, api, toast, money, accountName, downloadCsv } from '../store.js';
import { niceDate, fromCents } from '../../../shared/money.js';

const kind = ref('ledger');
const range = reactive({ preset: 'this_year', from: '', to: '' });
const detail = ref(true);
const codes = ref([]);
const report = ref(null);
const listing = ref([]);
const busy = ref(false);

const iso = d => d.toISOString().slice(0, 10);
function presetRange(p) {
  const t = new Date(store.today + 'T00:00:00Z');
  const y = t.getUTCFullYear(), m = t.getUTCMonth();
  const start = Number(store.settings.year_start_month || 4) - 1;
  const fy = m >= start ? y : y - 1;                       // year the current financial year started in
  switch (p) {
    case 'this_month': return [new Date(Date.UTC(y, m, 1)), new Date(Date.UTC(y, m + 1, 0))];
    case 'last_month': return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 0))];
    case 'last_2_months': return [new Date(Date.UTC(y, m - 2, 1)), new Date(Date.UTC(y, m, 0))];
    case 'last_6_months': return [new Date(Date.UTC(y, m - 6, 1)), new Date(Date.UTC(y, m, 0))];
    case 'this_year': return [new Date(Date.UTC(fy, start, 1)), new Date(Date.UTC(fy + 1, start, 0))];
    case 'last_year': return [new Date(Date.UTC(fy - 1, start, 1)), new Date(Date.UTC(fy, start, 0))];
    default: return null;
  }
}
function applyPreset() {
  const r = presetRange(range.preset);
  if (r) { range.from = iso(r[0]); range.to = iso(r[1]); }
}

async function run() {
  if (!range.from || !range.to) return;
  busy.value = true;
  try {
    const q = new URLSearchParams({ from: range.from, to: range.to });
    if (kind.value === 'ledger') {
      if (codes.value.length) q.set('codes', codes.value.join(','));
      if (!detail.value) q.set('detail', '0');
      report.value = await api('GET', '/api/reports/ledger?' + q);
    } else if (kind.value === 'gst') {
      report.value = await api('GET', '/api/reports/gst?' + q);
    } else {
      q.set('limit', '100000');
      const [rows, gst] = await Promise.all([api('GET', '/api/transactions?' + q), api('GET', '/api/reports/gst?' + q)]);
      listing.value = codes.value.length ? rows.filter(r => codes.value.includes(r.account_code)) : rows;
      report.value = gst;
    }
    report.value.kind = kind.value;
  } catch (e) { toast(e.message, { kind: 'error' }); }
  busy.value = false;
}
watch([kind, detail, codes, () => range.from, () => range.to], run);
onMounted(() => { applyPreset(); });

const title = computed(() => ({ ledger: 'Ledger report', listing: 'Transaction listing', gst: 'GST summary' })[kind.value]);
const period = computed(() => `${niceDate(range.from)} to ${niceDate(range.to)}`);
const shown = computed(() => report.value && report.value.kind === kind.value);
const plain = c => (c === null || c === undefined ? '' : (c / 100).toFixed(2));

function download() {
  const r = report.value;
  const name = `${title.value.toLowerCase().replace(/ /g, '-')}-${range.from}-to-${range.to}.csv`;
  const rows = [[`${store.settings.bank_account} - ${title.value}`], [period.value], []];
  if (kind.value === 'ledger') {
    rows.push(['Ledger code', 'Description', 'Date', 'Reference', 'Payee', 'Payments', 'Receipts', 'GST', 'Net']);
    for (const g of r.groups) {
      const d = g.sub_description ? `${g.description} / ${g.sub_description}` : g.description;
      for (const t of g.rows) rows.push([g.code, d, t.date, t.reference, t.payee_name, t.type === 'P' ? plain(t.amount_cents) : '', t.type === 'R' ? plain(t.amount_cents) : '', plain((t.type === 'R' ? 1 : -1) * t.gst_cents), plain((t.type === 'R' ? 1 : -1) * t.amount_cents)]);
      rows.push([g.code, d, '', '', 'Subtotal', plain(g.payments_cents), plain(g.receipts_cents), plain(g.gst_cents), plain(g.net_cents)]);
    }
    rows.push(['', '', '', '', 'Total', plain(r.total.payments_cents), plain(r.total.receipts_cents), plain(r.total.gst_cents), plain(r.total.net_cents)]);
  } else if (kind.value === 'listing') {
    rows.push(['Date', 'Reference', 'Payee', 'Ledger code', 'Description', 'Payment', 'Receipt', 'GST', 'Balance']);
    for (const t of listing.value) rows.push([t.date, t.reference, t.payee_name, t.account_code, accountName(t.account_code), t.type === 'P' ? plain(t.amount_cents) : '', t.type === 'R' ? plain(t.amount_cents) : '', plain(t.gst_cents), plain(t.balance_cents)]);
  } else {
    rows.push(['', 'Entries', 'Total including GST', 'GST']);
    rows.push(['Receipts with GST', r.receipts_with_gst.n, plain(r.receipts_with_gst.amount), plain(r.receipts_with_gst.gst)]);
    rows.push(['Receipts without GST', r.receipts_no_gst.n, plain(r.receipts_no_gst.amount), '']);
    rows.push(['Payments with GST', r.payments_with_gst.n, plain(r.payments_with_gst.amount), plain(r.payments_with_gst.gst)]);
    rows.push(['Payments without GST', r.payments_no_gst.n, plain(r.payments_no_gst.amount), '']);
    rows.push(['GST on receipts less GST on payments', '', '', plain(r.gst_difference_cents)]);
  }
  downloadCsv(name, rows);
}
const print = () => window.print();
</script>

<template>
  <div class="head no-print">
    <h1>Reports</h1>
    <span class="grow"></span>
    <button @click="download" :disabled="!shown">Download for Excel</button>
    <button class="primary" @click="print" :disabled="!shown">Print or save as PDF</button>
  </div>

  <div class="card no-print">
    <div class="row">
      <div class="field"><span>Report</span>
        <div class="seg">
          <button :class="{ on: kind === 'ledger' }" @click="kind = 'ledger'">By ledger code</button>
          <button :class="{ on: kind === 'listing' }" @click="kind = 'listing'">Transaction listing</button>
          <button :class="{ on: kind === 'gst' }" @click="kind = 'gst'">GST summary</button>
        </div></div>
      <label class="field"><span>Period</span>
        <select v-model="range.preset" @change="applyPreset">
          <option value="this_month">This month</option><option value="last_month">Last month</option>
          <option value="last_2_months">Last 2 months</option><option value="last_6_months">Last 6 months</option>
          <option value="this_year">This financial year</option><option value="last_year">Last financial year</option>
          <option value="custom">Custom dates</option>
        </select></label>
      <label class="field"><span>From</span><input type="date" v-model="range.from" @input="range.preset = 'custom'" /></label>
      <label class="field"><span>To</span><input type="date" v-model="range.to" @input="range.preset = 'custom'" /></label>
      <label v-if="kind === 'ledger'" class="check"><input type="checkbox" v-model="detail" /> Show every transaction</label>
    </div>
    <details v-if="kind !== 'gst'" style="margin-top: 12px">
      <summary><b>Ledger codes</b> <span class="muted">{{ codes.length ? codes.length + ' selected' : 'all' }}</span> <button v-if="codes.length" class="link" @click.prevent="codes = []">clear</button></summary>
      <div class="codes">
        <label v-for="a in store.accounts" :key="a.code"><input type="checkbox" :value="a.code" v-model="codes" /> <b>{{ a.code }}</b> {{ a.description }}{{ a.sub_description ? ' / ' + a.sub_description : '' }}</label>
      </div>
    </details>
  </div>

  <div v-if="shown" class="card flush report">
    <div class="rhead">
      <div><h2 style="margin: 0">{{ store.settings.bank_account }} — {{ title }}</h2><span class="muted">{{ period }}{{ codes.length && kind !== 'gst' ? ' · ledger codes ' + codes.join(', ') : '' }}</span></div>
      <div class="num muted">Opening bank balance {{ money(report.balances.opening_cents) }}<br />Closing bank balance {{ money(report.balances.closing_cents) }}</div>
    </div>

    <table v-if="kind === 'ledger'">
      <thead><tr><th>Date</th><th>Reference</th><th>Payee</th><th class="num">Payments</th><th class="num">Receipts</th><th class="num">GST</th><th class="num">Net</th></tr></thead>
      <tbody v-for="g in report.groups" :key="g.code">
        <tr class="group"><td colspan="7">{{ g.code }} &nbsp; {{ g.description }}{{ g.sub_description ? ' / ' + g.sub_description : '' }}</td></tr>
        <tr v-for="t in g.rows" :key="t.id">
          <td>{{ niceDate(t.date) }}</td><td>{{ t.reference }}</td><td>{{ t.payee_name }}</td>
          <td class="num">{{ t.type === 'P' ? money(t.amount_cents) : '' }}</td><td class="num">{{ t.type === 'R' ? money(t.amount_cents) : '' }}</td>
          <td class="num">{{ money((t.type === 'R' ? 1 : -1) * t.gst_cents, { blankZero: true }) }}</td><td class="num">{{ money((t.type === 'R' ? 1 : -1) * t.amount_cents) }}</td>
        </tr>
        <tr class="sub"><td colspan="3">{{ detail ? 'Subtotal' : '' }} <span class="muted">{{ g.count }} {{ g.count === 1 ? 'entry' : 'entries' }}</span></td>
          <td class="num">{{ money(g.payments_cents, { blankZero: true }) }}</td><td class="num">{{ money(g.receipts_cents, { blankZero: true }) }}</td><td class="num">{{ money(g.gst_cents) }}</td><td class="num">{{ money(g.net_cents) }}</td></tr>
      </tbody>
      <tfoot><tr><td colspan="3">Total <span class="muted">{{ report.total.count }} entries</span></td><td class="num">{{ money(report.total.payments_cents) }}</td><td class="num">{{ money(report.total.receipts_cents) }}</td><td class="num">{{ money(report.total.gst_cents) }}</td><td class="num">{{ money(report.total.net_cents) }}</td></tr></tfoot>
    </table>

    <table v-else-if="kind === 'listing'">
      <thead><tr><th>Date</th><th>Reference</th><th>Payee</th><th>Ledger code</th><th class="num">Payment</th><th class="num">Receipt</th><th class="num">GST</th><th class="num">Balance</th></tr></thead>
      <tbody>
        <tr v-for="t in listing" :key="t.id">
          <td>{{ niceDate(t.date) }}</td><td>{{ t.reference }}</td><td>{{ t.payee_name }}</td><td>{{ t.account_code }} <span class="muted">{{ accountName(t.account_code) }}</span></td>
          <td class="num">{{ t.type === 'P' ? money(t.amount_cents) : '' }}</td><td class="num">{{ t.type === 'R' ? money(t.amount_cents) : '' }}</td>
          <td class="num">{{ money(t.gst_cents, { blankZero: true }) }}</td><td class="num">{{ money(t.balance_cents) }}</td>
        </tr>
      </tbody>
      <tfoot><tr><td colspan="4">{{ listing.length }} entries</td>
        <td class="num">{{ money(listing.reduce((s, t) => s + (t.type === 'P' ? t.amount_cents : 0), 0)) }}</td>
        <td class="num">{{ money(listing.reduce((s, t) => s + (t.type === 'R' ? t.amount_cents : 0), 0)) }}</td><td></td><td></td></tr></tfoot>
    </table>

    <table v-else>
      <thead><tr><th></th><th class="num">Entries</th><th class="num">Total including GST</th><th class="num">GST</th></tr></thead>
      <tbody>
        <tr><td>Receipts with GST</td><td class="num">{{ report.receipts_with_gst.n }}</td><td class="num">{{ money(report.receipts_with_gst.amount) }}</td><td class="num">{{ money(report.receipts_with_gst.gst) }}</td></tr>
        <tr><td>Receipts without GST</td><td class="num">{{ report.receipts_no_gst.n }}</td><td class="num">{{ money(report.receipts_no_gst.amount) }}</td><td></td></tr>
        <tr><td>Payments with GST</td><td class="num">{{ report.payments_with_gst.n }}</td><td class="num">{{ money(report.payments_with_gst.amount) }}</td><td class="num">{{ money(report.payments_with_gst.gst) }}</td></tr>
        <tr><td>Payments without GST</td><td class="num">{{ report.payments_no_gst.n }}</td><td class="num">{{ money(report.payments_no_gst.amount) }}</td><td></td></tr>
      </tbody>
      <tfoot><tr><td colspan="3">GST on receipts less GST on payments</td><td class="num">{{ money(report.gst_difference_cents) }}</td></tr></tfoot>
    </table>
    <p v-if="kind === 'gst'" class="muted note">Totals of the GST recorded on each entry, on a payments (cash) basis. For your accountant to prepare the return from.</p>
  </div>
  <p v-else-if="busy" class="empty">Working…</p>
</template>

<style scoped>
.check { display: flex; gap: 6px; align-items: center; padding-bottom: 8px; }
.codes { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 4px 14px; margin-top: 10px; max-height: 220px; overflow: auto; }
.rhead { display: flex; justify-content: space-between; gap: 20px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.note { padding: 10px 16px; margin: 0; }
@media print { .rhead { padding: 0 0 8px; } }
</style>
