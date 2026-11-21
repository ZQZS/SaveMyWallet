<script setup lang="ts">
import { RouterView } from 'vue-router'
import AppShell from './app/layout/AppShell.vue'
import PetReminderPopup from './features/reminders/PetReminderPopup.vue'
</script>

<template>
  <AppShell>
    <RouterView />
  </AppShell>
  <PetReminderPopup />
</template>
