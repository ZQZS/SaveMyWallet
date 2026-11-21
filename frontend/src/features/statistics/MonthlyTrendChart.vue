<script setup lang="ts">
import { computed } from 'vue'
import { formatMoney, formatMonth, locale, t } from '../../i18n'
import type { StatisticsMonth } from './statistics'

type TrendPoint = Omit<StatisticsMonth, 'groups'>
const props = defineProps<{ points: TrendPoint[]; kind: 'spending' | 'balance'; selectedMonth: string }>()
const emit = defineEmits<{ select: [month: string] }>()

const segments = [
  { key: 'paid', label: 'ledger.paid' },
  { key: 'due', label: 'forms.confirmedDue' },
  { key: 'estimated', label: 'ledger.needsConfirmation' },
] as const
const selected = computed(() => props.points.find(point => point.month === props.selectedMonth))
const axisFormat = computed(() => new Intl.NumberFormat(locale.value, {
  style: 'currency', currency: 'CNY', currencyDisplay: 'narrowSymbol',
  notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 2,
}))
const monthFormat = computed(() => new Intl.DateTimeFormat(locale.value, { month: 'short', timeZone: 'UTC' }))
const scale = computed(() => {
  const values = props.points.map(point => props.kind === 'balance' ? point.balance : point.total)
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  if (max === min) return { min: 0, max: 1, ticks: [0] }
  const targetStep = (max - min) / 3
  const magnitude = 10 ** Math.floor(Math.log10(targetStep))
  const step = Math.max(1, Math.round(([1, 2, 2.5, 5, 10].find(n => n * magnitude >= targetStep) ?? 10) * magnitude))
  const lower = Math.floor(min / step) * step
  const upper = Math.ceil(max / step) * step
  const ticks = Array.from({ length: 1 + (upper - lower) / step }, (_, index) => lower + index * step)
  return { min: lower, max: upper, ticks }
})
function y(value: number) {
  return 100 * (scale.value.max - value) / (scale.value.max - scale.value.min)
}
function x(index: number) {
  return 100 * (index + 0.5) / props.points.length
}
const line = computed(() => props.points.map((point, index) => x(index) + ',' + y(point.balance)).join(' '))
const area = computed(() => [x(0) + ',' + y(0), line.value, x(props.points.length - 1) + ',' + y(0)].join(' '))

function pointLabel(point: TrendPoint) {
  const month = formatMonth(point.month)
  if (props.kind === 'balance') return t('statsChart.balancePoint', { month, balance: formatMoney(point.balance) })
  return t('statsChart.spendingPoint', { month, total: formatMoney(point.total), paid: formatMoney(point.paid),
    due: formatMoney(point.due), estimated: formatMoney(point.estimated) })
}

function navigate(event: KeyboardEvent, index: number) {
  const last = props.points.length - 1
  const destinations: Record<string, number> = {
    ArrowLeft: Math.max(0, index - 1), ArrowRight: Math.min(last, index + 1), Home: 0, End: last,
  }
  if (!Object.hasOwn(destinations, event.key)) return
  event.preventDefault()
  const next = destinations[event.key]
  const columns = (event.currentTarget as HTMLButtonElement).parentElement
  columns?.querySelectorAll('button')[next]?.focus()
  emit('select', props.points[next].month)
}
</script>

