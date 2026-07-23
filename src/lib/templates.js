// Template inventory + composition. The canonical implementation lives in
// scripts/lib/templates.mjs so BOTH the cabinet UI and scripts/mailing_bot.mjs
// import the exact same templates and cannot drift. This file just re-exports it
// for the src/ import path (`./templates`).
export * from '../../scripts/lib/templates.mjs'
