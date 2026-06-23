// Top navigation definition + visibility gating, kept pure so it can be unit
// tested without rendering React. Dashboard and Accountant are visible to every
// authenticated user; Review and Admin are management-only (see scope.canManage).
export const NAV_LINKS = [
  { to: '/', label: 'Дашборд', end: true, manageOnly: false },
  { to: '/accountant', label: 'Бухгалтер', manageOnly: false },
  { to: '/tasks', label: 'Задачи', manageOnly: false },
  { to: '/clients', label: 'Клиенты', manageOnly: false },
  { to: '/review', label: 'Проверка', manageOnly: true },
  { to: '/qa-stats', label: 'QA Точность', manageOnly: true },
  { to: '/admin', label: 'Админ', manageOnly: true },
]

/**
 * The nav links visible to a user, given whether they can manage (Review/Admin).
 * @param canManage boolean
 */
export function visibleNavLinks(canManage) {
  return NAV_LINKS.filter((l) => !l.manageOnly || canManage)
}
