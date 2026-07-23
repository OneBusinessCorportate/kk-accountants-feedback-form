import { describe, it, expect } from 'vitest'
import {
  normalizeLanguage,
  languageFromChatName,
  resolveLanguage,
  extractTelegramId,
  toBotApiChatId,
  monthName,
  periodLabel,
  fillTemplate,
  composeMailing,
  formatAmount,
  currentPeriod,
  autoSendWarning,
  expandSchedule,
  mailingKey,
  coveredMailingKeys,
  isCovered,
  manualAssetReady,
  sendability,
  pickDemoMailings,
} from './notifications'
import { classifyMailingStatus } from './dashboard'
import { CATEGORY_DEFAULT_DAY } from './templates'

describe('language resolution (req 4)', () => {
  it('canonicalises codes', () => {
    expect(normalizeLanguage('ru')).toBe('RU')
    expect(normalizeLanguage('HY')).toBe('AM')
    expect(normalizeLanguage('en')).toBe('ENG')
    expect(normalizeLanguage('ENG')).toBe('ENG')
    expect(normalizeLanguage('??')).toBeNull()
  })
  it('reads the language suffix from a chat name', () => {
    expect(languageFromChatName('B-4701 <Гадаев> ИП RU')).toBe('RU')
    expect(languageFromChatName('B-4770 <Նուռ Սթոր> ՍՊԸ AM')).toBe('AM')
    expect(languageFromChatName('B-4608 <3ам> Սրահ ՍՊԸ ENG')).toBe('ENG')
    expect(languageFromChatName('ARMOND YERUMYAN LLC')).toBeNull()
  })
  it('prefers the stored language, then the name, then RU', () => {
    expect(resolveLanguage({ storedLanguage: 'AM', chatName: 'X RU' })).toBe('AM')
    expect(resolveLanguage({ chatName: 'X RU' })).toBe('RU')
    expect(resolveLanguage({ chatName: 'no marker' })).toBe('RU')
  })
})

describe('telegram id extraction', () => {
  it('pulls and normalises the id from a web link', () => {
    expect(extractTelegramId('https://web.telegram.org/a/#-5171468893')).toBe('5171468893')
    expect(extractTelegramId('https://web.telegram.org/k/#-1004978043895')).toBe('4978043895')
    expect(extractTelegramId('t.me/joinchat/xyz')).toBeNull()
    expect(extractTelegramId(null)).toBeNull()
  })
  it('builds a supergroup bot chat id', () => {
    expect(toBotApiChatId('5171468893')).toBe('-1005171468893')
    expect(toBotApiChatId('-5225180694')).toBe('-5225180694')
  })
})

describe('template rendering', () => {
  it('resolves month names per language', () => {
    expect(monthName('202607', 'RU')).toBe('июля')
    expect(monthName('202607', 'ENG')).toBe('July')
    expect(monthName('bad')).toBe('')
  })
  it('formats period label', () => {
    expect(periodLabel('202607')).toBe('07/2026')
  })
  it('fills placeholders and never leaks a missing one', () => {
    expect(fillTemplate('a {{x}} b {{y}}', { x: '1' })).toBe('a 1 b ')
  })
  it('composes a debts message with amount + due day', () => {
    const msg = composeMailing({
      category: 'debts',
      subtype: 'service_payment',
      language: 'RU',
      ctx: { period: '202607', amount: 40000 },
    })
    expect(msg).toContain('40 000 AMD')
    expect(msg).toContain('07/2026')
    expect(msg).toContain(`до ${CATEGORY_DEFAULT_DAY.debts} числа`)
  })
  it('leaves a blank amount slot rather than 0 when unknown', () => {
    const msg = composeMailing({ category: 'debts', subtype: 'reminder', language: 'RU', ctx: { period: '202607' } })
    expect(msg).toContain('__________')
  })
  it('returns null for an unknown template', () => {
    expect(composeMailing({ category: 'nope', subtype: 'x' })).toBeNull()
  })
  it('formats amounts', () => {
    expect(formatAmount(99999)).toBe('99 999 AMD')
  })
})

describe('auto-send warning (req 3)', () => {
  it('states the message is automatic and time is fixed', () => {
    const w = autoSendWarning('2026-07-28T07:00:00Z', 'RU')
    expect(w).toContain('автоматически')
    expect(w).toContain('изменить время нельзя')
  })
})

describe('30-day chain expansion (req 3)', () => {
  const today = new Date('2026-07-23T00:00:00+04:00')
  const rows = [
    { category: 'debts', subtype: 'service_payment', day_of_month: 5, enabled: true },
    { category: 'salary', subtype: 'table', day_of_month: 10, enabled: true },
    { category: 'main_taxes', subtype: 'report', day_of_month: 15, enabled: true },
    { category: 'primary_docs', subtype: 'request', day_of_month: 28, enabled: true },
    { category: 'debts', subtype: 'reminder', day_of_month: 5, enabled: false },
  ]
  it('includes at least one of every enabled category within 30 days', () => {
    const chain = expandSchedule(rows, { today, horizonDays: 30 })
    const cats = new Set(chain.map((c) => c.category))
    expect(cats.has('debts')).toBe(true)
    expect(cats.has('salary')).toBe(true)
    expect(cats.has('main_taxes')).toBe(true)
    expect(cats.has('primary_docs')).toBe(true)
  })
  it('skips disabled rows', () => {
    const chain = expandSchedule(rows, { today, horizonDays: 30 })
    expect(chain.some((c) => c.subtype === 'reminder')).toBe(false)
  })
  it('is sorted ascending by scheduled time', () => {
    const chain = expandSchedule(rows, { today, horizonDays: 30 })
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].scheduledAt >= chain[i - 1].scheduledAt).toBe(true)
    }
  })
})

