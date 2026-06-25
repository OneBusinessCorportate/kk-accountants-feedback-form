import { createClient } from '@supabase/supabase-js'

// Main Project (ntdngelbzojoqoknovnh) — OB CRM deals (sdelki) table.
// Anon key has read access via anon_full_ob RLS policy.
const url = import.meta.env.VITE_MAIN_SUPABASE_URL
  || 'https://ntdngelbzojoqoknovnh.supabase.co'
const key = import.meta.env.VITE_MAIN_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50ZG5nZWxiem9qb3Fva25vdm5oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDgyODQ4MTcsImV4cCI6MjA2Mzg2MDgxN30.pThBsHf7pjw7R98yZGQvpUbjBW2AB6JlwC2w8WD12wU'

export const mainProject = createClient(url, key, { auth: { persistSession: false } })

/**
 * Normalize a contract number so Cyrillic and Latin prefixes compare equal.
 * В-3142 (Cyrillic) === B-3142 (Latin), Н-100 === N-100.
 * Also strips leading № and spaces.
 */
export function normalizeContractNo(raw) {
  return String(raw ?? '')
    .replace(/№\s*/g, '')
    .replace(/В/g, 'B')  // Cyrillic В → B
    .replace(/Н/g, 'N')  // Cyrillic Н → N
    .replace(/б/g, 'b')  // Cyrillic б (lower) → b (shouldn't appear, safety)
    .trim()
    .toUpperCase()
}

/**
 * Split a compound contract field (e.g. "4828+В-4829", "B-4019 , B-4020")
 * into individual normalized contract numbers.
 */
export function splitContractNos(field) {
  if (!field || field === '-') return []
  return field
    .split(/[+,]/)
    .map(s => normalizeContractNo(s))
    .filter(Boolean)
}
