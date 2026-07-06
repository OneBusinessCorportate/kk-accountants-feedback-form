import { describe, it, expect } from 'vitest'
import {
  SONA_SOURCE,
  MARGARITA_SOURCE,
  INGEST_STATUS,
  sonaProblemId,
  margaritaProblemId,
  sonaPriority,
  margaritaPriority,
  mapSonaTicket,
  mapMargaritaViolation,
  UPSERT_REFRESH_COLUMNS,
  ACCOUNTANT_ALIASES,
  normalizeAccountant,
  resolveAccountant,
  QA_SOURCE,
  QA_PROBLEM_TITLES,
  telegramChatLink,
  qaProblemId,
  unansweredPriority,
  mapUnansweredChat,
  mapLateChat,
  mapOverduePromise,
  isUnansweredUncertain,
  extractMentions,
  mapUncertainUnanswered,
  qaKind,
} from './ingestion'
import { SOURCES, STATUS } from './constants'

describe('problem_id derivation', () => {
  it('prefixes each source so ids are globally unique', () => {
    expect(sonaProblemId('abc')).toBe('sona:abc')
    expect(margaritaProblemId('abc')).toBe('margarita:abc')
    // Same underlying record id from different sources must not collide.
    expect(sonaProblemId('123')).not.toBe(margaritaProblemId('123'))
  })

  it('is stable: same source record → same id on re-runs', () => {
    expect(sonaProblemId('t-1')).toBe(sonaProblemId('t-1'))
    expect(margaritaProblemId('v-1')).toBe(margaritaProblemId('v-1'))
  })
})

describe('priority mapping', () => {
  it('maps Sona urgent/critical to high (1), else medium (2)', () => {
    expect(sonaPriority({ urgent: true })).toBe(1)
    expect(sonaPriority({ priority: 'critical' })).toBe(1)
    expect(sonaPriority({ priority: 'medium' })).toBe(2)
    expect(sonaPriority({})).toBe(2)
  })

  it('maps Margarita severity to a priority level', () => {
    expect(margaritaPriority('Критичное')).toBe(1)
    expect(margaritaPriority('Грубое')).toBe(1)
    expect(margaritaPriority('Среднее')).toBe(2)
    expect(margaritaPriority(null)).toBe(2)
  })
})

describe('mapSonaTicket', () => {
  const row = {
    id: 'TCK-1',
    company_agr_no: 'B-4392',
    accountant: 'Օլյա',
    type: 'vat',
    title: 'Не сдан отчёт НДС',
    description: 'Срок прошёл, отчёт не отправлен',
    priority: 'critical',
    urgent: false,
    created_at: '2026-06-19T10:00:00Z',
    // joined from mqa_chats:
    name_agr: 'PRIME DIGITAL LLC',
    chat_name: 'Prime B-4392',
    chat_link: 'https://web.telegram.org/a/#-5138517763',
  }

  it('produces a complete kk_problems row landing in the accountant queue', () => {
    const p = mapSonaTicket(row)
    expect(p.problem_id).toBe('sona:TCK-1')
    expect(p.source).toBe(SONA_SOURCE)
    expect(p.contract_id).toBe('B-4392')
    expect(p.client_name).toBe('PRIME DIGITAL LLC')
    expect(p.chat_link).toBe('https://web.telegram.org/a/#-5138517763')
    // Source name "Օլյա" is resolved to the real employee.
    expect(p.accountant_name).toBe('Olya Accounting')
    expect(p.accountant_id).toBe('2b22a577-7683-4f22-9834-c957312da4bc')
    expect(p.priority).toBe(1)
    expect(p.problem_title).toBe('Не сдан отчёт НДС')
    expect(p.status).toBe(INGEST_STATUS)
  })

  it('falls back to chat accountant + a default title when fields are blank', () => {
    const p = mapSonaTicket({
      id: 'TCK-2',
      company_agr_no: 'B-1',
      accountant: '   ',
      chat_accountant: 'Նաիրա',
      title: '',
      type: '',
    })
    expect(p.accountant_name).toBe('Naira Accounting')
    expect(p.problem_title).toBe('Проблема по проверке качества')
  })
})

