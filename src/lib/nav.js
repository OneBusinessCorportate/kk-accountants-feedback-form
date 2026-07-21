// Top navigation definition + visibility gating, kept pure so it can be unit
// tested without rendering React. Dashboard and Accountant are visible to every
// authenticated user; «Управление» (the merged Проверка + Апелляции + Админ
// page) and «Отчёты» are management-only (see scope.canManage).
export const NAV_LINKS = [
  { to: '/', label: 'Дашборд', end: true, manageOnly: false },
  { to: '/report', label: 'Отчёт', manageOnly: false },
  { to: '/accountant', label: 'Бухгалтер', manageOnly: false },
  { to: '/tasks', label: 'Задачи', manageOnly: false },
  { to: '/clients', label: 'Клиенты', manageOnly: false },
  { to: '/accounting', label: 'Отчётность', manageOnly: false },
  { to: '/management', label: 'Управление', manageOnly: true },
  { to: '/reports', label: 'Отчёты', manageOnly: true },
]

/**
 * The nav links visible to a user, given whether they can manage (Review/Admin).
 * @param canManage boolean
 */
export function visibleNavLinks(canManage) {
  return NAV_LINKS.filter((l) => !l.manageOnly || canManage)
}
