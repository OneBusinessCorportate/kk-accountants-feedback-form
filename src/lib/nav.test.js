import { describe, it, expect } from 'vitest'
import { NAV_LINKS, visibleNavLinks } from './nav'

describe('visibleNavLinks', () => {
  it('shows only Dashboard + Report + Accountant + Tasks + Clients + Accounting to a non-manager', () => {
    const tos = visibleNavLinks(false).map((l) => l.to)
    expect(tos).toEqual(['/', '/report', '/accountant', '/tasks', '/clients', '/accounting'])
  })

  it('shows every link to a manager', () => {
    const tos = visibleNavLinks(true).map((l) => l.to)
    expect(tos).toEqual(['/', '/report', '/accountant', '/tasks', '/clients', '/accounting', '/management', '/reports'])
  })

  it('only Management and Reports are management-only', () => {
    const manageOnly = NAV_LINKS.filter((l) => l.manageOnly).map((l) => l.to)
    expect(manageOnly).toEqual(['/management', '/reports'])
  })

  it('every link has a destination and a label', () => {
    for (const l of NAV_LINKS) {
      expect(l.to).toBeTruthy()
      expect(l.label).toBeTruthy()
    }
  })
})