describe('mapMargaritaViolation', () => {
  const row = {
    id: 'v-77',
    chat_agr_no: 'B-4219',
    accountant: 'Նաիրա',
    client: 'MARINA BIRYUKOVA',
    severity: 'Критичное',
    violation_type: 'Не ответил клиенту вовремя',
    note: 'Клиент ждал ответа более суток',
    vdate: '2026-06-18',
    created_at: '2026-06-18T15:00:00Z',
    chat_name: 'Марина Бирюкова/В-4219',
    chat_link: 'https://web.telegram.org/a/#-1003560759147',
  }

  it('produces a complete kk_problems row', () => {
    const p = mapMargaritaViolation(row)
    expect(p.problem_id).toBe('margarita:v-77')
    expect(p.source).toBe(MARGARITA_SOURCE)
    expect(p.contract_id).toBe('B-4219')
    expect(p.client_name).toBe('MARINA BIRYUKOVA')
    expect(p.accountant_name).toBe('Naira Accounting')
    expect(p.accountant_id).toBe('b2799800-e8bc-4b28-8ce6-db73eb548f3b')
    expect(p.priority).toBe(1)
    expect(p.problem_title).toBe('Не ответил клиенту вовремя')
    expect(p.problem_description).toBe('Клиент ждал ответа более суток')
    expect(p.status).toBe(INGEST_STATUS)
  })

  it('defaults the title and uses vdate when created_at is missing', () => {
    const p = mapMargaritaViolation({ id: 'v-9', severity: 'Среднее', vdate: '2026-06-01' })
    expect(p.problem_title).toBe('Нарушение (Маргарита)')
    expect(p.detected_at).toBe('2026-06-01')
    expect(p.priority).toBe(2)
  })
})

describe('resolveAccountant (source name → real employee)', () => {
  it('maps a bare Armenian first name to the "{Name} Accounting" employee', () => {
    expect(resolveAccountant('Օլյա')).toEqual({
      accountant_id: '2b22a577-7683-4f22-9834-c957312da4bc',
      accountant_name: 'Olya Accounting',
    })
  })

  it('disambiguates an initialed name to the surname (Նաիրա Մ․ → Mkhitaryan)', () => {
    const naira = resolveAccountant('Նաիրա')
    const nairaM = resolveAccountant('Նաիրա Մ․')
    expect(naira.accountant_name).toBe('Naira Accounting')
    expect(nairaM.accountant_name).toBe('Naira Mkhitaryan')
    expect(naira.accountant_id).not.toBe(nairaM.accountant_id)
  })

  it('is whitespace/case tolerant', () => {
    expect(resolveAccountant('  Դավիթ  ').accountant_name).toBe('Davit Accounting')
  })

  it('resolves an unknown / non-person label to null on both fields', () => {
    for (const junk of ['Էրիկ', 'հանձնված', '-', '', null, undefined, 'Анна Петросян']) {
      expect(resolveAccountant(junk)).toEqual({ accountant_id: null, accountant_name: null })
    }
  })

  it('every alias resolves to a uuid accountant_id and a non-empty name', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    for (const { employee_id, full_name } of ACCOUNTANT_ALIASES.values()) {
      expect(employee_id).toMatch(uuid)
      expect(full_name.trim()).not.toBe('')
    }
  })

  it('normalizeAccountant trims, lowercases and collapses whitespace', () => {
    expect(normalizeAccountant('  Naira   Mkhitaryan ')).toBe('naira mkhitaryan')
  })
})

