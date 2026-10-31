import type { LucideIcon } from 'lucide-react'
import { Bell, BookOpen, CalendarDays, ChevronDown, CircleUserRound, ClipboardCheck, Grid2X2, History, Inbox, KeyRound, LifeBuoy, LogOut, Menu, QrCode, Settings, ShieldCheck, Smartphone, Users, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { Role } from '../types'
import { useAppStore } from '../store'
import { Initials, Logo, Button } from './ui'
import { getLocalServerUrl, handleSessionExpired } from '../lib/apiClient'
import { UpdateBanner } from './UpdateBanner'

export type ViewKey = 'home' | 'mark' | 'history' | 'classes' | 'session' | 'people' | 'passwords' | 'review' | 'settings' | 'invites' | 'profile' | 'queries' | 'mail'
type Nav = { key: ViewKey; label: string; icon: LucideIcon }
const navByRole: Record<Role, Nav[]> = {
  student: [{ key: 'home', label: 'Overview', icon: Grid2X2 }, { key: 'mark', label: 'Mark attendance', icon: QrCode }, { key: 'classes', label: 'My classes', icon: BookOpen }, { key: 'queries', label: 'Attendance help', icon: LifeBuoy }, { key: 'mail', label: 'Mail Center', icon: Inbox }, { key: 'history', label: 'History', icon: History }],
  faculty: [{ key: 'home', label: 'Overview', icon: Grid2X2 }, { key: 'session', label: 'Live session', icon: QrCode }, { key: 'classes', label: 'My classes', icon: BookOpen }, { key: 'mail', label: 'Mail Center', icon: Inbox }, { key: 'history', label: 'Attendance', icon: ClipboardCheck }],
  admin: [{ key: 'home', label: 'Overview', icon: Grid2X2 }, { key: 'people', label: 'People', icon: Users }, { key: 'passwords', label: 'Password requests', icon: KeyRound }, { key: 'classes', label: 'Classes', icon: CalendarDays }, { key: 'review', label: 'Review queue', icon: ShieldCheck }, { key: 'queries', label: 'Attendance queries', icon: LifeBuoy }, { key: 'mail', label: 'Mail Center', icon: Inbox }, { key: 'history', label: 'Records', icon: ClipboardCheck }, { key: 'settings', label: 'Settings', icon: Settings }]
}

export function Shell({ view, setView, children }: { view: ViewKey; setView: (view: ViewKey) => void; children: ReactNode }) {
  const { role, profile, signOut } = useAppStore()
  const [menuOpen, setMenuOpen] = useState(false)
  const [openNotices, setOpenNotices] = useState(0)
  const nav = navByRole[role]
  const select = (key: ViewKey) => { setView(key); setMenuOpen(false) }

  // Live open-request badge for the bell — role-aware from the Mail Center.
  useEffect(() => {
    let alive = true
    const load = () => {
      const token = localStorage.getItem('attendx_auth_token') || ''
      fetch(`${getLocalServerUrl()}/api/notices?status=open`, { headers: { Authorization: `Bearer ${token}` } })
        .then((res) => {
          if (res.status === 401) {
            // Stale/expired token (e.g. server restarted) — stop polling and
            // return to sign in instead of spamming 401s.
            if (alive) handleSessionExpired()
            return Promise.reject(new Error('session expired'))
          }
          return res.ok ? res.json() : Promise.reject(new Error('offline'))
        })
        .then((rows) => { if (alive && Array.isArray(rows)) setOpenNotices(rows.length) })
        .catch(() => { if (alive) setOpenNotices(0) })
    }
    load()
    const timer = window.setInterval(load, 60000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])

  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-head"><Logo /><button className="icon-button sidebar-close" onClick={() => setMenuOpen(false)} aria-label="Close navigation"><X /></button></div>
      <nav className="main-nav" aria-label="Main navigation">
        <p className="nav-eyebrow">Workspace</p>
        {nav.map(({ key, label, icon: Icon }) => <button key={key} className={view === key ? 'active' : ''} onClick={() => select(key)}><Icon size={19}/><span>{label}</span></button>)}
      </nav>
      <div className="sidebar-foot">
        <button className="account-button" onClick={() => select('profile')}><Initials name={profile.full_name} /><span><strong>{profile.full_name}</strong><small>{profile.identifier}</small></span><ChevronDown size={16}/></button>
        <button className="signout" onClick={signOut}><LogOut size={17}/>Sign out</button>
      </div>
    </aside>
    {menuOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <main className="workspace">
      <header className="topbar">
        <button className="icon-button menu-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Menu /></button>
        <div className="topbar-brand"><Logo compact /></div>
        <span className="role-chip">{role}</span>
        <div className="topbar-actions">
          <button
            className="icon-button notification-button"
            aria-label={`Notifications — ${openNotices} open in Mail Center`}
            title={`Mail Center · ${openNotices} open request${openNotices === 1 ? '' : 's'}`}
            onClick={() => select('mail')}
          >
            <Bell size={20}/>
            {openNotices > 0 && <i />}
          </button>
          <button className="compact-profile" onClick={() => select('profile')}><Initials name={profile.full_name} size="sm"/><span>{profile.full_name.split(' ')[0]}</span></button>
        </div>
      </header>
      <div className="content"><UpdateBanner />{children}</div>
    </main>
    <nav className="mobile-nav">{[
      nav.find((item) => item.key === 'home'),
      nav.find((item) => ['mark', 'session', 'people'].includes(item.key)) || nav[1],
      nav.find((item) => item.key === 'queries') || nav[2],
      nav.find((item) => item.key === 'mail'),
    ].filter((item): item is Nav => Boolean(item)).map(({ key, label, icon: Icon }) => <button key={key} className={view === key ? 'active' : ''} onClick={() => select(key)}><Icon size={20}/><span>{label.replace(' attendance', '')}</span></button>)}<button className={view === 'profile' ? 'active' : ''} onClick={() => select('profile')}><CircleUserRound size={20}/><span>Profile</span></button></nav>
  </div>
}
