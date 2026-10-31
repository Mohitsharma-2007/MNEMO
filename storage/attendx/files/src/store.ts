import { create } from 'zustand'
import type { Profile, Role, Session } from './types'
import { apiClient } from './lib/apiClient'

const api = apiClient

const emptyProfiles: Record<Role, Profile> = {
  student: { id: '', full_name: '', role: 'student', identifier: '', email: '', department: '' },
  faculty: { id: '', full_name: '', role: 'faculty', identifier: '', email: '', department: '' },
  admin: { id: '', full_name: '', role: 'admin', identifier: '', email: '', department: '' }
}

interface AppState {
  role: Role
  profile: Profile
  authenticated: boolean
  activeSession: Session | null
  authLoading: boolean
  signIn: (email: string, password: string, expectedRole: Role) => Promise<string | null>
  bootstrap: () => Promise<void>
  signOut: () => Promise<void>
  setMustChangePassword: (value: boolean) => void
  setSession: (session: Session | null) => void
}

function normalizeProfile(row: any): Profile {
  const role = isRole(row?.role) ? row.role : 'student'
  const email = text(row?.email)
  return {
    id: text(row?.id),
    full_name: text(row?.full_name, email.split('@')[0] || 'AttendX user'),
    role,
    identifier: text(row?.identifier, '—'),
    email,
    department: text(row?.department),
    avatar: text(row?.avatar_path) || undefined,
    must_change_password: Boolean(row?.must_change_password),
    approval_status: text(row?.approval_status) || undefined,
  }
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function isRole(value: unknown): value is Role {
  return value === 'student' || value === 'faculty' || value === 'admin'
}

export const useAppStore = create<AppState>((set) => ({
  role: 'student', profile: emptyProfiles.student, authenticated: false, authLoading: true, activeSession: null,
  signIn: async (email, password, expectedRole) => {
    try {
      const { data, error } = await api.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })
      if (error || !data.user) return error?.message ?? 'Sign in failed'
      const { data: row, error: profileError } = await api.from('profiles').select('*').eq('id', data.user.id).single()
      if (profileError || !row) { await api.auth.signOut(); return 'Your AttendX profile is not configured. Contact an administrator.' }
      if (!row.is_active) { await api.auth.signOut(); return 'This account has been deactivated.' }
      if (!isRole(row.role) || row.role !== expectedRole) { await api.auth.signOut(); return 'Invalid login credentials for this workspace.' }
      set({ role: row.role, profile: normalizeProfile(row), authenticated: true, authLoading: false })
      return null
    } catch {
      set({ authenticated: false, authLoading: false })
      return 'We could not complete sign in. Check your connection and try again.'
    }
  },
  bootstrap: async () => {
    try {
      const { data } = await api.auth.getSession()
      if (!data.session?.user) { set({ authenticated: false, authLoading: false }); return }
      const { data: row, error: profileError } = await api.from('profiles').select('*').eq('id', data.session.user.id).maybeSingle()
      if (profileError || !row?.is_active || !isRole(row.role)) {
        await api.auth.signOut()
        set({ role: 'student', profile: emptyProfiles.student, authenticated: false, authLoading: false })
        return
      }
      set({ role: row.role, profile: normalizeProfile(row), authenticated: true, authLoading: false })
    } catch {
      set({ role: 'student', profile: emptyProfiles.student, authenticated: false, authLoading: false })
    }
  },
  signOut: async () => { await api.auth.signOut(); set({ role: 'student', profile: emptyProfiles.student, authenticated: false, authLoading: false, activeSession: null }) },
  setMustChangePassword: (value) => set((state) => ({ profile: { ...state.profile, must_change_password: value } })),
  setSession: (activeSession) => set({ activeSession })
}))
