<script setup lang="ts">
import { computed, nextTick, ref, shallowRef } from 'vue'
import { Bell, MessageCircle, Plus } from 'lucide-vue-next'
import { displayError, locale, t } from '../../i18n'
import { usePets } from '../pets/usePets'
import { parseLocalReminderTime } from '../reminders/reminderActions'
import { createIntervalRecurrence, createRandomWindowRecurrence, MAX_INTERVAL_MINUTES, parseReminderRecurrence, type ReminderRecurrence } from '../reminders/recurrence'
import { formatReminderRecurrence } from '../reminders/recurrenceFormat'
import { useReminders } from '../reminders/useReminders'
import type { ReminderTask } from '../reminders/reminderService'
import SettingsPageFrame from './SettingsPageFrame.vue'

const { tasks, ready, error, create, edit, cancel, remove, refresh, test } = useReminders()
const { activePet, characters } = usePets()
const formOpen = ref(false)
const original = shallowRef<ReminderTask | null>(null)
let editButton: HTMLButtonElement | null = null
const addButton = ref<HTMLButtonElement | null>(null)
const subjectInput = ref<HTMLTextAreaElement | null>(null)
const subject = ref('')
const channel = ref<'popup' | 'notification'>('popup')
const timing = ref<'now' | 'later'>('now')
const time = ref('')
const frequencies = ['once', 'afterMinutes', 'interval', 'daily', 'weekly', 'monthly', 'randomWindow'] as const
const frequency = ref<typeof frequencies[number]>('once')
const minuteChoices = [10, 20, 30]
const minutes = ref<number | ''>(10)
const presets = [
  { name: 'lunch', startTime: '11:30', endTime: '13:00' },
  { name: 'bedtime', startTime: '22:00', endTime: '23:00' },
] as const
const startTime = ref<string>(presets[0].startTime)
const endTime = ref<string>(presets[0].endTime)
let randomSeed: number | undefined
const clock = ref('09:00')
const weekday = ref(1)
const dayOfMonth = ref<number | ''>(1)
const formAction = ref<'save' | 'test' | null>(null)
const changing = ref<number | null>(null)
const feedback = ref('')
const formError = ref('')
const changeError = ref('')

const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }))
const weekdays = computed(() => {
  const formatter = new Intl.DateTimeFormat(locale.value, { weekday: 'long', timeZone: 'UTC' })
  return Array.from({ length: 7 }, (_, i) => formatter.format(Date.UTC(2024, 0, i + 1)))
})
// An edit keeps the saved wording and character unless the subject changes.
const savedPet = computed(() => characters.value.find(pet => pet.id === original.value?.petId))
const subjectChanged = computed(() => !!original.value && original.value.text !== subject.value.trim())
const petName = computed(() => original.value && !subjectChanged.value ? original.value.petName
  : (savedPet.value ?? activePet.value).name)
