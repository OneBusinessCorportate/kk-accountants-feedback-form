// Login-code auth for the feedback form. Ported from the OneBusiness
// accountants dashboard (ob-dashboards-for-accounters) and pointed at the SAME
// Supabase project, so the login_codes table and the resolve_login_code RPC are
// shared — no new table or function is created here.
//
// Each employee types their personal code; resolving it via resolve_login_code
// yields their identity { employee_id, full_name, role, can_see_all }. The code
// is then remembered in localStorage so the session survives reloads. There is
// no Supabase Auth session — reads use the anon key, and WHAT each person sees
// is scoped client-side from the resolved identity (see lib/scope.js).
import { supabase } from './supabaseClient'

// localStorage key — namespaced to this app so it never collides with the
// dashboards (which use ob_dash_login_code / ob_qaeval_login_code).
const STORAGE_KEY = 'kk_dash_login_code'

// Canonicalize a typed code the same way the SQL resolver does: drop anything
// that isn't a letter/digit, uppercase the rest. So "a1b2-c3 d4" === "A1B2C3D4".
export function normalizeCode(code) {
  return (code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

export function getStoredCode() {
  try {
    return localStorage.getItem(STORAGE_KEY) || null
  } catch {
    return null
  }
}

function setStoredCode(code) {
  try {
    localStorage.setItem(STORAGE_KEY, code)
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

export function clearStoredCode() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Resolve a login code to an identity { employee_id, full_name, role,
 * can_see_all }, or null when the code is unknown.
 */
export async function resolveCode(code) {
  if (!supabase) throw new Error('Supabase не настроен')
  const norm = normalizeCode(code)
  if (!norm) return null
  const { data, error } = await supabase.rpc('resolve_login_code', { p_code: norm })
  if (error) throw new Error(`resolve_login_code: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  return row || null
}

/** Resolve AND remember the code (used after a successful login). */
export async function signInWithCode(code) {
  const access = await resolveCode(code)
  if (!access) return null
  setStoredCode(normalizeCode(code))
  return access
}

export function signOut() {
  clearStoredCode()
}
