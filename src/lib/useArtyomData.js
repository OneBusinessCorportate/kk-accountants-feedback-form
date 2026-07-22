import { useEffect, useState } from 'react'
import { fetchArtyomCompanies, fetchArtyomActivities, fetchArtyomComments } from './api'
import { artyomConfigError } from './artyomClient'

function nDaysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Load the ArmSoft/TaxService reference data ONCE per page (companies +
 * activities for a rolling window, and optionally the day comments) so each
 * task/comment card can compute its «сравнение с базой» locally via
 * artyomCompare — no per-card round-trip.
 *
 * Returns { companies, activities, comments, from, to, loading, error, ready }.
 * `ready` is false when Artyom isn't configured (panels then render a hint).
 */
export function useArtyomData({ windowDays = 30, withComments = false, accountantName } = {}) {
  const from = nDaysAgo(windowDays)
  const to = today()
  const [state, setState] = useState({
    companies: [],
    activities: [],
    comments: [],
    loading: !artyomConfigError,
    error: null,
  })

  useEffect(() => {
    if (artyomConfigError) {
      setState((s) => ({ ...s, loading: false }))
      return
    }
    let alive = true
    setState((s) => ({ ...s, loading: true, error: null }))
    Promise.all([
      fetchArtyomCompanies(),
      fetchArtyomActivities({ from, to, accountantName }),
      withComments ? fetchArtyomComments({ from, to, accountantName }) : Promise.resolve([]),
    ])
      .then(([companies, activities, comments]) => {
        if (!alive) return
        setState({ companies, activities, comments, loading: false, error: null })
      })
      .catch((error) => alive && setState((s) => ({ ...s, loading: false, error })))
    return () => {
      alive = false
    }
  }, [from, to, withComments, accountantName])

  return { ...state, from, to, ready: !artyomConfigError }
}
