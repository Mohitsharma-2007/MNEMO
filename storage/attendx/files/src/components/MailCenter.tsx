import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle, Bug, CheckCircle2, ClipboardList, Copy, Inbox, KeyRound, LifeBuoy,
  LoaderCircle, Mail, MessageSquareWarning, RefreshCw, Search, Send, ServerOff,
  Smartphone, UserCheck, UserPlus, UserX, Users, Wrench,
} from 'lucide-react'
import { Button } from './ui'
import { useAppStore } from '../store'
import { getLocalServerUrl, handleSessionExpired } from '../lib/apiClient'

/**
 * AttendX Mail Center — one page for every institutional mail event:
 * onboarding, password resets, service requests, complaints, system errors,
 * server outages, app updates, account activation/deactivation, attendance
 * data requests and general enquiries. Trackable requests get a request
 * number (ATX-S-XXXXXX) that students and faculty can follow here.
 */

type NoticeType = { type: string; label: string; description: string; icon: string; audience: 'system' | 'users' | 'targeted'; trackable: boolean }
type Notice = {
  id: string; tracking_id: string; type: string; subject: string; message: string
  status: string; audience: string; sender_name: string; sender_email: string
  target_email: string | null; emailed: number | boolean; admin_note: string
  created_at: string; updated_at: string
}
type DirectoryUser = {
  id: string; full_name: string; email: string; identifier: string; department: string
  role: string; is_active: boolean; classes: string[]; batches_label: string; year: string
}

const ICONS: Record<string, typeof Mail> = {
  'user-plus': UserPlus, 'key-round': KeyRound, wrench: Wrench,
  'message-square-warning': MessageSquareWarning, bug: Bug, 'server-off': ServerOff,
  smartphone: Smartphone, 'user-check': UserCheck, 'user-x': UserX,
  'clipboard-list': ClipboardList, mail: Mail,
}

const STATUS_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  open: { bg: 'rgba(185,121,25,.14)', color: '#b97919', label: 'Open' },
  in_review: { bg: 'rgba(55,111,197,.14)', color: '#376fc5', label: 'In review' },
  resolved: { bg: 'rgba(22,125,100,.14)', color: '#167d64', label: 'Resolved' },
  rejected: { bg: 'rgba(188,75,87,.14)', color: '#bc4b57', label: 'Rejected' },
  sent: { bg: 'rgba(22,125,100,.14)', color: '#167d64', label: 'Sent' },
}

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLE[status] || STATUS_STYLE.open
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: '999px', background: style.bg, color: style.color, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px' }}>
      {style.label}
    </span>
  )
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('attendx_auth_token') || ''
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

function apiUrl(path: string): string {
  return `${getLocalServerUrl()}${path}`
}

