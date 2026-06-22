import { createContext, useContext } from 'react'

// Holds the resolved login identity for the whole app. Provided by App.jsx once
// a code has been resolved; pages read it via useAuth() to scope what they show.
//
// Shape: { access, isSupervisor, canManage, signOut }
//   access      — { employee_id, full_name, role, can_see_all } | null
//   isSupervisor — sees every problem (no scoping)
//   canManage    — may open Review / Admin
//   signOut      — clears the session and returns to the login screen
export const AuthContext = createContext(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthContext.Provider>')
  return ctx
}
