<script setup>
// Ledger code box. The list has three columns - Description, Code, GST - in description order, so a code is
// found by what it is for.
import { computed } from 'vue';
import { store } from './store.js';
import ListPicker from './ListPicker.vue';

const props = defineProps({ modelValue: { type: String, default: '' }, disabled: Boolean, openOnFocus: { type: Boolean, default: true }, need: Boolean, showName: { type: Boolean, default: true }, width: { type: String, default: '74px' } });
const emit = defineEmits(['update:modelValue', 'change']);

const label = a => (a.sub_description ? `${a.description} / ${a.sub_description}` : a.description);
const columns = [{ key: 'description', title: 'Description', width: '1fr' }, { key: 'code', title: 'Code', width: '72px' }, { key: 'gst', title: 'GST', width: '64px' }];
const rows = computed(() => store.accounts.filter(a => a.active || a.code === props.modelValue)
  .map(a => ({ code: a.code, description: label(a), gst: a.gst_exempt ? 'Exempt' : 'Yes' }))
  .sort((a, b) => a.description.localeCompare(b.description, 'en', { sensitivity: 'base', numeric: true }) || a.code.localeCompare(b.code, 'en', { numeric: true })));
const name = computed(() => (props.showName ? rows.value.find(r => r.code === props.modelValue.trim())?.description || '' : ''));
</script>

<template>
  <ListPicker :model-value="modelValue" :rows="rows" :columns="columns" :name="name" label="Ledger code" :disabled="disabled" :open-on-focus="openOnFocus" :need="need" :width="width"
    @update:model-value="emit('update:modelValue', $event)" @change="emit('change', $event)" />
</template>
