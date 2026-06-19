import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Surfaced in the UI (see App.jsx) so a misconfigured deploy fails loudly
// instead of throwing cryptic errors on every query.
export const supabaseConfigError =
  !supabaseUrl || !supabaseAnonKey
    ? 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables.'
    : null

export const supabase = supabaseConfigError
  ? null
  : createClient(supabaseUrl, supabaseAnonKey)
