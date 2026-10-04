<script setup>
// Quick code box, as on the Access Transactions form: choosing a quick code fills in the payee name and the
// ledger code that payee normally goes to. The list shows Code, Payee and Ledger code, in code order.
import { computed } from 'vue';
import { store } from './store.js';
import ListPicker from './ListPicker.vue';

defineProps({ modelValue: { type: String, default: '' }, disabled: Boolean, openOnFocus: { type: Boolean, default: true }, width: { type: String, default: '62px' } });
const emit = defineEmits(['update:modelValue', 'pick']);

const columns = [{ key: 'code', title: 'Code', width: '64px' }, { key: 'name', title: 'Payee', width: '1fr' }, { key: 'account_code', title: 'Ledger code', width: '84px' }];
const rows = computed(() => store.payees.map(p => ({ code: p.code, name: p.name, account_code: p.account_code || '' }))
  .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true })));
</script>

<template>
  <ListPicker :model-value="modelValue" :rows="rows" :columns="columns" label="Quick code" strict auto-fill :disabled="disabled" :open-on-focus="openOnFocus" :width="width" :list-width="440"
    @update:model-value="emit('update:modelValue', $event)" @pick="emit('pick', $event)" />
</template>
