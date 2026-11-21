import { BookOpen, ChartColumnIncreasing, Layers3, Settings, SlidersHorizontal } from 'lucide-vue-next'

export const menuItems = [
  { name: 'ledger', label: 'nav.ledger', icon: BookOpen },
  { name: 'platforms', label: 'nav.platforms', icon: Layers3 },
  { name: 'statistics', label: 'nav.statistics', icon: ChartColumnIncreasing },
  { name: 'budget', label: 'nav.budget', icon: SlidersHorizontal },
  { name: 'settings', label: 'nav.settings', icon: Settings },
] as const

export type MenuName = typeof menuItems[number]['name']