export function MailCenter() {
  const { role } = useAppStore()
  const isAdmin = role === 'admin'

  const [types, setTypes] = useState<NoticeType[]>([])
  const [smtpUp, setSmtpUp] = useState(true)
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [catalogRetrying, setCatalogRetrying] = useState(false)
  const [notices, setNotices] = useState<Notice[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'compose' | 'history'>('compose')
  const [copied, setCopied] = useState('')

  // Compose form
  const [type, setType] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [audience, setAudience] = useState('all')
  const [targetEmail, setTargetEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sentResult, setSentResult] = useState<{ ok: boolean; text: string; trackingId?: string } | null>(null)

  // Recipient picker (admin)
  const [directory, setDirectory] = useState<DirectoryUser[]>([])
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedEmails, setSelectedEmails] = useState<string[]>([])
  const [dirRole, setDirRole] = useState('student')
  const [dirDepartment, setDirDepartment] = useState('')
  const [dirBatch, setDirBatch] = useState('')
  const [dirYear, setDirYear] = useState('')
  const [dirQuery, setDirQuery] = useState('')

  // Resolve state (admin)
  const [resolving, setResolving] = useState('')
  const [noteFor, setNoteFor] = useState('')

  // Tracker
  const [trackId, setTrackId] = useState('')

  const activeType = types.find((t) => t.type === type)

  const fetchCatalog = async (): Promise<boolean> => {
    try {
      const res = await fetch(apiUrl('/api/notices/catalog'), { headers: authHeaders() })
      if (res.status === 401) {
        handleSessionExpired()
        return false
      }
      if (!res.ok) return false
      const data = await res.json()
      if (!Array.isArray(data.types)) return false
      const all: NoticeType[] = data.types
      setTypes(isAdmin ? all : all.filter((t) => t.audience === 'system'))
      setSmtpUp(Boolean(data.smtpConfigured))
      setType((current) => current || (isAdmin ? all[0]?.type : all.find((t) => t.audience === 'system')?.type) || '')
      return true
    } catch {
      return false
    }
  }

  // Resilient load: auto-retry up to 3 times so a cold start or a transient
  // network blip never leaves the center stuck on "offline".
  const loadCatalog = async () => {
    setCatalogRetrying(true)
    let ok = false
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      ok = await fetchCatalog()
      if (!ok && attempt < 2) await new Promise((r) => setTimeout(r, 900))
    }
    setCatalogLoaded(ok)
    setCatalogRetrying(false)
  }

  const loadNotices = async (tracking = '') => {
    setLoading(true)
    try {
      const qs = tracking.trim() ? `?trackingId=${encodeURIComponent(tracking.trim())}` : ''
      const res = await fetch(apiUrl(`/api/notices${qs}`), { headers: authHeaders() })
      const data = await res.json()
      setNotices(Array.isArray(data) ? data : [])
    } catch {
      setNotices([])
    }
    setLoading(false)
  }

  const loadDirectory = async () => {
    setDirectoryLoading(true)
    try {
      const res = await fetch(apiUrl('/api/admin/directory'), { headers: authHeaders() })
      const data = await res.json()
      setDirectory(Array.isArray(data.users) ? data.users : [])
    } catch {
      setDirectory([])
    }
    setDirectoryLoading(false)
  }

  useEffect(() => {
    void loadCatalog()
    void loadNotices()
  }, [])

  useEffect(() => {
    if (isAdmin && pickerOpen && directory.length === 0) void loadDirectory()
  }, [isAdmin, pickerOpen])

  const filteredDirectory = useMemo(() => {
    const needle = dirQuery.trim().toLowerCase()
    return directory.filter((u) => {
      if (u.role !== dirRole) return false
      if (dirDepartment && (u.department || '').toLowerCase() !== dirDepartment.toLowerCase()) return false
      if (dirBatch && !u.batches_label.toLowerCase().includes(dirBatch.toLowerCase())) return false
      if (dirYear && (u.year || '').toLowerCase() !== dirYear.toLowerCase()) return false
      if (needle && !`${u.full_name} ${u.email} ${u.identifier}`.toLowerCase().includes(needle)) return false
      return true
    })
  }, [directory, dirRole, dirDepartment, dirBatch, dirYear, dirQuery])

  const departments = useMemo(
    () => [...new Set(directory.map((u) => u.department).filter(Boolean))].sort(),
    [directory],
  )
  const batchesList = useMemo(
    () => [...new Set(directory.flatMap((u) => u.batches_label.split(', ').filter(Boolean)))].sort(),
    [directory],
  )
  const yearsList = useMemo(
    () => [...new Set(directory.map((u) => u.year).filter(Boolean))].sort(),
    [directory],
  )

  const toggleEmail = (email: string) => {
    setSelectedEmails((cur) => (cur.includes(email) ? cur.filter((e) => e !== email) : [...cur, email]))
  }
  const toggleVisible = () => {
    const visible = filteredDirectory.map((u) => u.email).filter(Boolean)
    const allSelected = visible.every((e) => selectedEmails.includes(e))
    setSelectedEmails((cur) =>
      allSelected ? cur.filter((e) => !visible.includes(e)) : [...new Set([...cur, ...visible])],
    )
  }

  const send = async () => {
    if (!type || !message.trim()) {
      setSentResult({ ok: false, text: 'Pick a category and write a message first.' })
      return
    }
    setSending(true)
    setSentResult(null)
    try {
      const body: Record<string, unknown> = { type, subject: subject.trim(), message: message.trim() }
      if (isAdmin) {
        const def = types.find((t) => t.type === type)
        if (selectedEmails.length > 0) {
          body.recipientEmails = selectedEmails
        } else if (def?.audience === 'users') {
          body.audience = audience
        } else if (def?.audience === 'targeted' && targetEmail.trim()) {
          body.targetEmail = targetEmail.trim()
        }
      }
      const res = await fetch(apiUrl('/api/notices'), { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not send')
      setSentResult({
        ok: true,
        text: data.recipients > 1
          ? `Sent to ${data.recipients} recipients.`
          : data.emailSent
            ? 'Email delivered. Keep your request number for tracking.'
            : 'Request recorded (email delivery pending — SMTP may be offline).',
        trackingId: data.trackingId,
      })
      setSubject('')
      setMessage('')
      setTargetEmail('')
      setSelectedEmails([])
      void loadNotices()
    } catch (err) {
      setSentResult({ ok: false, text: (err as Error).message })
    }
    setSending(false)
  }

  const resolve = async (id: string, status: 'in_review' | 'resolved' | 'rejected') => {
    setResolving(id)
    try {
      await fetch(apiUrl(`/api/notices/${id}`), { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ status, adminNote: noteFor }) })
      setNoteFor('')
      void loadNotices()
    } catch { /* keep UI calm */ }
    setResolving('')
  }

  const copyTracking = (trackingId: string) => {
    navigator.clipboard?.writeText(trackingId).catch(() => {})
    setCopied(trackingId)
    setTimeout(() => setCopied(''), 1600)
  }

  const selectStyle: React.CSSProperties = { flex: 1, minWidth: '150px', height: '40px' }

  return (
    <div className="page">
      <header className="page-head" style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}><Inbox size={24} /> Mail Center</h1>
        <p style={{ color: 'var(--muted)', fontSize: '.92rem' }}>
          {isAdmin
            ? 'Compose official notices, broadcast app updates, and resolve every incoming request — all over Gmail SMTP with full tracking.'
            : 'Raise service requests, complaints, and reports to the administration. Every request gets a tracking number and email updates.'}
        </p>
        {catalogLoaded && !smtpUp && (
          <div style={{ marginTop: '.6rem', padding: '.55rem .9rem', borderRadius: 6, background: 'rgba(185,121,25,.12)', color: '#b97919', fontSize: '.85rem', display: 'flex', alignItems: 'center', gap: '.45rem' }}>
            <AlertCircle size={15} /> SMTP is not configured on the server — requests are tracked but emails cannot be delivered.
          </div>
        )}
      </header>

      <div style={{ display: 'flex', gap: '.5rem', marginBottom: '1.25rem' }}>
        <button className={`role-chip ${tab === 'compose' ? 'active' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setTab('compose')}>
          {isAdmin ? 'Compose' : 'Raise a request'}
        </button>
        <button className={`role-chip ${tab === 'history' ? 'active' : ''}`} style={{ cursor: 'pointer' }} onClick={() => { setTab('history'); void loadNotices(trackId) }}>
          {isAdmin ? 'Requests & history' : 'My requests'}
        </button>
      </div>

      {tab === 'compose' && (
        <section className="panel">
          <div className="panel-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}><Mail size={20} /><h2>{isAdmin ? 'New mail / notice' : 'New request'}</h2></div>
          </div>

          <div className="panel-body">
          {!catalogLoaded && (
            <div className="data-state" style={{ minHeight: '140px' }}>
              {catalogRetrying
                ? <LoaderCircle className="spin" size={22} />
                : <AlertCircle size={22} />}
              <strong>{catalogRetrying ? 'Connecting to the AttendX server…' : 'Mail Center is offline'}</strong>
              <span>Connect to the AttendX server (Profile → Server connection) to load the mail categories.</span>
              <Button variant="secondary" onClick={() => void loadCatalog()} disabled={catalogRetrying}>
                <RefreshCw size={15} /> {catalogRetrying ? 'Retrying…' : 'Retry'}
              </Button>
            </div>
          )}

          {catalogLoaded && (
            <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '.6rem', marginBottom: '1.1rem' }}>
            {types.map((t) => {
              const Icon = ICONS[t.icon] || Mail
              const selected = type === t.type
              return (
                <button
                  key={t.type}
                  onClick={() => { setType(t.type); setSentResult(null) }}
                  title={t.description}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '.55rem', padding: '.7rem .8rem', borderRadius: 8, textAlign: 'left',
                    border: selected ? '1.5px solid var(--green)' : '1px solid var(--line)', background: selected ? 'var(--green-pale)' : '#fff',
                    cursor: 'pointer', fontSize: '.85rem', fontWeight: 600, color: 'var(--ink)',
                  }}
                >
                  <Icon size={17} color={selected ? 'var(--green)' : 'var(--muted)'} />
                  {t.label}
                </button>
              )
            })}
          </div>

          {activeType && <p style={{ color: 'var(--muted)', fontSize: '.85rem', marginBottom: '1rem' }}>{activeType.description}</p>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
            <label className="field-label" style={{ marginBottom: 0 }}>
              Subject <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(optional)</span>
              <input className="text-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={activeType ? activeType.label : 'Subject'} />
            </label>

            {isAdmin && activeType?.audience === 'users' && selectedEmails.length === 0 && (
              <label className="field-label" style={{ marginBottom: 0 }}>
                Audience
                <select className="text-input" value={audience} onChange={(e) => setAudience(e.target.value)}>
                  <option value="all">Everyone (students + faculty)</option>
                  <option value="student">Students only</option>
                  <option value="faculty">Faculty only</option>
                </select>
              </label>
            )}

            {isAdmin && activeType?.audience === 'targeted' && selectedEmails.length === 0 && (
              <label className="field-label" style={{ marginBottom: 0 }}>
                Recipient email
                <input className="text-input" type="email" value={targetEmail} onChange={(e) => setTargetEmail(e.target.value)} placeholder="user@college.edu" />
              </label>
            )}

            <label className="field-label" style={{ marginBottom: 0 }}>
              Message
              <textarea
                className="text-input"
                style={{ minHeight: '120px', paddingTop: '10px', resize: 'vertical' }}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Describe the request or write the notice…"
              />
            </label>

            <div>
              <Button onClick={send} disabled={sending}>
                {sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                {sending ? 'Sending…' : isAdmin ? `Send mail${selectedEmails.length ? ` to ${selectedEmails.length} selected` : ''}` : 'Submit request'}
              </Button>
            </div>
          </div>

          {/* Recipient directory picker (admin) */}
          {isAdmin && (
            <div style={{ marginTop: '1.25rem', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
              <button
                onClick={() => setPickerOpen((v) => !v)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '.6rem', padding: '14px 18px', background: '#fafcfb', border: 0, cursor: 'pointer', fontSize: '.92rem', fontWeight: 700, color: 'var(--ink)' }}
              >
                <Users size={18} color="var(--green)" />
                Recipients directory — pick students or faculty by department, batch, year or enrollment no
                <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: '.8rem', fontWeight: 500 }}>
                  {selectedEmails.length ? `${selectedEmails.length} selected` : 'optional'}
                </span>
              </button>

              {pickerOpen && (
                <div style={{ padding: '16px 18px', borderTop: '1px solid var(--line)' }}>
                  <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginBottom: '.8rem' }}>
                    <select className="text-input" style={selectStyle} value={dirRole} onChange={(e) => setDirRole(e.target.value)}>
                      <option value="student">Students</option>
                      <option value="faculty">Faculty</option>
                      <option value="admin">Admins</option>
                    </select>
                    <select className="text-input" style={selectStyle} value={dirDepartment} onChange={(e) => setDirDepartment(e.target.value)}>
                      <option value="">All departments</option>
                      {departments.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <select className="text-input" style={selectStyle} value={dirBatch} onChange={(e) => setDirBatch(e.target.value)}>
                      <option value="">All batches</option>
                      {batchesList.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                    <select className="text-input" style={selectStyle} value={dirYear} onChange={(e) => setDirYear(e.target.value)}>
                      <option value="">All years</option>
                      {yearsList.map((y) => <option key={y} value={y}>{y}</option>)}
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: '.5rem', marginBottom: '.8rem' }}>
                    <div className="search-input" style={{ flex: 1 }}>
                      <Search size={15} />
                      <input value={dirQuery} onChange={(e) => setDirQuery(e.target.value)} placeholder="Search name, email or enrollment no…" />
                    </div>
                    <Button variant="secondary" onClick={toggleVisible}>
                      {filteredDirectory.every((u) => selectedEmails.includes(u.email)) && filteredDirectory.length ? 'Clear visible' : 'Select visible'}
                    </Button>
                  </div>

                  {directoryLoading ? (
                    <div className="data-state" style={{ minHeight: '90px' }}><LoaderCircle className="spin" size={20} /><strong>Loading directory…</strong></div>
                  ) : filteredDirectory.length === 0 ? (
                    <div className="small-empty">No {dirRole}s match these filters.</div>
                  ) : (
                    <div style={{ maxHeight: '320px', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
                      {filteredDirectory.map((u) => (
                        <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: '.7rem', padding: '10px 14px', borderBottom: '1px solid #eef2f0', cursor: 'pointer', fontSize: '.85rem' }}>
                          <input
                            type="checkbox"
                            checked={selectedEmails.includes(u.email)}
                            onChange={() => toggleEmail(u.email)}
                            style={{ width: '16px', height: '16px', accentColor: 'var(--green)' }}
                          />
                          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                            <strong style={{ color: 'var(--ink)' }}>{u.full_name}</strong>
                            <small style={{ color: 'var(--muted)' }}>{u.email}{u.identifier ? ` · ${u.identifier}` : ''}{u.department ? ` · ${u.department}` : ''}</small>
                          </span>
                          <span style={{ marginLeft: 'auto', textAlign: 'right', color: 'var(--muted)', fontSize: '.72rem' }}>
                            {u.batches_label || '—'}{u.year ? ` · ${u.year}` : ''}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  <p style={{ margin: '.6rem 0 0', color: 'var(--muted)', fontSize: '.78rem' }}>
                    {selectedEmails.length
                      ? `${selectedEmails.length} recipient(s) selected — the mail goes only to them.`
                      : 'No explicit selection — the mail follows the category default (administration inbox or full audience).'}
                  </p>
                </div>
              )}
            </div>
          )}
            </>
          )}

          {sentResult && (
            <div style={{
              marginTop: '1rem', padding: '.8rem 1rem', borderRadius: 8, display: 'flex', alignItems: 'center', gap: '.55rem', fontSize: '.9rem',
              background: sentResult.ok ? 'rgba(22,125,100,.12)' : 'rgba(188,75,87,.12)', color: sentResult.ok ? '#167d64' : '#bc4b57',
            }}>
              {sentResult.ok ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
              <span>{sentResult.text}</span>
              {sentResult.trackingId && (
                <button
                  onClick={() => copyTracking(sentResult.trackingId!)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '.35rem', marginLeft: '.4rem', padding: '3px 9px', borderRadius: 6, border: '1px dashed currentColor', background: 'transparent', color: 'inherit', fontWeight: 800, cursor: 'pointer', fontSize: '.85rem' }}
                  title="Copy request number"
                >
                  {sentResult.trackingId} {copied === sentResult.trackingId ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                </button>
              )}
            </div>
          )}
          </div>
        </section>
      )}

      {tab === 'history' && (
        <>
          <section className="panel" style={{ marginBottom: '1.25rem' }}>
            <div className="panel-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}><Search size={18} /><h2>Track by request number</h2></div>
            </div>
            <div className="panel-body" style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
              <input
                className="text-input"
                style={{ flex: 1, minWidth: '220px' }}
                value={trackId}
                onChange={(e) => setTrackId(e.target.value)}
                placeholder="ATX-S-XXXXXX"
                onKeyDown={(e) => e.key === 'Enter' && loadNotices(trackId)}
              />
              <Button onClick={() => loadNotices(trackId)}><Search size={15} /> Track</Button>
              {(trackId || notices.length > 0) && (
                <Button variant="secondary" onClick={() => { setTrackId(''); loadNotices('') }}><RefreshCw size={15} /> Show all</Button>
              )}
            </div>
          </section>

          {loading ? (
            <div className="data-state"><LoaderCircle className="spin" size={22} /><strong>Loading live data</strong></div>
          ) : notices.length === 0 ? (
            <div className="data-state"><LifeBuoy size={22} /><strong>No requests yet</strong><span>New requests will appear here with their tracking numbers.</span></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
              {notices.map((n) => {
                const def = types.find((t) => t.type === n.type)
                const Icon = ICONS[def?.icon || ''] || Mail
                return (
                  <section className="panel" key={n.id} style={{ padding: '1rem 1.15rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '.8rem', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
                        <Icon size={19} color="var(--green)" />
                        <div>
                          <strong style={{ fontSize: '.95rem' }}>{n.subject || def?.label || n.type}</strong>
                          <div style={{ color: 'var(--muted)', fontSize: '.78rem', marginTop: 2 }}>
                            {new Date(n.created_at).toLocaleString()} · {def?.label || n.type}
                            {isAdmin && n.sender_name ? ` · from ${n.sender_name}${n.sender_email ? ` (${n.sender_email})` : ''}` : ''}
                            {n.target_email ? ` · to ${n.target_email}` : ''}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                        <StatusBadge status={n.status} />
                        <button
                          onClick={() => copyTracking(n.tracking_id)}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '.3rem', padding: '3px 8px', borderRadius: 6, border: '1px dashed var(--line)', background: 'transparent', color: 'var(--ink)', fontWeight: 700, cursor: 'pointer', fontSize: '.78rem' }}
                          title="Copy request number"
                        >
                          {n.tracking_id} {copied === n.tracking_id ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                        </button>
                      </div>
                    </div>

                    <p style={{ margin: '.7rem 0 0', color: 'var(--ink)', fontSize: '.88rem', whiteSpace: 'pre-wrap' }}>{n.message}</p>

                    {n.admin_note ? (
                      <p style={{ margin: '.6rem 0 0', padding: '.5rem .8rem', borderRadius: 6, background: 'var(--blue-pale)', color: 'var(--blue)', fontSize: '.82rem' }}>
                        <strong>Admin note:</strong> {n.admin_note}
                      </p>
                    ) : null}

                    {isAdmin && ['open', 'in_review'].includes(n.status) && (
                      <div style={{ marginTop: '.8rem', display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <input
                          className="text-input"
                          style={{ flex: 1, minWidth: '200px', height: '38px' }}
                          placeholder="Resolution note (emailed to the requester)…"
                          value={noteFor}
                          onChange={(e) => setNoteFor(e.target.value)}
                        />
                        <Button variant="secondary" onClick={() => resolve(n.id, 'in_review')} disabled={resolving === n.id}>Mark in review</Button>
                        <Button onClick={() => resolve(n.id, 'resolved')} disabled={resolving === n.id}><CheckCircle2 size={15} /> Resolve</Button>
                        <Button variant="danger" onClick={() => resolve(n.id, 'rejected')} disabled={resolving === n.id}>Reject</Button>
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
