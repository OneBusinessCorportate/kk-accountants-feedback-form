import { describe, it, expect, beforeEach, vi } from 'vitest'

// Configurable RPC result for resolve_login_code.
let rpcResult = { data: null, error: null }
const rpc = vi.fn(() => Promise.resolve(rpcResult))

vi.mock('./supabaseClient', () => ({
  supabase: { rpc: (...args) => rpc(...args) },
  supabaseConfigError: null,
}))

// Minimal in-memory localStorage stub (node test env has none).
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

import {
  normalizeCode,
  resolveCode,
  signInWithCode,
  getStoredCode,
  signOut,
} from './auth'

beforeEach(() => {
  store.clear()
  rpc.mockClear()
  rpcResult = { data: null, error: null }
})

describe('normalizeCode', () => {
  it('strips non-alphanumerics and uppercases', () => {
    expect(normalizeCode('a1b2-c3 d4')).toBe('A1B2C3D4')
    expect(normalizeCode(' Ab.Cd ')).toBe('ABCD')
    expect(normalizeCode('')).toBe('')
    expect(normalizeCode(null)).toBe('')
  })
})

describe('resolveCode', () => {
  it('returns null for an empty / whitespace-only code without calling the RPC', async () => {
    expect(await resolveCode('  -- ')).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('passes the normalized code to resolve_login_code', async () => {
    rpcResult = { data: [{ employee_id: 'e1', full_name: 'X', role: 'accountant' }], error: null }
    const access = await resolveCode('a1-b2 c3')
    expect(rpc).toHaveBeenCalledWith('resolve_login_code', { p_code: 'A1B2C3' })
    expect(access.full_name).toBe('X')
  })

  it('unwraps a single-object (non-array) RPC result', async () => {
    rpcResult = { data: { employee_id: 'e2', role: 'admin' }, error: null }
    expect((await resolveCode('zzzz')).role).toBe('admin')
  })

  it('returns null for an unknown code', async () => {
    rpcResult = { data: [], error: null }
    expect(await resolveCode('nope')).toBeNull()
  })

  it('throws a readable error when the RPC errors', async () => {
    rpcResult = { data: null, error: { message: 'boom' } }
    await expect(resolveCode('x')).rejects.toThrow(/resolve_login_code: boom/)
  })
})

describe('signInWithCode', () => {
  it('remembers the normalized code on success', async () => {
    rpcResult = { data: [{ employee_id: 'e1', role: 'accountant' }], error: null }
    const access = await signInWithCode('a1-b2 c3')
    expect(access).toBeTruthy()
    expect(getStoredCode()).toBe('A1B2C3')
  })

  it('does not store anything on an unknown code', async () => {
    rpcResult = { data: [], error: null }
    expect(await signInWithCode('bad')).toBeNull()
    expect(getStoredCode()).toBeNull()
  })

  it('signOut clears the stored code', async () => {
    rpcResult = { data: [{ employee_id: 'e1' }], error: null }
    await signInWithCode('keepme')
    expect(getStoredCode()).toBe('KEEPME')
    signOut()
    expect(getStoredCode()).toBeNull()
  })
})
