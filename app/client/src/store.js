// Shared state for the browser app and the calls to the server.
import { reactive } from 'vue';
import { fromCents } from '../../shared/money.js';

export const store = reactive({
  ready: false,
  view: 'transactions',
  settings: {}, accounts: [], payees: [], gst_rates: [],
  balance_cents: 0, last_date: null, count: 0, today: '',
  openTransaction: null,          // { id, date } - ask the Transactions screen to open an entry
  toast: null
});

export async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const e = new Error(data?.error || `The server did not answer (${res.status}).`);
    e.field = data?.field || null;
    throw e;
  }
  return data;
}

export async function loadMeta() {
  Object.assign(store, await api('GET', '/api/meta'));
  store.ready = true;
}

let toastTimer = null;
export function toast(text, { action = null, label = '', kind = 'ok', ms = 6000 } = {}) {
  clearTimeout(toastTimer);
  store.toast = { text, action, label, kind };
  toastTimer = setTimeout(() => { store.toast = null; }, ms);
}

export function go(view) {
  store.view = view;
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
}

export function openTransaction(t) {
  store.openTransaction = { id: t.id, date: t.date, reference: t.reference };
  go('transactions');
}

export const money = (c, opts) => fromCents(c, opts);
export const dollars = c => (c < 0 ? '-$' : '$') + fromCents(Math.abs(c ?? 0));

export function accountName(code) {
  const a = store.accounts.find(x => x.code === code);
  if (!a) return '';
  return a.sub_description ? `${a.description} / ${a.sub_description}` : a.description;
}

// Turns rows into a CSV file the browser downloads. Excel opens it directly.
export function downloadCsv(name, rows) {
  const esc = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const blob = new Blob(['﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