describe('live QA detections (unanswered / late / promise)', () => {
  it('builds stable, per-accountant ids and telegram links', () => {
    expect(qaProblemId('unanswered', -55, 'emp-1')).toBe('unanswered:-55:emp-1')
    expect(qaProblemId('promise', -55)).toBe('promise:-55')
    expect(telegramChatLink(-4985861737)).toBe('https://web.telegram.org/a/#-4985861737')
    expect(telegramChatLink(null)).toBeNull()
  })

  it('maps unanswered severity to priority (minor/data-incomplete never critical)', () => {
    expect(unansweredPriority('critical')).toBe(1)
    expect(unansweredPriority('minor')).toBe(3)
    expect(unansweredPriority(undefined)).toBe(2)
  })

  it('maps an unanswered chat to a kk_problems row for the resolved accountant', () => {
    const p = mapUnansweredChat(
      {
        chat_id: -5175454837,
        chat_name: 'Bookkeeping B-4479',
        problematic_client_message: 'Добрый день! можете попросить курс?',
        oldest_pending_at: '2026-06-22T05:13:29+00:00',
        severity: 'critical',
        flag_reason: 'no_staff_reply_after_client_question',
      },
      { accountant_id: '2b22a577-7683-4f22-9834-c957312da4bc', accountant_name: 'Olya Accounting' },
    )
    expect(p.problem_id).toBe('unanswered:-5175454837:2b22a577-7683-4f22-9834-c957312da4bc')
    expect(p.source).toBe(QA_SOURCE)
    expect(p.problem_title).toBe(QA_PROBLEM_TITLES.unanswered)
    expect(p.accountant_name).toBe('Olya Accounting')
    expect(p.priority).toBe(1)
    expect(p.chat_link).toBe('https://web.telegram.org/a/#-5175454837')
    expect(p.status).toBe(INGEST_STATUS)
  })

  it('leaves an unanswered chat unassigned when no accountant resolved', () => {
    const p = mapUnansweredChat({ chat_id: -1, chat_name: 'X', severity: 'minor' })
    expect(p.problem_id).toBe('unanswered:-1')
    expect(p.accountant_id).toBeNull()
    expect(p.priority).toBe(3)
  })

  it('maps a late-answer chat using the responder as accountant', () => {
    const p = mapLateChat(
      {
        chat_id: -5279829070,
        chat_name: 'Բատրիշա ՍՊԸ/B-4086 AM',
        client_name: 'Ani',
        oldest_pending_text: 'Կուղարկե՞ք հաշվետվություն',
        request_time: '2026-06-20T11:52:49+00:00',
        flag_reason: 'answered_but_after_sla',
      },
      { accountant_id: '6e60a1f3-2869-4e02-ba38-d00e6e2edb83', accountant_name: 'Stella Accounting' },
    )
    expect(p.problem_id).toBe('late:-5279829070')
    expect(p.problem_title).toBe(QA_PROBLEM_TITLES.late)
    expect(p.client_name).toBe('Ani')
    expect(p.accountant_name).toBe('Stella Accounting')
    expect(p.detected_at).toBe('2026-06-20T11:52:49+00:00')
  })

  it('maps an overdue promise and never invents an owner', () => {
    const p = mapOverduePromise({
      chat_id: -4082607480,
      chat_name: 'Мишт Тей OOO N-11 RU',
      promise_text: 'Завтра я позвоню и попрошу…',
      promise_time: '2026-06-18T14:31:27+00:00',
      flag_reason: 'employee_promise_overdue',
    })
    expect(p.problem_id).toBe('promise:-4082607480')
    expect(p.problem_title).toBe(QA_PROBLEM_TITLES.promise)
    expect(p.accountant_id).toBeNull()
    expect(p.accountant_name).toBeNull()
    expect(p.problem_description).toBe('Завтра я позвоню и попрошу…')
  })

  it('only emits the AI source allowed by the schema', () => {
    expect(SOURCES).toContain(QA_SOURCE)
  })
})

