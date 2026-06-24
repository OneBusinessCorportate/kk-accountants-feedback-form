import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_ARTYOM_SUPABASE_URL
const key = import.meta.env.VITE_ARTYOM_SUPABASE_ANON_KEY

export const artyomConfigError = !url || !key
  ? 'Missing VITE_ARTYOM_SUPABASE_URL or VITE_ARTYOM_SUPABASE_ANON_KEY'
  : null

export const artyom = artyomConfigError
  ? null
  : createClient(url, key, { auth: { persistSession: false } })