function isPending(task: ReminderTask) {
  return ['scheduled', 'preparing', 'editing', 'cancelling'].includes(task.status)
}
function canCancel(task: ReminderTask) {
  return task.status === 'scheduled' || (task.status === 'editing' && !!task.error)
}
const lists = computed(() => [
  tasks.value.filter(isPending).sort((a, b) => a.at - b.at),
  tasks.value.filter(task => !isPending(task)).sort((a, b) => b.at - a.at),
])
function status(task: ReminderTask) {
  if (task.status === 'editing' && task.error) return t('reminders.status.editInterrupted')
  if (task.status !== 'completed') return t('reminders.status.' + task.status)
  if (task.channel === 'popup') return t('reminders.status.popupDone')
  return t(task.scheduled ? 'reminders.status.notificationDue' : 'reminders.status.notificationSent')
}
function localInputValue(at: number) {
  const date = new Date(at)
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
function openForm(task: ReminderTask | null = null, opener?: Event) {
  original.value = task
  editButton = opener?.currentTarget instanceof HTMLButtonElement ? opener.currentTarget : null
  subject.value = task?.text ?? ''
  channel.value = task?.channel ?? 'popup'
  timing.value = task ? 'later' : 'now'
  const anchor = new Date(task?.at ?? Date.now())
  time.value = task ? localInputValue(task.at) : ''
  const rule = task?.recurrence
  frequency.value = rule?.frequency ?? 'once'
  clock.value = rule && 'time' in rule ? rule.time : (task ? time.value.slice(11) : '09:00')
  minutes.value = rule?.frequency === 'interval' ? rule.minutes : 10
  startTime.value = rule?.frequency === 'randomWindow' ? rule.startTime : presets[0].startTime
  endTime.value = rule?.frequency === 'randomWindow' ? rule.endTime : presets[0].endTime
  randomSeed = rule?.frequency === 'randomWindow' ? rule.seed : undefined
  weekday.value = rule?.frequency === 'weekly' ? rule.weekday : anchor.getDay() || 7
  dayOfMonth.value = rule?.frequency === 'monthly' ? rule.dayOfMonth : anchor.getDate()
  formError.value = ''
  changeError.value = ''
  feedback.value = ''
  formOpen.value = true
  void nextTick(() => subjectInput.value?.focus())
}
function closeForm() {
  formOpen.value = false
  original.value = null
  void nextTick(() => (editButton?.isConnected ? editButton : addButton.value)?.focus())
}
function applyPreset(preset: typeof presets[number]) {
  startTime.value = preset.startTime
  endTime.value = preset.endTime
  if (!subject.value.trim() || presets.some(item => subject.value === t('reminders.subject.' + item.name))) {
    subject.value = t('reminders.subject.' + preset.name)
  }
}
function readMinutes(): number {
  const value = minutes.value
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 10 || value % 10 !== 0) {
    throw new Error('REMINDER_INVALID_MINUTES')
  }
  return value
}
function readRule(): ReminderRecurrence | undefined {
  if (timing.value === 'now' || frequency.value === 'once' || frequency.value === 'afterMinutes') return
  const previous = original.value?.recurrence
  if (frequency.value === 'interval') {
    const count = readMinutes()
    if (previous?.frequency === 'interval' && previous.minutes === count) return previous
    return createIntervalRecurrence(count, Date.now())
  }
  if (frequency.value === 'randomWindow') {
    if (startTime.value === endTime.value) throw new Error('REMINDER_EMPTY_WINDOW')
    if (previous?.frequency === 'randomWindow' && previous.startTime === startTime.value && previous.endTime === endTime.value) return previous
    const rule = createRandomWindowRecurrence(startTime.value, endTime.value, randomSeed)
    randomSeed = rule.seed
    return rule
  }
  const rule = { frequency: frequency.value, time: clock.value }
  if (frequency.value === 'weekly') return parseReminderRecurrence({ ...rule, weekday: weekday.value })
  if (frequency.value === 'monthly') return parseReminderRecurrence({ ...rule, dayOfMonth: dayOfMonth.value })
  return parseReminderRecurrence(rule)
}
async function submit() {
  if (formAction.value) return
  formError.value = ''
  feedback.value = ''
  formAction.value = 'save'
  try {
    const previous = original.value
    const recurrence = readRule()
    let at: number | undefined
    if (recurrence && recurrence === previous?.recurrence && previous.at > Date.now()) {
      at = previous.at
    } else if (timing.value === 'later' && frequency.value === 'afterMinutes') {
      at = Date.now() + readMinutes() * 60_000
    } else if (timing.value === 'later' && !recurrence) {
      // Preserve seconds on a Pi-created one-off when only its subject is edited.
      at = previous && !previous.recurrence && time.value === localInputValue(previous.at)
        ? previous.at : parseLocalReminderTime(time.value)
    }
    const input = { channel: channel.value, text: subject.value, at, recurrence, pet: savedPet.value }
    if (previous) {
      await edit(previous.id, input, previous.revision ?? 0)
      feedback.value = 'reminders.updated'
    } else {
      const task = await create(input)
      feedback.value = task.scheduled ? 'reminders.saved' : 'reminders.sent'
      if (!task.scheduled && task.status === 'scheduled') feedback.value = 'reminders.queued'
    }
    closeForm()
  } catch (cause) {
    formError.value = displayError(cause)
  } finally {
    formAction.value = null
  }
}
async function testReminder() {
  if (formAction.value) return
  formAction.value = 'test'
  formError.value = ''
  feedback.value = ''
  try {
    await test({ channel: channel.value, text: subject.value, pet: savedPet.value })
    feedback.value = channel.value === 'popup' ? 'reminders.testedPopup' : 'reminders.testedNotification'
  } catch (cause) {
    formError.value = displayError(cause)
  } finally {
    formAction.value = null
  }
}
async function change(task: ReminderTask) {
  if (changing.value !== null) return
  const cancelling = isPending(task)
  changing.value = task.id
  changeError.value = ''
  feedback.value = ''
  try {
    await (cancelling ? cancel(task.id) : remove(task.id))
    feedback.value = cancelling ? 'reminders.cancelled' : 'reminders.removed'
  } catch (cause) {
    changeError.value = displayError(cause)
  } finally {
    changing.value = null
  }
}
</script>

