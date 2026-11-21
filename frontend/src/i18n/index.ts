import { readonly, ref } from 'vue'
import { appMessages } from './messages/app.ts'
import { formsMessages } from './messages/forms.ts'
import { ledgerMessages } from './messages/ledger.ts'
import { statisticsMessages } from './messages/statistics.ts'
import { settingsMessages } from './messages/settings.ts'
import { aiErrorMessages } from './messages/aiErrors.ts'
import { aiMonthMessages } from './messages/aiMonth.ts'
import { billImageMessages } from './messages/billImage.ts'
import { ledgerSearchMessages } from './messages/ledgerSearch.ts'
import { noticeMessages } from './messages/notice.ts'
import { petsLedgerMessages } from './messages/petsLedger.ts'
import { petsPickerMessages } from './messages/petsPicker.ts'
import { petsChatMessages } from './messages/petsChat.ts'

export const languageOptions = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
] as const
export type AppLocale = typeof languageOptions[number]['value']
const preferenceKey = 'savemywallet.locale'

const catalogs: Record<AppLocale, Record<string, string>> = {
  'zh-CN': { ...appMessages['zh-CN'], ...formsMessages['zh-CN'], ...ledgerMessages['zh-CN'], ...settingsMessages['zh-CN'],
    ...statisticsMessages['zh-CN'],
    ...aiErrorMessages['zh-CN'], ...aiMonthMessages['zh-CN'], ...billImageMessages['zh-CN'],
    ...ledgerSearchMessages['zh-CN'], ...noticeMessages['zh-CN'], ...petsLedgerMessages['zh-CN'], ...petsPickerMessages['zh-CN'], ...petsChatMessages['zh-CN'] },
  'en-US': { ...appMessages['en-US'], ...formsMessages['en-US'], ...ledgerMessages['en-US'], ...settingsMessages['en-US'],
    ...statisticsMessages['en-US'],
    ...aiErrorMessages['en-US'], ...aiMonthMessages['en-US'], ...billImageMessages['en-US'],
    ...ledgerSearchMessages['en-US'], ...noticeMessages['en-US'], ...petsLedgerMessages['en-US'], ...petsPickerMessages['en-US'], ...petsChatMessages['en-US'] },
}

function savedLocale(): AppLocale {
  try {
    return localStorage.getItem(preferenceKey) === 'en-US' ? 'en-US' : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

const current = ref<AppLocale>(savedLocale())
export const locale = readonly(current)

export function setLocale(value: AppLocale) {
  if (!languageOptions.some(option => option.value === value)) return
  current.value = value
  try {
    localStorage.setItem(preferenceKey, value)
  } catch {
    // A WebView without preference storage still supports switching for this session.
  }
}

export function t(key: string, values: Record<string, string | number> = {}): string {
  const text = catalogs[current.value][key] ?? catalogs['zh-CN'][key] ?? key
  return text.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(values, name) ? String(values[name]) : match)
}

const currencies = Object.fromEntries(languageOptions.map(({ value }) => [value, new Intl.NumberFormat(value, {
  style: 'currency', currency: 'CNY', currencyDisplay: 'symbol', minimumFractionDigits: 0, maximumFractionDigits: 2,
})]))
const englishMonth = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' })

export function formatMoney(cents: number): string {
  return currencies[current.value].format(cents / 100)
}

export function formatMonth(month: string): string {
  const [year, number] = month.split('-').map(Number)
  return current.value === 'zh-CN' ? year + ' 年 ' + number + ' 月' : englishMonth.format(new Date(Date.UTC(year, number - 1, 1)))
}

// Existing native commands also return human-readable v1 messages.
const englishNativeErrors: Record<string, string> = {
  '账本版本较新，请升级应用后重试。': 'This ledger requires a newer version of SaveMyWallet.',
  '请选择 1900 年至 2099 年间有效的还款月份。': 'Choose a valid repayment month between 1900 and 2099.',
  '金额超出允许范围，请检查后重试。': 'The amount is outside the supported range.',
  '请填写 1 到 120 个字的款项名称。': 'Enter an item name of 1 to 120 characters.',
  '请填写 1 到 40 个字的平台名称。': 'Enter a platform name of 1 to 40 characters.',
  '同名平台已存在，可直接选择。': 'This platform already exists. Select it from the list.',
  '分期期数应为 1 到 120。': 'Enter between 1 and 120 installments.',
  '未知的账单类型。': 'Unknown bill type.',
  '最后一期超出支持的还款月份。': 'The last installment is outside the supported date range.',
  '所选还款平台不存在，请重新选择。': 'The platform no longer exists. Select another one.',
  '这笔补款已确认或已不存在，请刷新账本。': 'This estimate has already been confirmed or removed. Reload the ledger.',
  '账本连接已中断，请重新打开应用。': 'The database connection was interrupted. Reopen the app.',
  '无法连接本地账本': 'Could not connect to the local ledger.',
  '无法创建账本目录': 'Could not create the ledger folder',
  '无法打开本地账本': 'Could not open the local ledger',
  '无法载入账本': 'Could not load the ledger',
}

export function displayError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  if (raw.startsWith('SYNC_SERVER:')) return t('error.SYNC_SERVER') + ' (' + raw.slice('SYNC_SERVER:'.length) + ')'
  if (Object.hasOwn(catalogs[current.value], 'error.' + raw)) return t('error.' + raw)
  if (current.value === 'en-US') {
    if (englishNativeErrors[raw]) return englishNativeErrors[raw]
    const separator = raw.indexOf('：')
    const prefix = englishNativeErrors[raw.slice(0, separator)]
    if (separator > 0 && prefix) return prefix + ': ' + displayError(raw.slice(separator + 1))
  }
  return raw
}
