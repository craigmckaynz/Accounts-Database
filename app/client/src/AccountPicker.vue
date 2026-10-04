<script setup>
// Ledger code box with a drop-down list: one line per code ("270  Vehicle / Fuel"), twenty or more showing,
// filtered by typing part of the code or the description. Arrow keys and Enter pick; Tab picks a sole match.
import { ref, computed, nextTick, onBeforeUnmount } from 'vue';
import { store } from './store.js';

const props = defineProps({ modelValue: { type: String, default: '' }, disabled: Boolean, need: Boolean, showName: { type: Boolean, default: true }, width: { type: String, default: '74px' } });
const emit = defineEmits(['update:modelValue', 'change']);

const ROW = 26;                      // px per line in the list
const box = ref(null);
const list = ref(null);
const open = ref(false);
const filtering = ref(false);        // false until something is typed: the whole list shows on opening
const active = ref(0);
const place = ref({});

const label = a => (a.sub_description ? `${a.description} / ${a.sub_description}` : a.description);
// In description order, so a code is found by what it is for; codes break ties.
const all = computed(() => store.accounts.filter(a => a.active || a.code === props.modelValue)
  .slice().sort((a, b) => label(a).localeCompare(label(b), 'en', { sensitivity: 'base', numeric: true }) || a.code.localeCompare(b.code, 'en', { numeric: true })));
const current = computed(() => store.accounts.find(a => a.code === props.modelValue.trim()));
const options = computed(() => {
  const q = props.modelValue.trim().toLowerCase();
  if (!filtering.value || !q) return all.value;
  const starts = all.value.filter(a => a.code.toLowerCase().startsWith(q));
  const rest = all.value.filter(a => !a.code.toLowerCase().startsWith(q) && label(a).toLowerCase().includes(q));
  return starts.concat(rest);
});

function position() {
  const r = box.value.getBoundingClientRect();
  const want = Math.min(options.value.length, 22) * ROW + 8;
  const below = window.innerHeight - r.bottom - 8;
  const above = r.top - 8;
  const width = Math.min(380, window.innerWidth - 16);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
  if (below >= want || above >= want) {
    // Room for the whole list (up to 22 lines) under the box, or failing that above it.
    const up = below < want;
    place.value = { left: left + 'px', width: width + 'px', maxHeight: want + 'px', ...(up ? { bottom: window.innerHeight - r.top + 2 + 'px' } : { top: r.bottom + 2 + 'px' }) };
  } else {
    // Not enough room either way: stand the list beside the box and use the height of the window, so twenty
    // lines still show whenever the window is tall enough for them.
    const height = Math.min(want, window.innerHeight - 16);
    const top = Math.max(8, Math.min(r.top - height / 2, window.innerHeight - 8 - height));
    const beside = r.right + 6 + width <= window.innerWidth - 8 ? r.right + 6 : Math.max(8, r.left - width - 6);
    place.value = { left: beside + 'px', top: top + 'px', width: width + 'px', maxHeight: height + 'px' };
  }
}
async function show() {
  if (props.disabled || open.value) return;
  filtering.value = false;
  open.value = true;
  active.value = Math.max(0, options.value.findIndex(a => a.code === props.modelValue.trim()));
  position();
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  await nextTick();
  if (list.value) list.value.scrollTop = Math.max(0, (active.value - 4) * ROW);
}
function hide(e) {
  if (e && e.type === 'scroll' && list.value && list.value.contains(e.target)) return;      // scrolling the list itself
  open.value = false;
  window.removeEventListener('scroll', hide, true);
  window.removeEventListener('resize', hide);
}
onBeforeUnmount(hide);

function pick(a) {
  emit('update:modelValue', a.code);
  emit('change', a.code);
  hide();
}
function typed(e) {
  emit('update:modelValue', e.target.value);
  filtering.value = true;
  active.value = 0;
  if (!open.value) { open.value = true; window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide); }
  nextTick(position);
}
function move(n) {
  if (!open.value) { show(); return; }
  active.value = Math.max(0, Math.min(options.value.length - 1, active.value + n));
  nextTick(() => { const el = list.value?.children[active.value]; el?.scrollIntoView({ block: 'nearest' }); });
}
function enter(e) {
  if (open.value && options.value[active.value]) { e.preventDefault(); pick(options.value[active.value]); }
}
function leave() {
  // Typed part of a name and tabbed away: a sole match is taken.
  if (open.value && filtering.value && !current.value && options.value.length === 1) pick(options.value[0]);
  else { if (open.value) emit('change', props.modelValue); hide(); }
}
</script>

<template>
  <span class="picker">
    <input ref="box" :value="modelValue" :disabled="disabled" :class="{ need }" :style="{ width }" autocomplete="off" role="combobox" :aria-expanded="open" aria-label="Ledger code"
      @input="typed" @focus="show" @click="show" @blur="leave" @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)" @keydown.enter="enter" @keydown.esc="hide()" />
    <span v-if="showName" class="picker-name" :title="current ? label(current) : ''">{{ current ? label(current) : '' }}</span>
    <Teleport to="body">
      <ul v-if="open && options.length" ref="list" class="picker-list" :style="place" role="listbox">
        <li v-for="(a, i) in options" :key="a.code" :class="{ on: i === active, cur: a.code === modelValue.trim() }" role="option" :aria-selected="i === active" @mousedown.prevent="pick(a)" @mousemove="active = i">
          <span>{{ label(a) }}</span><b>{{ a.code }}</b><small v-if="a.gst_exempt">no GST</small>
        </li>
      </ul>
    </Teleport>
  </span>
</template>
