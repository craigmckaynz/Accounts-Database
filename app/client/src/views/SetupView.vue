<script setup>
// Setup: the bank account and opening balance, locking, ledger codes, quick codes and GST rates.
import { ref, reactive, computed, onMounted } from 'vue';
import { store, api, loadMeta, toast, accountName } from '../store.js';
import { toCents, fromCents, niceDate } from '../../../shared/money.js';

const general = reactive({ bank_account: '', opening: '', locked_to: '', year_start_month: '4' });
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fill() {
  general.bank_account = store.settings.bank_account || '';
  general.opening = fromCents(Number(store.settings.opening_balance_cents || 0));
  general.locked_to = store.settings.locked_to || '';
  general.year_start_month = store.settings.year_start_month || '4';
  rates.value = store.gst_rates.map(r => ({ start_date: r.start_date, end_date: r.end_date || '', percent: String(r.rate_bp / 100) }));
}
const rates = ref([]);
onMounted(fill);

const run = async (fn, done) => { try { await fn(); await loadMeta(); fill(); if (done) toast(done); } catch (e) { toast(e.message, { kind: 'error' }); } };

const saveGeneral = () => run(async () => {
  const cents = toCents(general.opening);
  if (cents === null) throw new Error('Enter the opening balance as an amount, e.g. 1,250.00');
  await api('PUT', '/api/settings', { bank_account: general.bank_account, opening_balance_cents: cents, locked_to: general.locked_to, year_start_month: general.year_start_month });
}, 'Saved');

// ---- ledger codes
const acc = reactive({ code: '', description: '', sub_description: '', gst_exempt: false, active: true, existing: false });
const accFilter = ref('');
const accounts = computed(() => { const f = accFilter.value.toLowerCase(); return store.accounts.filter(a => !f || (a.code + ' ' + a.description + ' ' + a.sub_description).toLowerCase().includes(f)); });
const editAcc = a => Object.assign(acc, { code: a.code, description: a.description, sub_description: a.sub_description, gst_exempt: Boolean(a.gst_exempt), active: Boolean(a.active), existing: true });
const clearAcc = () => Object.assign(acc, { code: '', description: '', sub_description: '', gst_exempt: false, active: true, existing: false });
const saveAcc = () => run(async () => {
  await api('PUT', '/api/accounts/' + encodeURIComponent(acc.code.trim()), { main_code: acc.code.trim().split('/')[0], description: acc.description, sub_description: acc.sub_description, gst_exempt: acc.gst_exempt, active: acc.active });
  clearAcc();
}, 'Ledger code saved');
const deleteAcc = () => run(async () => { await api('DELETE', '/api/accounts/' + encodeURIComponent(acc.code)); clearAcc(); }, 'Ledger code deleted');

// ---- quick codes
const pay = reactive({ code: '', name: '', account_code: '', existing: false });
const payFilter = ref('');
const payees = computed(() => { const f = payFilter.value.toLowerCase(); return store.payees.filter(p => !f || (p.code + ' ' + p.name).toLowerCase().includes(f)); });
const editPay = p => Object.assign(pay, { code: p.code, name: p.name, account_code: p.account_code || '', existing: true });
const clearPay = () => Object.assign(pay, { code: '', name: '', account_code: '', existing: false });
const savePay = () => run(async () => { await api('PUT', '/api/payees/' + encodeURIComponent(pay.code.trim()), { name: pay.name, account_code: pay.account_code.trim() || null }); clearPay(); }, 'Quick code saved');
const deletePay = () => run(async () => { await api('DELETE', '/api/payees/' + encodeURIComponent(pay.code)); clearPay(); }, 'Quick code deleted');

// ---- GST rates
const saveRates = () => run(async () => {
  const rows = rates.value.map(r => ({ start_date: r.start_date, end_date: r.end_date || null, rate_bp: Math.round(Number(r.percent) * 100) }));
  if (rows.some(r => !Number.isFinite(r.rate_bp))) throw new Error('Enter each rate as a percentage, e.g. 15');
  await api('PUT', '/api/gst-rates', rows);
}, 'GST rates saved');
</script>