describe('dedup against mqa_chat_mailings (never double-send)', () => {
  const rows = [
    { agr_no: 'B-100', period: '202607', category: 'salary', status: 'Получил', source: 'telegram', confirmed: false },
    { agr_no: 'В-100', period: '202607', category: 'debts', status: 'Не отправил', source: 'telegram', confirmed: false },
    { agr_no: 'B-200', period: '202607', category: 'main_taxes', status: 'что-то', source: 'manual', confirmed: false },
  ]
  const covered = coveredMailingKeys(rows, classifyMailingStatus)
  it('treats a done status as covered', () => {
    expect(isCovered(covered, 'B-100', '202607', 'salary')).toBe(true)
  })
  it('treats a manual send as covered regardless of status', () => {
    expect(isCovered(covered, 'B-200', '202607', 'main_taxes')).toBe(true)
  })
  it('does not cover a pending row', () => {
    expect(isCovered(covered, 'B-100', '202607', 'debts')).toBe(false)
  })
  it('matches Cyrillic/Latin contract twins', () => {
    expect(mailingKey('B-100', '202607', 'salary')).toBe(mailingKey('В-100', '202607', 'salary'))
  })
})

describe('manual-asset gating (req 2)', () => {
  const assets = [
    { agr_no: 'B-1', period: '202607', kind: 'salary_sheet', storage_path: 'x/y.xlsx', marked_done: false },
    { agr_no: 'B-2', period: '202607', kind: 'tax_report', storage_path: null, marked_done: true },
  ]
  it('is ready when a file is attached', () => {
    expect(manualAssetReady(assets, 'B-1', '202607', 'salary_sheet')).toBe(true)
  })
  it('is ready when marked done without a file', () => {
    expect(manualAssetReady(assets, 'B-2', '202607', 'tax_report')).toBe(true)
  })
  it('is not ready for a different period', () => {
    expect(manualAssetReady(assets, 'B-1', '202608', 'salary_sheet')).toBe(false)
  })
})

describe('sendability', () => {
  const coveredKeys = coveredMailingKeys(
    [{ agr_no: 'B-9', period: '202607', category: 'primary_docs', status: 'Получил', source: 'telegram' }],
    classifyMailingStatus,
  )
  const assets = [{ agr_no: 'B-9', period: '202607', kind: 'salary_sheet', marked_done: true }]
  it('reports covered when already done', () => {
    expect(sendability({ agrNo: 'B-9', period: '202607', category: 'primary_docs' }, { coveredKeys, assets })).toBe('covered')
  })
  it('reports awaiting_file when the salary sheet is missing', () => {
    expect(sendability({ agrNo: 'B-8', period: '202607', category: 'salary' }, { coveredKeys, assets: [] })).toBe('awaiting_file')
  })
  it('reports ready for an auto category with nothing outstanding', () => {
    expect(sendability({ agrNo: 'B-8', period: '202607', category: 'debts' }, { coveredKeys, assets: [] })).toBe('ready')
  })
  it('reports ready for salary once its file is present', () => {
    expect(sendability({ agrNo: 'B-9', period: '202607', category: 'salary' }, { coveredKeys, assets })).toBe('ready')
  })
})

describe('demo selection (today-only, test chat)', () => {
  const candidates = [
    { agr_no: 'B-1', chat_name: 'A RU', language: 'RU' },
    { agr_no: 'B-2', chat_name: 'B AM' },
    { agr_no: 'B-3', chat_name: 'C ENG' },
    { agr_no: 'B-4', chat_name: 'D RU' },
    { agr_no: 'B-5', chat_name: 'E AM' },
    { agr_no: 'B-6', chat_name: 'F RU' },
  ]
  it('picks the requested count with distinct mailing types', () => {
    const picks = pickDemoMailings(candidates, { count: 5 })
    expect(picks).toHaveLength(5)
    const types = new Set(picks.map((p) => `${p.category}:${p.subtype}`))
    expect(types.size).toBe(5)
  })
  it('resolves each pick to a language', () => {
    const picks = pickDemoMailings(candidates, { count: 5 })
    expect(picks.every((p) => ['RU', 'AM', 'ENG'].includes(p.language))).toBe(true)
    expect(picks.map((p) => p.language)).toContain('AM')
    expect(picks.map((p) => p.language)).toContain('ENG')
  })
})

describe('currentPeriod (mqa 28th cutoff)', () => {
  it('rolls the period on the 28th', () => {
    expect(currentPeriod('2026-07-23T09:00:00+04:00')).toBe('202607')
    expect(currentPeriod('2026-07-28T09:00:00+04:00')).toBe('202608')
    expect(currentPeriod('2026-12-29T09:00:00+04:00')).toBe('202701')
  })
})

describe('expandSchedule month-overflow (day > 28)', () => {
  it('does not skip a short month for a day-31 schedule', () => {
    const today = new Date('2026-01-15T00:00:00+04:00')
    const rows = [{ category: 'debts', subtype: 'reminder', day_of_month: 31, enabled: true }]
    const chain = expandSchedule(rows, { today, horizonDays: 90 })
    // Jan 31, Feb 28 (clamped), Mar 31 must all appear — Feb must NOT be
    // skipped (the old setMonth overflow turned Jan 31 +1 into early March).
    const months = chain.map((c) => c.scheduledAt.getMonth()) // 0,1,2
    expect(months).toContain(0)
    expect(months).toContain(1)
    expect(months).toContain(2)
  })
})
