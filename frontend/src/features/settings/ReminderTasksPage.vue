<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Bell, MessageCircle, Plus } from 'lucide-vue-next'
import { displayError, locale, t } from '../../i18n'
import { usePets } from '../pets/usePets'
import { parseLocalReminderTime } from '../reminders/reminderActions'
import { useReminders } from '../reminders/useReminders'
import type { ReminderTask } from '../reminders/reminderService'
import SettingsPageFrame from './SettingsPageFrame.vue'

const { tasks, ready, error, create, cancel, remove, refresh } = useReminders()
const { activePet } = usePets()
const formOpen = ref(false)
const addButton = ref<HTMLButtonElement | null>(null)
const subjectInput = ref<HTMLTextAreaElement | null>(null)
const subject = ref('')
const channel = ref<'popup' | 'notification'>('popup')
const timing = ref<'now' | 'later'>('now')
const time = ref('')
const saving = ref(false)
const changing = ref<number | null>(null)
const feedback = ref('')
const formError = ref('')
const changeError = ref('')

const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }))
function isPending(task: ReminderTask) {
  return task.status === 'scheduled' || task.status === 'preparing' || task.status === 'cancelling'
}
const lists = computed(() => [
  tasks.value.filter(isPending).sort((a, b) => a.at - b.at),
  tasks.value.filter(task => !isPending(task)).sort((a, b) => b.at - a.at),
])
function status(task: ReminderTask) {
  if (task.status !== 'completed') return t('reminders.status.' + task.status)
  if (task.channel === 'popup') return t('reminders.status.popupDone')
  return t(task.scheduled ? 'reminders.status.notificationDue' : 'reminders.status.notificationSent')
}
function toggleForm() {
  formOpen.value = !formOpen.value
  formError.value = ''
  feedback.value = ''
  void nextTick(() => (formOpen.value ? subjectInput.value : addButton.value)?.focus())
}
async function submit() {
  if (saving.value) return
  formError.value = ''
  feedback.value = ''
  saving.value = true
  try {
    const at = timing.value === 'later' ? parseLocalReminderTime(time.value) : undefined
    const task = await create({ channel: channel.value, text: subject.value, at })
    formOpen.value = false
    subject.value = ''
    time.value = ''
    timing.value = 'now'
    feedback.value = task.scheduled ? 'reminders.saved' : 'reminders.sent'
    if (!task.scheduled && task.status === 'scheduled') feedback.value = 'reminders.queued'
    void nextTick(() => addButton.value?.focus())
  } catch (cause) {
    formError.value = displayError(cause)
  } finally {
    saving.value = false
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
        <button v-if="!formOpen" ref="addButton" type="button" class="settings-button primary" :disabled="!ready" @click="toggleForm">
          <Plus :size="16" aria-hidden="true" /> {{ t('reminders.add') }}
        </button>
      </div>
      <form v-if="formOpen" class="reminder-form" :aria-label="t('reminders.add')" @submit.prevent="submit">
        <fieldset :disabled="saving">
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
          <fieldset class="choices">
            <legend>{{ t('reminders.timing') }}</legend>
            <label><input v-model="timing" type="radio" name="timing" value="now" />{{ t('reminders.now') }}</label>
            <label><input v-model="timing" type="radio" name="timing" value="later" />{{ t('reminders.later') }}</label>
          </fieldset>
          <label v-if="timing === 'later'" class="field">
            <span>{{ t('reminders.localTime') }}</span>
            <input v-model="time" type="datetime-local" name="at" required />
          </label>
          <div class="companion-info">
            <span>{{ t('reminders.pet') }} · <RouterLink :to="{ name: 'settings-pets' }">{{ activePet.name }}</RouterLink></span>
            <p class="settings-muted">{{ t('reminders.wording') }}</p>
          </div>
          <p v-if="formError" class="settings-error" role="alert">{{ formError }}</p>
          <div class="settings-actions">
            <button type="submit" class="settings-button primary">{{ t(saving ? 'reminders.saving' : timing === 'later' ? 'reminders.schedule' : 'reminders.send') }}</button>
            <button type="button" class="settings-button" @click="toggleForm">{{ t('reminders.closeForm') }}</button>
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
              <time :datetime="new Date(task.at).toISOString()">{{ dateFormat.format(task.at) }}</time>
              <p v-if="task.error" class="settings-error">{{ displayError(task.error) }}</p>
            </div>
            <button type="button" class="task-action" :disabled="changing !== null || task.status === 'preparing' || task.status === 'cancelling'"
              :aria-label="t(index ? 'reminders.remove' : 'reminders.cancel') + ' · ' + (task.text || task.message || task.petName)"
              @click="change(task)">{{ t(index ? 'reminders.remove' : 'reminders.cancel') }}</button>
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
.field textarea, .field input { margin: 0; width: 100%; min-width: 0; max-width: 100%; min-height: 44px; border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; background: var(--paper); color: var(--ink); font: inherit; }
.field textarea { resize: vertical; }
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
.task-action { align-self: center; background: transparent; border: 0; min-height: 44px; padding-inline: 3px; font-size: .84rem; cursor: pointer; }
.task-action:hover { text-decoration: underline; }
@media (max-width: 440px) { .task-action { grid-column: 2; justify-self: start; } }
</style>