<template>
  <div class="head"><h1>Setup</h1></div>

  <form class="card" @submit.prevent="saveGeneral">
    <h2>Bank account</h2>
    <div class="row">
      <label class="field" style="flex: 1; min-width: 200px"><span>Account name</span><input v-model="general.bank_account" /></label>
      <label class="field"><span>Opening balance (before the first entry)</span><input v-model="general.opening" class="num" style="width: 160px" /></label>
      <label class="field"><span>Financial year starts</span><select v-model="general.year_start_month"><option v-for="(m, i) in months" :key="m" :value="String(i + 1)">1 {{ m }}</option></select></label>
      <label class="field"><span>Locked up to (blank = nothing locked)</span><input v-model="general.locked_to" type="date" /></label>
      <button class="primary">Save</button>
    </div>
    <p class="muted" style="margin-bottom: 0">Entries on or before the lock date cannot be added, changed or deleted. Lock a period once its GST return or year-end accounts have gone to the accountant.</p>
  </form>

  <div class="cols">
    <div class="card">
      <h2>Ledger codes <span class="muted">{{ store.accounts.length }}</span></h2>
      <form class="row" @submit.prevent="saveAcc">
        <label class="field"><span>Code</span><input v-model="acc.code" :disabled="acc.existing" required style="width: 90px" /></label>
        <label class="field" style="flex: 1; min-width: 130px"><span>Description</span><input v-model="acc.description" required style="width: 100%" /></label>
        <label class="field" style="flex: 1; min-width: 110px"><span>Sub description</span><input v-model="acc.sub_description" style="width: 100%" /></label>
        <label class="check"><input type="checkbox" v-model="acc.gst_exempt" /> No GST</label>
        <label class="check"><input type="checkbox" v-model="acc.active" /> Active</label>
        <button class="primary">{{ acc.existing ? 'Save' : 'Add' }}</button>
        <button v-if="acc.existing" type="button" class="danger" @click="deleteAcc">Delete</button>
        <button v-if="acc.existing" type="button" @click="clearAcc">Cancel</button>
      </form>
      <input v-model="accFilter" type="search" placeholder="Filter" class="filter" aria-label="Filter ledger codes" />
      <div class="scroll"><table>
        <thead><tr><th>Code</th><th>Description</th><th>GST</th></tr></thead>
        <tbody><tr v-for="a in accounts" :key="a.code" class="click" :class="{ sel: acc.existing && acc.code === a.code }" tabindex="0" @click="editAcc(a)" @keydown.enter="editAcc(a)">
          <td><b>{{ a.code }}</b></td><td>{{ a.description }}{{ a.sub_description ? ' / ' + a.sub_description : '' }} <span v-if="!a.active" class="pill warn">retired</span></td>
          <td>{{ a.gst_exempt ? 'No GST' : '' }}</td></tr></tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>Quick codes <span class="muted">{{ store.payees.length }}</span></h2>
      <form class="row" @submit.prevent="savePay">
        <label class="field"><span>Code</span><input v-model="pay.code" :disabled="pay.existing" required style="width: 80px; text-transform: uppercase" /></label>
        <label class="field" style="flex: 1; min-width: 150px"><span>Payee name</span><input v-model="pay.name" required style="width: 100%" /></label>
        <label class="field"><span>Ledger code</span><input v-model="pay.account_code" list="setup-accounts" style="width: 100px" /></label>
        <button class="primary">{{ pay.existing ? 'Save' : 'Add' }}</button>
        <button v-if="pay.existing" type="button" class="danger" @click="deletePay">Delete</button>
        <button v-if="pay.existing" type="button" @click="clearPay">Cancel</button>
      </form>
      <datalist id="setup-accounts"><option v-for="a in store.accounts" :key="a.code" :value="a.code">{{ a.description }}</option></datalist>
      <input v-model="payFilter" type="search" placeholder="Filter" class="filter" aria-label="Filter quick codes" />
      <div class="scroll"><table>
        <thead><tr><th>Code</th><th>Payee</th><th>Ledger code</th></tr></thead>
        <tbody><tr v-for="p in payees" :key="p.code" class="click" :class="{ sel: pay.existing && pay.code === p.code }" tabindex="0" @click="editPay(p)" @keydown.enter="editPay(p)">
          <td><b>{{ p.code }}</b></td><td>{{ p.name }}</td><td>{{ p.account_code }} <span class="muted">{{ accountName(p.account_code) }}</span></td></tr></tbody>
      </table></div>
    </div>
  </div>

  <form class="card" @submit.prevent="saveRates">
    <h2>GST rates</h2>
    <p class="muted" style="margin-top: 0">The rate used for an entry is the one covering its date. Leave the last end date blank for the current rate.</p>
    <div v-for="(r, i) in rates" :key="i" class="row" style="margin-bottom: 8px">
      <label class="field"><span>From</span><input type="date" v-model="r.start_date" required /></label>
      <label class="field"><span>To</span><input type="date" v-model="r.end_date" /></label>
      <label class="field"><span>Rate %</span><input v-model="r.percent" class="num" style="width: 80px" required /></label>
      <button type="button" class="small" @click="rates.splice(i, 1)" :disabled="rates.length === 1">Remove</button>
    </div>
    <div class="row"><button type="button" @click="rates.push({ start_date: '', end_date: '', percent: '' })">Add a rate</button><button class="primary">Save GST rates</button></div>
  </form>
</template>

<style scoped>
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
.cols .card { margin-bottom: 16px; }
.check { display: flex; gap: 6px; align-items: center; padding-bottom: 8px; }
.filter { margin: 12px 0 8px; width: 100%; }
.scroll { max-height: 380px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
</style>