<template>
  <SettingsPageFrame :title="t('settings.reminders.title')">
    <div v-if="error" class="settings-error" role="alert">
      {{ displayError(error) }}
      <button type="button" class="settings-button" @click="refresh()">{{ t('reminders.retry') }}</button>
    </div>
    <p v-if="!ready && !error" class="settings-muted" role="status">{{ t('reminders.loading') }}</p>
    <section class="settings-sheet" aria-labelledby="upcoming-reminders">
      <div class="section-heading">
        <h2 id="upcoming-reminders">{{ t('reminders.pending') }}</h2>
        <button v-if="!formOpen" ref="addButton" type="button" class="settings-button primary" :disabled="!ready || changing !== null" @click="openForm()">
          <Plus :size="16" aria-hidden="true" /> {{ t('reminders.add') }}
        </button>
      </div>
      <form v-if="formOpen" class="reminder-form" :aria-label="t(original ? 'reminders.edit' : 'reminders.add')" @submit.prevent="submit">
        <fieldset :disabled="!!formAction">
          <h3 v-if="original">{{ t('reminders.edit') }}</h3>
          <label class="field">
            <span>{{ t('reminders.subject') }}</span>
            <textarea ref="subjectInput" v-model="subject" rows="2" name="subject" :placeholder="t('reminders.subjectHint')" />
          </label>
          <fieldset class="choices">
            <legend>{{ t('reminders.channel') }}</legend>
            <label><input v-model="channel" type="radio" name="channel" value="popup" />{{ t('reminders.popup') }}</label>
            <label><input v-model="channel" type="radio" name="channel" value="notification" />{{ t('reminders.notification') }}</label>
            <p class="settings-muted">{{ t(channel === 'popup' ? 'reminders.popupHint' : 'reminders.notificationHint') }}</p>
          </fieldset>
          <fieldset v-if="!original" class="choices">
            <legend>{{ t('reminders.timing') }}</legend>
            <label><input v-model="timing" type="radio" name="timing" value="now" />{{ t('reminders.now') }}</label>
            <label><input v-model="timing" type="radio" name="timing" value="later" />{{ t('reminders.later') }}</label>
          </fieldset>
          <template v-if="timing === 'later'">
            <label class="field">
              <span>{{ t('reminders.repeat') }}</span>
              <select v-model="frequency" name="frequency">
                <option v-for="option in frequencies" :key="option" :value="option">{{ t('reminders.frequency.' + option) }}</option>
              </select>
            </label>
            <label v-if="frequency === 'once'" class="field">
              <span>{{ t('reminders.localTime') }}</span>
              <input v-model="time" type="datetime-local" name="at" required />
            </label>
            <div v-else-if="frequency === 'interval' || frequency === 'afterMinutes'" class="minute-fields">
              <label class="field">
                <span>{{ t(frequency === 'interval' ? 'reminders.intervalMinutes' : 'reminders.delayMinutes') }}</span>
                <input v-model.number="minutes" type="number" name="minutes" inputmode="numeric" min="10"
                  :max="frequency === 'interval' ? MAX_INTERVAL_MINUTES : undefined" step="10" required aria-describedby="minute-step" />
                <small id="minute-step" class="settings-muted">{{ t(frequency === 'interval' ? 'reminders.intervalStep' : 'reminders.delayStep') }}</small>
              </label>
              <div class="shortcuts">
                <button v-for="amount in minuteChoices" :key="amount" type="button" class="settings-button"
                  :data-minutes="amount" :aria-pressed="minutes === amount" @click="minutes = amount">
                  {{ t('reminders.minutes', { minutes: amount }) }}
                </button>
              </div>
            </div>
            <template v-else-if="frequency === 'randomWindow'">
              <div class="shortcuts" role="group" :aria-label="t('reminders.presets')">
                <button v-for="preset in presets" :key="preset.name" type="button" class="settings-button" name="preset"
                  :value="preset.name" @click="applyPreset(preset)">{{ t('reminders.preset.' + preset.name) }}</button>
              </div>
              <div class="window-times">
                <label class="field">
                  <span>{{ t('reminders.windowStart') }}</span>
                  <input v-model="startTime" type="time" name="startTime" required />
                </label>
                <label class="field">
                  <span>{{ t(startTime && endTime && endTime < startTime ? 'reminders.windowEndNextDay' : 'reminders.windowEnd') }}</span>
                  <input v-model="endTime" type="time" name="endTime" required />
                </label>
              </div>
              <p class="settings-muted">{{ t('reminders.windowHint') }}</p>
            </template>
            <template v-else>
              <label v-if="frequency === 'weekly'" class="field">
                <span>{{ t('reminders.weekday') }}</span>
                <select v-model="weekday" name="weekday">
                  <option v-for="(name, i) in weekdays" :key="i" :value="i + 1">{{ name }}</option>
                </select>
              </label>
              <label v-if="frequency === 'monthly'" class="field">
                <span>{{ t('reminders.dayOfMonth') }}</span>
                <input v-model.number="dayOfMonth" type="number" name="dayOfMonth" min="1" max="31" step="1" required
                  :aria-describedby="Number(dayOfMonth) > 28 ? 'month-skip-hint' : undefined" />
                <small v-if="Number(dayOfMonth) > 28" id="month-skip-hint" class="settings-muted">{{ t('reminders.shortMonths') }}</small>
              </label>
              <label class="field">
                <span>{{ t('reminders.localTime') }}</span>
                <input v-model="clock" type="time" name="time" required />
              </label>
            </template>
          </template>
          <div class="companion-info">
            <span>{{ t('reminders.pet') }} · <span v-if="original">{{ petName }}</span><RouterLink v-else :to="{ name: 'settings-pets' }">{{ petName }}</RouterLink></span>
            <p v-if="subjectChanged && !savedPet" class="settings-muted">{{ t('reminders.petReplaced') }}</p>
            <p class="settings-muted">{{ t('reminders.wording') }}</p>
          </div>
          <p v-if="formError" class="settings-error" role="alert">{{ formError }}</p>
          <div class="settings-actions">
            <button type="submit" class="settings-button primary">{{ t(formAction === 'save' ? 'reminders.saving' : original ? 'reminders.saveChanges' : timing === 'later' ? 'reminders.schedule' : 'reminders.send') }}</button>
            <button type="button" class="settings-button" name="testReminder" @click="testReminder">{{ t(formAction === 'test' ? 'reminders.testing' : 'reminders.test') }}</button>
            <button type="button" class="settings-button" @click="closeForm">{{ t(original ? 'reminders.cancelChanges' : 'reminders.closeForm') }}</button>
          </div>
        </fieldset>
      </form>
      <p v-if="feedback" class="settings-muted" role="status">{{ t(feedback) }}</p>
      <p v-if="changeError" class="settings-error" role="alert">{{ changeError }}</p>
      <template v-for="(list, index) in lists" :key="index">
        <h2 v-if="index && list.length" class="history-heading">{{ t('reminders.history', { count: list.length }) }}</h2>
        <ul v-if="list.length" class="reminder-list">
          <li v-for="task in list" :key="task.id">
            <component :is="task.channel === 'popup' ? MessageCircle : Bell" :size="19" aria-hidden="true" class="task-icon" />
            <div class="task-data">
              <h3>{{ task.text || task.message || task.petName }}</h3>
              <p>{{ t('reminders.' + task.channel) }} · {{ task.petName }} · {{ status(task) }}</p>
              <p v-if="task.recurrence">{{ formatReminderRecurrence(task.recurrence) }}</p>
              <p><span v-if="task.recurrence && !index">{{ t('reminders.next') }} </span><time :datetime="new Date(task.at).toISOString()">{{ dateFormat.format(task.at) }}</time></p>
              <p v-if="task.error" class="settings-error">{{ displayError(task.error) }}</p>
            </div>
            <div class="task-actions">
              <button v-if="task.status === 'scheduled' && task.scheduled" type="button" class="task-action"
                :disabled="formOpen || changing !== null" :aria-label="t('reminders.edit') + ' · ' + (task.text || task.message || task.petName)"
                @click="openForm(task, $event)">{{ t('reminders.edit') }}</button>
              <button type="button" class="task-action" :disabled="formOpen || changing !== null || (!index && !canCancel(task))"
                :aria-label="t(index ? 'reminders.remove' : 'reminders.cancel') + ' · ' + (task.text || task.message || task.petName)"
                @click="change(task)">{{ t(index ? 'reminders.remove' : 'reminders.cancel') }}</button>
            </div>
          </li>
        </ul>
        <p v-else-if="!index && ready" class="settings-muted">{{ t('reminders.empty') }}</p>
      </template>
    </section>
  </SettingsPageFrame>
