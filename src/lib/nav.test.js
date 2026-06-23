import { describe, it, expect } from 'vitest'
import { NAV_LINKS, visibleNavLinks } from './nav'

describe('visibleNavLinks', () => {
  it('shows only Dashboard + Accountant + Tasks + Clients to a non-manager', () => {
    const tos = visibleNavLinks(false).map((l) => l.to)
    expect(tos).toEqual(['/', '/accountant', '/tasks', '/clients'])
  })

  it('shows every link to a manager', () => {
    const tos = visibleNavLinks(true).map((l) => l.to)
    expect(tos).toEqual(['/', '/accountant', '/tasks', '/clients', '/review', '/qa-stats', '/admin'])
  })

  it('only Review, QA Stats and Admin are management-only', () => {
    const manageOnly = NAV_LINKS.filter((l) => l.manageOnly).map((l) => l.to)
    expect(manageOnly).toEqual(['/review', '/qa-stats', '/admin'])
  })

  it('every link has a destination and a label', () => {
    for (const l of NAV_LINKS) {
      expect(l.to).toBeTruthy()
      expect(l.label).toBeTruthy()
    }
  })
})