describe('unanswered targeting (do not blame whoever answered)', () => {
  it('treats data_incomplete / needs_review as uncertain', () => {
    expect(isUnansweredUncertain({ data_incomplete: true })).toBe(true)
    expect(isUnansweredUncertain({ needs_review: true })).toBe(true)
    expect(isUnansweredUncertain({ data_incomplete: false, needs_review: false })).toBe(false)
    expect(isUnansweredUncertain({})).toBe(false)
  })

  it('extracts @mentions (who was actually asked), lowercased', () => {
    expect(extractMentions('Добрый день! @olyaAccounting и @manager_onebusiness')).toEqual([
      'olyaaccounting',
      'manager_onebusiness',
    ])
    expect(extractMentions('no mentions here')).toEqual([])
    expect(extractMentions(null)).toEqual([])
  })

  it('uncertain row → unassigned soft review item (nobody blamed)', () => {
    // The Pachin case: Inga answered but the reply was dropped on import.
    const p = mapUncertainUnanswered({
      chat_id: -4160356883,
      chat_name: 'ИП Александр Пачин N-6 RU',
      problematic_client_message: 'Правильно понимаю, что в 40 000 драм входит все?',
      oldest_pending_at: '2026-06-18T14:07:15+00:00',
      flag_reason: 'data_incomplete_possible_dropped_reply',
    })
    expect(p.problem_id).toBe('review:-4160356883')
    expect(p.problem_title).toBe(QA_PROBLEM_TITLES.review)
    expect(p.accountant_id).toBeNull()
    expect(p.accountant_name).toBeNull()
    expect(p.priority).toBe(3)
  })

  it('a confirmed row is assigned per accountant (one row each), keyed by employee', () => {
    // When @olyaaccounting is asked, only Olya's row is produced upstream; the
    // mapper keys the problem by that employee so others (e.g. Inga) get nothing.
    const olya = mapUnansweredChat(
      { chat_id: -5175454837, chat_name: 'Bookkeeping B-4479', severity: 'critical' },
      { accountant_id: '2b22a577-7683-4f22-9834-c957312da4bc', accountant_name: 'Olya Accounting' },
    )
    expect(olya.problem_id).toBe('unanswered:-5175454837:2b22a577-7683-4f22-9834-c957312da4bc')
    expect(olya.accountant_name).toBe('Olya Accounting')
  })
})

describe('qaKind (current classification from title, not stale id prefix)', () => {
  it('reads the kind from the problem_title', () => {
    expect(qaKind({ problem_title: QA_PROBLEM_TITLES.unanswered })).toBe('unanswered')
    expect(qaKind({ problem_title: QA_PROBLEM_TITLES.late })).toBe('late')
    expect(qaKind({ problem_title: QA_PROBLEM_TITLES.promise })).toBe('promise')
    // The review title also contains «без ответа» — must resolve to review, not unanswered.
    expect(qaKind({ problem_title: QA_PROBLEM_TITLES.review })).toBe('review')
  })

  it('a reclassified late answer (unanswered: id, «Поздний ответ» title) counts as late', () => {
    expect(
      qaKind({ problem_id: 'unanswered:-5258193111:emp', problem_title: 'Поздний ответ клиенту' }),
    ).toBe('late')
  })

  it('falls back to the problem_id prefix when the title is unrecognised', () => {
    expect(qaKind({ problem_id: 'late:-55', problem_title: '' })).toBe('late')
    expect(qaKind({ problem_id: 'unanswered:-55:emp' })).toBe('unanswered')
    expect(qaKind({ problem_id: 'sona:42' })).toBeNull()
    expect(qaKind({})).toBeNull()
  })
})

describe('contract integrity', () => {
  it('only emits sources allowed by the kk_problems schema', () => {
    expect(SOURCES).toContain(SONA_SOURCE)
    expect(SOURCES).toContain(MARGARITA_SOURCE)
  })

  it('lands new problems on an accountant-actionable status', () => {
    expect(INGEST_STATUS).toBe(STATUS.waiting_for_accountant)
  })

  it('never refreshes status or feedback columns on conflict', () => {
    expect(UPSERT_REFRESH_COLUMNS).not.toContain('status')
    expect(UPSERT_REFRESH_COLUMNS).not.toContain('situation_comment')
    expect(UPSERT_REFRESH_COLUMNS).not.toContain('solution_comment')
  })
})
