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
    expect(p.accountant_name).toBe('Օլյա')
    expect(p.accountant_id).toBe('Օլյա') // name is the only stable join key
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
    expect(p.accountant_name).toBe('Նաիրա')
    expect(p.problem_title).toBe('Проблема по проверке (Сона)')
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
    expect(p.accountant_name).toBe('Նաիրա')
    expect(p.accountant_id).toBe('Նաիրա')
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
