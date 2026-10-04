<script setup>
// A text box with a drop-down list laid out in titled columns. Twenty or more lines show at once; typing
// filters on the code or any of the other columns; arrow keys and Enter pick; Tab picks a sole match.
// AccountPicker (ledger codes) and QuickCodePicker (quick codes) are this with their own columns.
import { ref, computed, nextTick, onBeforeUnmount } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  rows: { type: Array, required: true },           // [{ code, ...cells }] in the order to show them
  columns: { type: Array, required: true },        // [{ key, title, width: '1fr' | '70px', align }]
  name: { type: String, default: '' },             // text shown beside the box for the chosen row
  label: { type: String, default: '' },
  strict: Boolean,                                 // only a listed code (or nothing) may be left in the box
  autoFill: Boolean,                               // typing down to a single possibility fills it in at once
  openOnFocus: { type: Boolean, default: true },   // false in grids, where the arrow keys move between rows
  disabled: Boolean, need: Boolean,
  width: { type: String, default: '74px' },
  listWidth: { type: Number, default: 400 }
});
const emit = defineEmits(['update:modelValue', 'change', 'pick']);

const ROW = 26;                      // px per line in the list
const HEAD = 28;                     // the column titles
const box = ref(null);
const list = ref(null);
const open = ref(false);
const filtering = ref(false);        // false until something is typed: the whole list shows on opening
const active = ref(0);
const place = ref({});
let before = '';

const template = computed(() => props.columns.map(c => c.width || '1fr').join(' '));
const find = v => props.rows.find(r => r.code.toLowerCase() === String(v || '').trim().toLowerCase());
const current = computed(() => find(props.modelValue));
// The rows that fit what has been typed: codes starting with it first, then any column containing it.
function matching(text) {
  const q = text.trim().toLowerCase();
  if (!q) return props.rows;
  const starts = props.rows.filter(r => r.code.toLowerCase().startsWith(q));
  const rest = props.rows.filter(r => !r.code.toLowerCase().startsWith(q) && props.columns.some(c => String(r[c.key] ?? '').toLowerCase().includes(q)));
  return starts.concat(rest);
}
const options = computed(() => (filtering.value ? matching(props.modelValue) : props.rows));

function position() {
  const r = box.value.getBoundingClientRect();
  const want = Math.min(options.value.length, 22) * ROW + HEAD + 10;
  const below = window.innerHeight - r.bottom - 8;
  const above = r.top - 8;
  const width = Math.min(props.listWidth, window.innerWidth - 16);
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
function listen(on) {
  window[on ? 'addEventListener' : 'removeEventListener']('scroll', hide, true);
  window[on ? 'addEventListener' : 'removeEventListener']('resize', hide);
}
async function show() {
  if (props.disabled || open.value) return;
  before = current.value ? current.value.code : '';
  filtering.value = false;
  open.value = true;
  active.value = Math.max(0, options.value.findIndex(r => r === current.value));
  position();
  listen(true);
  await nextTick();
  if (list.value) list.value.scrollTop = Math.max(0, (active.value - 4) * ROW);
}
// What was in the box on arrival, so a rejected entry can be put back and a change recognised on leaving.
function focused() {
  before = current.value ? current.value.code : '';
  if (props.openOnFocus) show();
}
function hide(e) {
  if (e && e.type === 'scroll' && list.value && list.value.contains(e.target)) return;      // scrolling the list itself
  open.value = false;
  listen(false);
}
onBeforeUnmount(() => listen(false));

function pick(r) {
  before = r.code;
  emit('update:modelValue', r.code);
  emit('pick', r);
  emit('change', r.code);
  hide();
}
function typed(e) {
  // Typed down to the only possibility ("2D" when 2DEG is the one code that fits): fill it in and close the
  // list, so the next key can move on. Only while adding characters, so it can still be deleted.
  if (props.autoFill && String(e.inputType || '').startsWith('insert') && e.target.value.trim()) {
    // Only when the list itself is down to one row: any other row still showing, by code or by name, is an
    // alternative and the choice stays with the user.
    const only = matching(e.target.value);
    if (only.length === 1) { pick(only[0]); return; }
  }
  emit('update:modelValue', e.target.value);
  filtering.value = true;
  active.value = 0;
  if (!open.value) { open.value = true; listen(true); }
  nextTick(position);
}
function move(n) {
  if (!open.value) { show(); return; }
  active.value = Math.max(0, Math.min(options.value.length - 1, active.value + n));
  nextTick(() => list.value?.querySelectorAll('li')[active.value]?.scrollIntoView({ block: 'nearest' }));
}
function enter(e) {
  if (open.value && options.value[active.value]) { e.preventDefault(); pick(options.value[active.value]); }
}
function leave() {
  const text = props.modelValue.trim();
  // Typed part of a name and tabbed away: a sole match is taken.
  if (open.value && filtering.value && !current.value && text && options.value.length === 1) { pick(options.value[0]); return; }
  if (current.value) {
    if (current.value.code !== props.modelValue) emit('update:modelValue', current.value.code);   // tidy the capitals
    if (current.value.code !== before) { emit('pick', current.value); emit('change', current.value.code); }
  } else if (props.strict && text) {
    emit('update:modelValue', before);                 // not a listed code: put back what was there
  } else if (text !== before) {
    emit('change', text);
  }
  hide();
}
</script>

<template>
  <span class="picker">
    <input ref="box" :value="modelValue" :disabled="disabled" :class="{ need }" :style="{ width }" autocomplete="off" role="combobox" :aria-expanded="open" :aria-label="label"
      @input="typed" @focus="focused" @click="show" @blur="leave" @keydown.f4.prevent="show" @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)" @keydown.enter="enter" @keydown.esc="hide()" />
    <span v-if="name" class="picker-name" :title="name">{{ name }}</span>
    <Teleport to="body">
      <div v-if="open && options.length" ref="list" class="picker-list" :style="place" role="listbox">
        <div class="picker-head" :style="{ gridTemplateColumns: template }"><span v-for="c in columns" :key="c.key" :class="c.align">{{ c.title }}</span></div>
        <ul>
          <li v-for="(r, i) in options" :key="r.code" :class="{ on: i === active, cur: r === current }" :style="{ gridTemplateColumns: template }" role="option" :aria-selected="i === active" @mousedown.prevent="pick(r)" @mousemove="active = i">
            <span v-for="c in columns" :key="c.key" :class="[c.align, { strong: c.key === 'code' }]" :title="String(r[c.key] ?? '')">{{ r[c.key] }}</span>
          </li>
        </ul>
      </div>
    </Teleport>
  </span>
</template>
