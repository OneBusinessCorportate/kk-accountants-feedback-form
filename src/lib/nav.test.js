import { describe, it, expect } from 'vitest'
import { NAV_LINKS, visibleNavLinks } from './nav'

describe('visibleNavLinks', () => {
  it('shows the accountant links (incl. Notifications) to a non-manager', () => {
    const tos = visibleNavLinks(false).map((l) => l.to)
    expect(tos).toEqual([
      '/',
      '/report',
      '/accountant',
      '/tasks',
      '/clients',
      '/accounting',
      '/notifications',
    ])
  })

  it('shows every link to a manager', () => {
    const tos = visibleNavLinks(true).map((l) => l.to)
    expect(tos).toEqual([
      '/',
      '/report',
      '/accountant',
      '/tasks',
      '/clients',
      '/accounting',
      '/notifications',
      '/management',
      '/notifications-daily',
      '/reports',
    ])
  })

  it('Management, Reports and the daily notifications overview are management-only', () => {
    const manageOnly = NAV_LINKS.filter((l) => l.manageOnly).map((l) => l.to)
    expect(manageOnly).toEqual(['/management', '/notifications-daily', '/reports'])
  })

  it('every link has a destination and a label', () => {
    for (const l of NAV_LINKS) {
      expect(l.to).toBeTruthy()
      expect(l.label).toBeTruthy()
    }
  })
})