</template>

<style scoped>
.section-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; }
.reminder-form { min-width: 0; padding-block: 14px; border-block: 1px solid var(--line); }
.reminder-form fieldset { margin: 0; padding: 0; min-width: 0; border: 0; }
.reminder-form > fieldset { display: grid; gap: 14px; }
.field { min-width: 0; display: grid; gap: 5px; }
.field > span, .choices legend { font-size: .88rem; font-weight: 650; }
.field textarea, .field input, .field select { margin: 0; width: 100%; min-width: 0; max-width: 100%; min-height: 44px; border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; background: var(--paper); color: var(--ink); font: inherit; }
.field textarea { resize: vertical; }
.minute-fields { display: grid; gap: 8px; }
.shortcuts { display: flex; flex-wrap: wrap; gap: 8px; }
.shortcuts [aria-pressed="true"] { border-color: var(--green); color: var(--green); }
.window-times { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr)); gap: 12px; }
.choices label { display: inline-flex; align-items: center; gap: 7px; min-height: 44px; margin-inline-end: 16px; cursor: pointer; }
.choices input { accent-color: var(--accent-solid); }
.companion-info { display: grid; gap: 2px; font-size: .88rem; }
.companion-info a, .task-action { color: var(--green); }
.reminder-list { list-style: none; margin: 0; padding: 0; }
.reminder-list li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 10px; padding-block: 12px; }
.reminder-list li + li, .history-heading { border-top: 1px solid var(--line); }
.history-heading { padding-top: 16px; }
.task-icon { margin-block-start: 3px; color: var(--green); }
.task-data { min-width: 0; overflow-wrap: anywhere; }
.task-data p, .task-data time { color: var(--sub); font-size: .84rem; line-height: 1.55; }
.task-data .settings-error { color: var(--danger-ink); }
.task-actions { display: flex; flex-wrap: wrap; gap: 0 10px; align-items: center; }
.task-action { background: transparent; border: 0; min-height: 44px; padding-inline: 3px; font-size: .84rem; cursor: pointer; }
.task-action:disabled { opacity: .55; cursor: default; }
.task-action:hover { text-decoration: underline; }
@media (max-width: 520px) { .task-actions { grid-column: 2 / -1; justify-self: start; } }
</style>
