import { describe, it, expect, beforeEach, vi } from 'vitest'

// Capture every rpc / from call so we can assert the cross-app write path.
const rpcCalls = []
const fromCalls = []

function readBuilder(table) {
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    in: vi.fn(() => b),
    order: vi.fn(() => b),
    then: (resolve, reject) =>
      Promise.resolve({ data: [{ problem_id: 'margarita:v1', status: 'appealed' }], error: null }).then(
        resolve,
        reject,
      ),
  }
  return b
}

let rpcResult = { data: [{ violation_id: 'v1', status: 'acknowledged' }], error: null }

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

// Fixed stored login code so the api layer has an identity to send.
vi.mock('./auth', () => ({ getStoredCode: () => 'MYCODE123' }))

import {
  acknowledgeViolation,
  appealViolation,
  fetchViolationWorkflowForProblem,
} from './api'

beforeEach(() => {
  rpcCalls.length = 0
  fromCalls.length = 0
  rpcResult = { data: [{ violation_id: 'v1', status: 'acknowledged' }], error: null }
})

describe('acknowledgeViolation', () => {
  it('resolves the violation id and calls the RPC with the login code', async () => {
    const out = await acknowledgeViolation({ problemId: 'margarita:v1' })
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].fn).toBe('kk_acknowledge_violation')
    expect(rpcCalls[0].args).toEqual({ p_violation_id: 'v1', p_login_code: 'MYCODE123' })
    // Returns the single row (unwrapped from the array).
    expect(out).toEqual({ violation_id: 'v1', status: 'acknowledged' })
  })

  it('an explicit loginCode overrides the stored one', async () => {
    await acknowledgeViolation({ problemId: 'margarita:v1', loginCode: 'OTHER' })
    expect(rpcCalls[0].args.p_login_code).toBe('OTHER')
  })

  it('refuses a non-margarita problem id (no RPC call)', async () => {
    await expect(acknowledgeViolation({ problemId: 'sona:5' })).rejects.toThrow(/нарушени/i)
    expect(rpcCalls).toHaveLength(0)
  })

  it('surfaces the DB error message (e.g. ownership) as an Error', async () => {
    rpcResult = { data: null, error: { message: 'Можно реагировать только на собственное нарушение.' } }
    await expect(acknowledgeViolation({ problemId: 'margarita:v1' })).rejects.toThrow(
      /собственное нарушение/,
    )
  })
})

describe('appealViolation', () => {
  it('sends the trimmed text to the appeal RPC', async () => {
    rpcResult = { data: [{ appeal_id: 'a1', violation_id: 'v1', status: 'pending' }], error: null }
    const out = await appealViolation({ problemId: 'margarita:v1', appealText: '  не согласен  ' })
    expect(rpcCalls[0].fn).toBe('kk_appeal_violation')
    expect(rpcCalls[0].args).toEqual({
      p_violation_id: 'v1',
      p_login_code: 'MYCODE123',
      p_appeal_text: 'не согласен',
    })
    expect(out.status).toBe('pending')
  })

  it('rejects empty appeal text before hitting the DB', async () => {
    await expect(appealViolation({ problemId: 'margarita:v1', appealText: '   ' })).rejects.toThrow(
      /обязателен/,
    )
    expect(rpcCalls).toHaveLength(0)
  })

  it('maps the one-pending DB conflict message through', async () => {
    rpcResult = { data: null, error: { message: 'По этому нарушению уже есть апелляция на рассмотрении.' } }
    await expect(
      appealViolation({ problemId: 'margarita:v1', appealText: 'again' }),
    ).rejects.toThrow(/уже есть апелляция/)
  })
})

describe('fetchViolationWorkflowForProblem', () => {
  it('reads the kk_violation_workflow view by problem_id', async () => {
    const row = await fetchViolationWorkflowForProblem('margarita:v1')
    expect(fromCalls).toContain('kk_violation_workflow')
    expect(row).toEqual({ problem_id: 'margarita:v1', status: 'appealed' })
  })
})
