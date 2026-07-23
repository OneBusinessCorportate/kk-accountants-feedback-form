import { describe, it, expect, beforeEach, vi } from 'vitest'

// Capture every rpc / from call so we can assert the cross-app write path
// (same harness as violationApi.test.js).
const rpcCalls = []
const fromCalls = []

function readBuilder(table) {
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    in: vi.fn(() => b),
    lte: vi.fn(() => b),
    order: vi.fn(() => b),
    then: (resolve, reject) =>
      Promise.resolve({ data: [{ id: 1, agr_no: 'B-1', status: 'planned' }], error: null }).then(
        resolve,
        reject,
      ),
  }
  return b
}

let rpcResult = { data: [{ id: 1, status: 'edited' }], error: null }

vi.mock('./supabaseClient', () => ({
  supabase: {
    from: vi.fn((t) => {
      fromCalls.push(t)
      return readBuilder(t)
    }),
    rpc: vi.fn((fn, args) => {
      rpcCalls.push({ fn, args })
      return Promise.resolve(rpcResult)
    }),
  },
  supabaseConfigError: null,
}))

vi.mock('./auth', () => ({ getStoredCode: () => 'MYCODE123' }))

import {
  fetchPlannedNotifications,
  fetchSentNotifications,
  editPlannedNotification,
  approvePlannedNotification,
  cancelPlannedNotification,
  attachNotification,
} from './api'

beforeEach(() => {
  rpcCalls.length = 0
  fromCalls.length = 0
  rpcResult = { data: [{ id: 1, status: 'edited' }], error: null }
})

describe('reads (scoped RPCs, not anon views)', () => {
  it('fetchPlannedNotifications calls the scoped RPC with the login code and filters client-side', async () => {
    rpcResult = {
      data: [
        { id: 1, agr_no: 'B-1', status: 'planned' },
        { id: 2, agr_no: 'B-2', status: 'planned' },
      ],
      error: null,
    }
    const rows = await fetchPlannedNotifications({ agrNo: 'B-1' })
    expect(rpcCalls[0].fn).toBe('kk_list_planned_notifications')
    expect(rpcCalls[0].args).toEqual({ p_login_code: 'MYCODE123' })
    // never reads an anon-wide view
    expect(fromCalls).not.toContain('kk_planned_notifications')
    expect(rows).toHaveLength(1)
    expect(rows[0].agr_no).toBe('B-1')
  })
  it('fetchSentNotifications calls the scoped sent-log RPC', async () => {
    rpcResult = { data: [{ id: 9, agr_no: 'B-1' }], error: null }
    await fetchSentNotifications({ agrNo: 'B-1' })
    expect(rpcCalls[0].fn).toBe('kk_list_sent_notifications')
    expect(fromCalls).not.toContain('kk_sent_notifications')
  })
})

describe('editPlannedNotification', () => {
  it('sends the trimmed text + login code to the RPC', async () => {
    rpcResult = { data: [{ id: 1, status: 'edited', rendered_text: 'новый текст' }], error: null }
    const out = await editPlannedNotification({ plannedId: 1, newText: '  новый текст  ' })
    expect(rpcCalls[0].fn).toBe('kk_edit_notification')
    expect(rpcCalls[0].args).toEqual({
      p_planned_id: '1',
      p_login_code: 'MYCODE123',
      p_new_text: 'новый текст',
    })
    expect(out.status).toBe('edited')
  })
  it('rejects empty text before hitting the DB', async () => {
    await expect(editPlannedNotification({ plannedId: 1, newText: '   ' })).rejects.toThrow(
      /пуст/i,
    )
    expect(rpcCalls).toHaveLength(0)
  })
  it('surfaces the DB ownership error', async () => {
    rpcResult = { data: null, error: { message: 'Можно управлять только уведомлениями своих клиентов.' } }
    await expect(editPlannedNotification({ plannedId: 1, newText: 'x' })).rejects.toThrow(
      /своих клиентов/,
    )
  })
})

describe('approve / cancel', () => {
  it('approve calls kk_approve_notification with the id as string', async () => {
    await approvePlannedNotification({ plannedId: 7 })
    expect(rpcCalls[0].fn).toBe('kk_approve_notification')
    expect(rpcCalls[0].args).toEqual({ p_planned_id: '7', p_login_code: 'MYCODE123' })
  })
  it('cancel calls kk_cancel_notification', async () => {
    await cancelPlannedNotification({ plannedId: 7 })
    expect(rpcCalls[0].fn).toBe('kk_cancel_notification')
  })
})

describe('attachNotification', () => {
  it('sends the attachment fields to the RPC', async () => {
    rpcResult = { data: [{ agr_no: 'B-1', period: '202607', category: 'salary' }], error: null }
    await attachNotification({
      agrNo: 'B-1',
      period: '202607',
      category: 'salary',
      fileUrl: 'ved.pdf',
      fileName: 'ved.pdf',
    })
    expect(rpcCalls[0].fn).toBe('kk_attach_notification')
    expect(rpcCalls[0].args.p_agr_no).toBe('B-1')
    expect(rpcCalls[0].args.p_file_url).toBe('ved.pdf')
    expect(rpcCalls[0].args.p_login_code).toBe('MYCODE123')
  })
  it('rejects when neither a file nor a mark-done is provided', async () => {
    await expect(
      attachNotification({ agrNo: 'B-1', period: '202607', category: 'salary' }),
    ).rejects.toThrow(/файл|сделано/i)
    expect(rpcCalls).toHaveLength(0)
  })
})