<template>
  <div v-if="points.length" class="trend-chart" role="group" :aria-label="t('statsChart.' + kind)">
    <div class="chart-key" :aria-label="selected && formatMonth(selected.month)" role="group">
      <template v-if="kind === 'spending'">
        <div v-for="segment in segments" :key="segment.key">
          <span><i :class="segment.key" />{{ t(segment.label) }}</span>
          <strong v-if="selected">{{ formatMoney(selected[segment.key]) }}</strong>
        </div>
      </template>
      <template v-else-if="selected">
        <div><span>{{ t('ledger.salary') }}</span><strong>{{ formatMoney(selected.salary) }}</strong></div>
        <div><span>{{ t('forms.repaymentTotal') }}</span><strong>{{ formatMoney(selected.total) }}</strong></div>
      </template>
    </div>
    <div class="chart-grid">
      <div class="axis" aria-hidden="true">
        <span v-for="tick in scale.ticks" :key="tick" class="axis-width">{{ axisFormat.format(tick / 100) }}</span>
        <span v-for="tick in scale.ticks" :key="'tick-' + tick" class="tick-label" :style="{ top: y(tick) + '%' }">{{ axisFormat.format(tick / 100) }}</span>
      </div>
      <div class="plot">
        <i v-for="tick in scale.ticks" :key="tick" class="grid-line" :class="{ baseline: tick === 0 }" :style="{ top: y(tick) + '%' }" />
        <svg v-if="kind === 'balance'" class="line-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon :points="area" />
          <polyline :points="line" vector-effect="non-scaling-stroke" />
        </svg>
        <div class="month-columns" :class="{ dense: points.length > 6 }" :style="{ gridTemplateColumns: 'repeat(' + points.length + ', minmax(0, 1fr))' }">
          <button v-for="(point, index) in points" :key="point.month" type="button"
            :aria-label="pointLabel(point)" :title="pointLabel(point)" :aria-pressed="point.month === selectedMonth"
            :tabindex="(selected ? point.month === selectedMonth : index === 0) ? 0 : -1"
            @click="emit('select', point.month)" @keydown="navigate($event, index)">
            <span v-if="kind === 'spending' && point.total > 0" class="bar" :style="{ height: (100 - y(point.total)) + '%' }" aria-hidden="true">
              <i v-for="segment in segments" :key="segment.key" :class="segment.key" :style="{ flexGrow: point[segment.key] }" />
            </span>
            <i v-if="kind === 'balance'" class="dot" :class="{ deficit: point.balance < 0 }" :style="{ top: y(point.balance) + '%' }" aria-hidden="true" />
            <span class="month-tick" aria-hidden="true">{{ monthFormat.format(new Date(point.month + '-01T00:00:00Z')) }}</span>
          </button>
        </div>
      </div>
    </div>
    <div v-if="selected" class="readout">
      <time :datetime="selected.month">{{ formatMonth(selected.month) }}</time>
      <strong>{{ formatMoney(kind === 'balance' ? selected.balance : selected.total) }}</strong>
    </div>
  </div>
</template>

<style scoped>
.trend-chart {
  --chart-paid: #28664d;
  --chart-due: #81a99a;
  --chart-estimated: #af844c;
  container-type: inline-size;
  min-width: 0;
  font-variant-numeric: tabular-nums;
}
.chart-key { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; color: var(--sub); font-size: .78rem; }
.chart-key span { display: flex; align-items: baseline; gap: 5px; overflow-wrap: anywhere; }
.chart-key strong { display: block; margin-top: 2px; color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
.chart-key i { flex: none; width: 9px; height: 9px; border-radius: 2px; }
.paid { background: var(--chart-paid); }
.due { background: var(--chart-due); }
.estimated { background: repeating-linear-gradient(135deg, #e0c49b 0 3px, var(--chart-estimated) 3px 5px); }
.chart-grid { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; margin: 19px 0 32px; }
.axis, .plot { position: relative; height: 154px; }
.axis { display: grid; color: var(--sub); font-size: .7rem; }
.axis-width { grid-area: 1 / 1; visibility: hidden; }
.tick-label { position: absolute; right: 0; transform: translateY(-50%); white-space: nowrap; }
.grid-line { position: absolute; inset-inline: 0; border-top: 1px dashed var(--line); }
.grid-line.baseline { border-top: 1px solid #818e83; }
.line-chart, .month-columns { position: absolute; inset: 0; width: 100%; height: 100%; }
.line-chart { overflow: visible; }
.line-chart polygon { fill: #41856b16; }
.line-chart polyline { fill: none; stroke: var(--chart-paid); stroke-width: 2.5; stroke-linejoin: round; }
.month-columns { display: grid; }
.month-columns button {
  min-width: 0;
  position: relative;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--sub);
}
.month-columns button:hover, .month-columns button[aria-pressed="true"] { background: #427d5f0c; }
.month-columns button:focus-visible { z-index: 1; outline: 2px solid var(--green); outline-offset: 0; }
.bar {
  position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column-reverse; overflow: hidden;
  width: 56%; max-width: 40px; border-radius: 3px 3px 0 0;
}
.bar i { flex-basis: 0; }
.dot {
  position: absolute; left: 50%; width: 8px; height: 8px; transform: translate(-50%, -50%);
  border: 2px solid var(--chart-paid); border-radius: 50%; background: var(--surface);
}
.dot.deficit { border-color: #a24e38; }
[aria-pressed="true"] .dot { width: 11px; height: 11px; box-shadow: 0 0 0 2px var(--surface); }
.month-tick { position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%); font-size: .72rem; white-space: nowrap; }
[aria-pressed="true"] .month-tick { color: var(--green); font-weight: 700; }
.readout { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; color: var(--sub); font-size: .82rem; }
.readout strong { color: var(--ink); font-size: .95rem; overflow-wrap: anywhere; }
@container (max-width: 440px) {
  .dense button:nth-child(even) .month-tick { visibility: hidden; }
}
</style>
