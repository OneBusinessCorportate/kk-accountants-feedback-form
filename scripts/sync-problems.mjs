#!/usr/bin/env node
// Optional server-side runner for problem ingestion.
//
// The PRIMARY ingestion path is the in-database pg_cron job created by
// supabase/migrations/0002_problem_ingestion.sql — nothing extra needs to run.
// Use this script only if you prefer to trigger ingestion from an external
// scheduler (host cron, GitHub Actions, a "sync now" button, etc.). It simply
// calls the kk_ingest_problems() SQL function via RPC.
//
// SECURITY: this needs the SERVICE_ROLE key because the sqa_*/mqa_* source
// tables are RLS-locked to server roles. The service_role key must NEVER be put
// in the frontend or committed. Provide it via env (see scripts/.env.sync.example):
//
//   SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=...  node scripts/sync-problems.mjs
//
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
      'These are server-only secrets — never expose them in the frontend.',
  )
  process.exit(1)
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const { data, error } = await supabase.rpc('kk_ingest_problems')

if (error) {
  console.error('Ingestion failed:', error.message)
  process.exit(1)
}

console.log('Ingestion complete:', JSON.stringify(data))
