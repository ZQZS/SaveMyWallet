import assert from 'node:assert/strict'
import test from 'node:test'
import { displayError, formatMoney, formatMonth, setLocale, t } from '../src/i18n/index.ts'
import { appMessages } from '../src/i18n/messages/app.ts'
import { formsMessages } from '../src/i18n/messages/forms.ts'
import { ledgerMessages } from '../src/i18n/messages/ledger.ts'
import { settingsMessages } from '../src/i18n/messages/settings.ts'
import { aiErrorMessages } from '../src/i18n/messages/aiErrors.ts'
import { aiMonthMessages } from '../src/i18n/messages/aiMonth.ts'
import { billImageMessages } from '../src/i18n/messages/billImage.ts'
import { ledgerSearchMessages } from '../src/i18n/messages/ledgerSearch.ts'
import { noticeMessages } from '../src/i18n/messages/notice.ts'
import { petsLedgerMessages } from '../src/i18n/messages/petsLedger.ts'
import { petsPickerMessages } from '../src/i18n/messages/petsPicker.ts'
import { petsChatMessages } from '../src/i18n/messages/petsChat.ts'

function parameters(text) {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort()
}

test('两个语言目录对每个界面消息使用相同的键和参数', () => {
  const allKeys = new Set()
  for (const group of [appMessages, formsMessages, ledgerMessages, settingsMessages, aiErrorMessages, aiMonthMessages, billImageMessages, ledgerSearchMessages, noticeMessages, petsLedgerMessages, petsPickerMessages, petsChatMessages]) {
    assert.deepEqual(Object.keys(group['en-US']).sort(), Object.keys(group['zh-CN']).sort())
    for (const [key, chinese] of Object.entries(group['zh-CN'])) {
      assert.ok(!allKeys.has(key), 'Duplicate translation key: ' + key)
      allKeys.add(key)
      assert.ok(chinese.trim() && group['en-US'][key].trim(), key)
      assert.deepEqual(parameters(chinese), parameters(group['en-US'][key]), key)
    }
  }
})

test('切换语言更新月份、人民币和错误文本，两种语言都要求输入同一重置词', () => {
  try {
    setLocale('en-US')
    assert.equal(formatMonth('2026-11'), 'November 2026')
    assert.match(formatMoney(123456), /¥1,234\.56/)
    assert.equal(t('nav.settings'), 'Settings')
    assert.match(t('settings.reset.type', { phrase: '重置' }), /重置/)
    assert.match(displayError('BACKUP_INVALID'), /backup/i)
    setLocale('zh-CN')
    assert.equal(t('nav.settings'), '系统设置')
    assert.equal(formatMonth('2026-11'), '2026 年 11 月')
    assert.match(t('settings.reset.type', { phrase: '重置' }), /重置/)
    assert.match(displayError('BACKUP_INVALID'), /备份/)
  } finally {
    setLocale('zh-CN')
  }
})
