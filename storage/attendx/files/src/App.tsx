import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, ArrowRight, Camera, CheckCircle2, Clock, IdCard, KeyRound, LoaderCircle, LockKeyhole, MapPin, QrCode, ScanLine, ShieldAlert, ShieldCheck, Smartphone, Users } from 'lucide-react'
import { Shell, type ViewKey } from './components/Shell'
import { Button, Logo } from './components/ui'
import { useAppStore } from './store'
import type { Role } from './types'
import { apiClient, getLocalServerUrl } from './lib/apiClient'
import { checkDeviceIntegrity, openDeveloperSettings } from './lib/deviceIntegrity'

const supabase = apiClient
import { CameraCaptureModal, captureNativePhoto, type LivePhoto } from './components/CameraCapture'
import { extractJoinToken, QrScannerModal } from './components/QrScanner'
import { OtpModal } from './components/OtpModal'
import { Landing } from './components/Landing'
import { isNativeApp } from './lib/platform'
import { UpdateBanner } from './components/UpdateBanner'

import {
  AdminDashboard,
  FacultyDashboard,
  FacultySession,
  HistoryView,
  MarkAttendance,
  PeopleView,
  PasswordRequestsView,
  ProfileView,
  ReviewQueue,
  SettingsView,
  StudentClasses,
  StudentDashboard,
  InvitationCodesView,
  AttendanceQueriesView
} from './views'
import { MailCenter } from './components/MailCenter'

const roleCopy: Record<Role, { label: string; detail: string }> = {
  student: { label: 'Student', detail: 'Mark and track attendance' },
  faculty: { label: 'Faculty', detail: 'Run classroom sessions' },
  admin: { label: 'Admin', detail: 'Manage institution access' }
}

function Signup({ onBack }: { onBack: () => void }) {
  const [role, setRole] = useState<'student'|'faculty'>('student')
  const [form, setForm] = useState({ fullName: '', email: '', password: '', identifier: '', department: '', inviteToken: '' })
  const [identity, setIdentity] = useState<LivePhoto|null>(null), [front, setFront] = useState<LivePhoto|null>(null), [back, setBack] = useState<LivePhoto|null>(null)
  const [cameraField, setCameraField] = useState<'identity'|'front'|'back'|null>(null), [scanInvite, setScanInvite] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [complete, setComplete] = useState(false)
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }))
  const capture = async (field: 'identity'|'front'|'back') => {
    setError('')
    try { const result = await captureNativePhoto(field === 'identity' ? 'user' : 'environment'); if (result) setPhoto(field, result); else setCameraField(field) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Camera failed') }
  }
  const setPhoto = (field: 'identity'|'front'|'back', photo: LivePhoto) => field === 'identity' ? setIdentity(photo) : field === 'front' ? setFront(photo) : setBack(photo)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('')
    if (!identity || !front || !back) { setError('Capture your portrait and both sides of your ID card.'); return }
    setLoading(true)
    const { error: signupError } = await supabase.functions.invoke('signup', { body: {
      ...form, role, inviteToken: extractJoinToken(form.inviteToken),
      identityPhotoDataUrl: identity.dataUrl, identityPhotoCapturedAt: identity.capturedAt,
      idCardFrontDataUrl: front.dataUrl, idCardFrontCapturedAt: front.capturedAt,
      idCardBackDataUrl: back.dataUrl, idCardBackCapturedAt: back.capturedAt,
    } })
    if (signupError) setError(signupError.message); else setComplete(true)
    setLoading(false)
  }
  if (complete) return <main className="signup-page"><section className="signup-card signup-complete"><div className="success-mark"><CheckCircle2 size={28}/></div>
    {role === 'faculty' ? (
      <>
        <h1>Application submitted</h1>
        <p>Hello, we will be sending you an email within 24 hours with the invitation code that you need to enter during the login session. When you log in you will need to enter the invitation code to activate your account and access the service.</p>
      </>
    ) : (
      <>
        <h1>Account created</h1>
        <p>Your live identity captures were stored privately. You can now sign in.</p>
      </>
    )}
  <Button onClick={onBack}>Go to sign in</Button></section></main>
  return <main className="signup-page"><form className="signup-card" onSubmit={submit}><button className="back-link" type="button" onClick={onBack}><ArrowLeft size={16}/>Back to sign in</button><p className="eyebrow">Controlled registration</p><h1>Create your AttendX account</h1><p className="page-description">All identity images must be captured live.</p>{error && <div className="login-error"><AlertTriangle size={16}/>{error}</div>}<div className="signup-role"><button type="button" className={role === 'student' ? 'active' : ''} onClick={() => setRole('student')}><Smartphone size={18}/>Student</button><button type="button" className={role === 'faculty' ? 'active' : ''} onClick={() => setRole('faculty')}><Users size={18}/>Faculty</button></div><div className="signup-fields"><label className="field-label">Full name<input className="text-input" autoComplete="name" value={form.fullName} onChange={(event) => update('fullName', event.target.value)} required/></label><label className="field-label">Enrollment / employee number<input className="text-input" autoComplete="off" value={form.identifier} onChange={(event) => update('identifier', event.target.value)} required/></label><label className="field-label">Institution email<input type="email" autoComplete="email" className="text-input" value={form.email} onChange={(event) => update('email', event.target.value)} required/></label><label className="field-label">Department<input className="text-input" autoComplete="organization" value={form.department} onChange={(event) => update('department', event.target.value)} required/></label><label className="field-label signup-wide">Password<input type="password" autoComplete="new-password" minLength={12} className="text-input" value={form.password} onChange={(event) => update('password', event.target.value)} required/><small>At least 12 characters</small></label></div><div className="identity-captures"><CaptureTile title="Your live portrait" icon={<Camera/>} photo={identity} onClick={() => capture('identity')}/><CaptureTile title="ID card front" icon={<IdCard/>} photo={front} onClick={() => capture('front')}/><CaptureTile title="ID card back" icon={<IdCard/>} photo={back} onClick={() => capture('back')}/></div><Button className="full-button" disabled={loading}>{loading && <LoaderCircle className="spin" size={17}/>}{role === 'faculty' ? 'Submit application' : 'Create account'}</Button></form>{cameraField && <CameraCaptureModal facing={cameraField === 'identity' ? 'user' : 'environment'} title={cameraField === 'identity' ? 'Capture your portrait' : `Capture ID card ${cameraField}`} onClose={() => setCameraField(null)} onCapture={(photo) => { setPhoto(cameraField, photo); setCameraField(null) }}/>}</main>
}

function CaptureTile({ title, icon, photo, onClick }: { title: string; icon: React.ReactNode; photo: LivePhoto|null; onClick: () => void }) {
  return <button type="button" className={`capture-tile ${photo ? 'captured' : ''}`} onClick={onClick}>{photo ? <img src={photo.dataUrl} alt={title}/> : icon}<strong>{photo ? 'Retake' : title}</strong>{photo && <small>Captured live</small>}</button>
}

function Login({ onBack }: { onBack?: () => void }) {
  const signIn = useAppStore((state) => state.signIn)
  const [nativeApp, setNativeApp] = useState(isNativeApp)
  const [role, setRole] = useState<Role>('student')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [resetMode, setResetMode] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [signupMode, setSignupMode] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [resetError, setResetError] = useState('')
  const [resetting, setResetting] = useState(false)

  const selectRole = (nextRole: Role) => {
    setRole(nextRole)
    setEmail('')
    setIdentifier('')
  }

  const [showOtpModal, setShowOtpModal] = useState(false)
  const [otpPurpose, setOtpPurpose] = useState<'login'|'password_reset'>('login')
  const [verifiedOtpCode, setVerifiedOtpCode] = useState('')

  // A few Android WebViews expose the Capacitor bridge just after the first
  // paint. Re-check once so the APK link is never retained in the native app.
  useEffect(() => {
    setNativeApp(isNativeApp())
  }, [])

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault(); setLoading(true); setError('')
    const message = await signIn(email, password, role)
    if (message) setError(message)
    setLoading(false)
  }

  const submitReset = async (event: React.FormEvent) => {
    event.preventDefault(); setLoading(true); setError('')
    try {
      // Dispatch OTP via Gmail SMTP
      const res = await fetch(`${getLocalServerUrl()}/api/auth/send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, purpose: 'password_reset' }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || data.message || 'Could not send verification email');
      } else {
        setOtpPurpose('password_reset');
        setShowOtpModal(true);
      }
    } catch {
      setError('Could not reach the AttendX server. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const completeReset = async () => {
    setResetError('')
    if (newPassword.length < 12) { setResetError('Use at least 12 characters.'); return }
    if (newPassword !== confirmPassword) { setResetError('Passwords do not match.'); return }
    setResetting(true)
    try {
      const res = await fetch(`${getLocalServerUrl()}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: verifiedOtpCode, newPassword }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setResetError(data.error || 'Could not update the password')
      } else {
        setResetSent(true)
      }
    } catch (err) {
      setResetError((err as Error).message)
    } finally {
      setResetting(false)
    }
  }

  if (signupMode) return <Signup onBack={() => setSignupMode(false)}/>
  return <main className="login-page">
    <section className="login-brand">
      <div className="login-brand-inner">
        <Logo />
        <div className="login-pitch">
          <p className="eyebrow">Verified presence</p>
          <h1>Attendance with evidence, not assumptions.</h1>
          <p>Short-lived QR codes, precise location, and live camera evidence come together in one auditable classroom flow.</p>
        </div>
        <div className="login-signals">
          <span><QrCode size={18}/><strong>Rotating QR</strong><small>15 second tokens</small></span>
          <span><MapPin size={18}/><strong>Live location</strong><small>Server geofence</small></span>
          <span><ShieldCheck size={18}/><strong>Device trust</strong><small>Android integrity</small></span>
        </div>
        {!nativeApp && (
          <div style={{ marginTop: '1.25rem' }}>
            <a
              href="https://github.com/Mohitsharma-2007/AttendX/releases/latest/download/AttendX.apk"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.6rem',
                padding: '0.6rem 1.1rem',
                background: 'rgba(16, 185, 129, 0.12)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                borderRadius: '9999px',
                color: '#10b981',
                fontSize: '0.85rem',
                fontWeight: 600,
                textDecoration: 'none'
              }}
            >
              <Smartphone size={16} />
              <span>Download Android App (.APK)</span>
            </a>
          </div>
        )}
        <p className="login-copyright">AttendX · Institutional attendance infrastructure</p>
      </div>
    </section>
    <section className="login-form-side">
      {onBack && <button type="button" className="back-link" style={{ alignSelf: 'flex-start' }} onClick={onBack}><ArrowLeft size={16} />Back to home</button>}
      <div className="login-mobile-logo" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
        <Logo />
        {!nativeApp && (
          <a
            href="https://github.com/Mohitsharma-2007/AttendX/releases/latest/download/AttendX.apk"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.35rem 0.8rem',
              background: 'rgba(16, 185, 129, 0.1)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              borderRadius: '9999px',
              color: '#10b981',
              fontSize: '0.75rem',
              fontWeight: 600,
              textDecoration: 'none'
            }}
          >
            <Smartphone size={14} />
            <span>Get Android APK</span>
          </a>
        )}
      </div>
      <form className="login-form" onSubmit={resetMode ? submitReset : submitLogin}>
        {resetMode && <button type="button" className="back-link" onClick={() => { setResetMode(false); setResetSent(false); setError('') }}><ArrowLeft size={16}/>Back to sign in</button>}
        <div className="login-heading"><span className="login-lock"><LockKeyhole size={20}/></span><p className="eyebrow">Secure access</p><h2>Welcome back</h2><p>Choose a workspace and sign in with your institution account.</p></div>
        {resetMode && <div className="reset-heading"><span className="login-lock"><KeyRound size={20}/></span><h2>Request a password reset</h2><p>Your request goes to the admin team. They will give you a temporary password manually.</p></div>}
        {error && <div className="login-error"><AlertTriangle size={16}/><span>{error}</span></div>}
        {resetSent ? <div className="reset-success"><CheckCircle2 size={28}/><h3>Request sent</h3><p>If the email and identifier match an active student or faculty account, the admin dashboard now has your request.</p><Button type="button" variant="secondary" onClick={() => { setResetMode(false); setResetSent(false) }}>Return to sign in</Button></div> : <>
        <div className="role-picker" aria-label="Choose account role">
          {(Object.keys(roleCopy) as Role[]).map((item) => <button type="button" key={item} className={role === item ? 'active' : ''} onClick={() => selectRole(item)}><span>{item === 'student' ? <Smartphone size={18}/> : item === 'faculty' ? <Users size={18}/> : <ShieldCheck size={18}/>}</span><strong>{roleCopy[item].label}</strong><small>{roleCopy[item].detail}</small></button>)}
        </div>
        <label className="field-label">Institution email<input className="text-input" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        {resetMode && <label className="field-label">Enrollment / employee number<input className="text-input" autoComplete="off" value={identifier} onChange={(event) => setIdentifier(event.target.value)} required /></label>}
        {!resetMode && <label className="field-label"><span>Password <button type="button" className="text-button" onClick={() => { setResetMode(true); setError('') }}>Forgot password?</button></span><input className="text-input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>}
        <Button className="full-button" type="submit" disabled={loading}>{loading ? <LoaderCircle className="spin" size={17}/> : resetMode ? <KeyRound size={17}/> : null}{resetMode ? 'Send request to admin' : <>Enter {roleCopy[role].label} workspace <ArrowRight size={17}/></>}</Button>
        {false && <div className="demo-notice"><CheckCircle2 size={16}/><span>Demo mode is active. Start the local server for full functionality.</span></div>}
        </>}
      </form>
      <p className="login-help">Have an invitation? <button className="text-button" onClick={() => setSignupMode(true)}>Create a student or faculty account</button></p>
    </section>

    <OtpModal
      isOpen={showOtpModal}
      email={email}
      purpose={otpPurpose}
      onClose={() => setShowOtpModal(false)}
      onVerified={(code) => {
        setVerifiedOtpCode(code)
        setShowOtpModal(false)
      }}
    />

    {verifiedOtpCode && !resetSent && (
      <div className="modal-backdrop" style={{ zIndex: 1000 }}>
        <div className="modal-content" style={{ maxWidth: '420px', padding: '2rem', background: '#131d1b', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '16px', color: '#f1f5f9' }}>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.2rem', color: '#fff' }}>Set a new password</h3>
          <p style={{ fontSize: '0.88rem', color: '#94a3b8', margin: '0 0 1.25rem' }}>Identity verified for <strong style={{ color: '#34d399' }}>{email}</strong>. Choose a new password of at least 12 characters.</p>
          {resetError && <div className="login-error" style={{ marginBottom: '1rem' }}><AlertTriangle size={16} />{resetError}</div>}
          <label className="field-label" style={{ color: '#cbd5e1' }}>New password
            <input className="text-input" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={12} required />
          </label>
          <label className="field-label" style={{ color: '#cbd5e1' }}>Confirm password
            <input className="text-input" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={12} required />
          </label>
          <button className="button button-primary" style={{ width: '100%', justifyContent: 'center', marginTop: '0.5rem' }} onClick={completeReset} disabled={resetting}>
            {resetting ? 'Updating…' : 'Update password'}
          </button>
        </div>
      </div>
    )}
  </main>
}

function PasswordChangeRequired() {
  const { setMustChangePassword, signOut } = useAppStore()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('')
    if (password.length < 12) { setError('Use at least 12 characters.'); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }
    setLoading(true)
    const { error: functionError } = await supabase.functions.invoke('change-own-password', { body: { password } })
    if (functionError) setError(functionError.message); else setMustChangePassword(false)
    setLoading(false)
  }
  return <main className="password-change-page"><form className="password-change-card" onSubmit={submit}><span className="success-mark"><KeyRound size={26}/></span><p className="eyebrow">Temporary credentials</p><h1>Choose a private password</h1><p>The administrator-issued password can only be used to enter this screen. Replace it before continuing.</p>{error && <div className="login-error"><AlertTriangle size={16}/>{error}</div>}<label className="field-label">New password<input className="text-input" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label><label className="field-label">Confirm password<input className="text-input" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required /></label><Button className="full-button" disabled={loading}>{loading && <LoaderCircle className="spin" size={17}/>}Set password and continue</Button><button className="text-button center-button" type="button" onClick={() => signOut()}>Sign out</button></form></main>
}

function FacultyPendingApproval() {
  const signOut = useAppStore(s => s.signOut)
  return (
    <main className="password-change-page">
      <div className="password-change-card">
        <span className="success-mark" style={{color: 'var(--brand-main)'}}><Clock size={26}/></span>
        <h1>Application under review</h1>
        <p>Your faculty application is being reviewed by the administration. You will receive an email with an invitation code once approved.</p>
        <button className="text-button center-button" type="button" onClick={() => signOut()}>Sign out</button>
      </div>
    </main>
  )
}

function FacultyCodeEntry() {
  const { signOut, bootstrap } = useAppStore()
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setLoading(true)
    const { error: fnError } = await supabase.functions.invoke('verify-faculty-code', { body: { inviteToken: code } })
    if (fnError) setError(fnError.message)
    else await bootstrap() // Refresh profile
    setLoading(false)
  }

  return (
    <main className="password-change-page">
      <form className="password-change-card" onSubmit={submit}>
        <span className="success-mark"><KeyRound size={26}/></span>
        <p className="eyebrow">Final Step</p>
        <h1>Enter Invitation Code</h1>
        <p>Your application was approved. Please enter the invitation code sent to your email to activate your account.</p>
        {error && <div className="login-error"><AlertTriangle size={16}/>{error}</div>}
        <label className="field-label">Invitation code<input className="text-input" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required /></label>
        <Button className="full-button" disabled={loading}>{loading && <LoaderCircle className="spin" size={17}/>}Activate Account</Button>
        <button className="text-button center-button" type="button" onClick={() => signOut()}>Sign out</button>
      </form>
    </main>
  )
}

function Workspace() {
  const { role } = useAppStore()
  const [view, setView] = useState<ViewKey>('home')
  const go = (key: ViewKey) => setView(key)

  let content
  if (view === 'profile') content = <ProfileView />
  else if (view === 'history') content = <HistoryView role={role} />
  else if (view === 'classes') content = <StudentClasses go={go} />
  else if (role === 'student' && view === 'mark') content = <MarkAttendance go={go} />
  else if (role === 'faculty' && view === 'session') content = <FacultySession />
  else if (role === 'admin' && view === 'people') content = <PeopleView />
  else if (role === 'admin' && view === 'passwords') content = <PasswordRequestsView />
  else if (role === 'admin' && view === 'review') content = <ReviewQueue />
  else if (role === 'admin' && view === 'settings') content = <SettingsView />
  else if (role === 'admin' && view === 'invites') content = <InvitationCodesView />
  else if (view === 'queries') content = <AttendanceQueriesView />
  else if (view === 'mail') content = <MailCenter />
  else if (role === 'faculty') content = <FacultyDashboard go={go} />
  else if (role === 'admin') content = <AdminDashboard go={go} />
  else content = <StudentDashboard go={go} />

  return <Shell view={view} setView={setView}>{content}</Shell>
}

export function App() {
  const { authenticated, authLoading, bootstrap, profile } = useAppStore()
  const [developerModeBlocked, setDeveloperModeBlocked] = useState(false)
  const [checkingDevMode, setCheckingDevMode] = useState(false)
  const [landingOpen, setLandingOpen] = useState(true)

  const verifyDevMode = async () => {
    setCheckingDevMode(true)
    try {
      const integrity = await checkDeviceIntegrity()
      console.log('[AttendX] Developer mode check result:', JSON.stringify(integrity))
      setDeveloperModeBlocked(Boolean(integrity.developerMode))
    } catch (err) {
      console.warn('[AttendX] Developer mode check error:', err)
      setDeveloperModeBlocked(false)
    } finally {
      setCheckingDevMode(false)
    }
  }

  // A 401 anywhere (bell poll, Mail Center, data calls) means the stored
  // token is stale — return to the login screen instead of spamming 401s.
  useEffect(() => {
    const onSessionExpired = () => { void useAppStore.getState().signOut() }
    window.addEventListener('attendx:session-expired', onSessionExpired)
    return () => window.removeEventListener('attendx:session-expired', onSessionExpired)
  }, [])

  useEffect(() => {
    // Native app: never park on the web landing page.
    if (isNativeApp()) setLandingOpen(false)
  }, [])

  useEffect(() => {
    void verifyDevMode()
    void bootstrap()

    // Re-verify immediately when user returns to app from Android Settings
    const onFocusOrResume = () => {
      void verifyDevMode()
    }
    window.addEventListener('focus', onFocusOrResume)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void verifyDevMode()
      }
    })
    return () => {
      window.removeEventListener('focus', onFocusOrResume)
    }
  }, [bootstrap])

  if (developerModeBlocked) {
    return (
      <main
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          background: '#090e0c',
          color: '#ffffff',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: '68px',
            height: '68px',
            borderRadius: '50%',
            background: 'rgba(239, 68, 68, 0.12)',
            border: '2px solid rgba(239, 68, 68, 0.35)',
            display: 'grid',
            placeItems: 'center',
            marginBottom: '1.25rem',
            color: '#ef4444',
          }}
        >
          <ShieldAlert size={36} />
        </div>

        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, margin: '0 0 0.5rem', color: '#ffffff' }}>
          Developer Options Detected
        </h1>
        <p
          style={{
            maxWidth: '360px',
            fontSize: '0.9rem',
            lineHeight: 1.5,
            color: '#94a3b8',
            margin: '0 0 1.75rem',
          }}
        >
          AttendX attendance integrity policy blocks access while Android Developer Options or USB Debugging is active on this device.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%', maxWidth: '300px' }}>
          <Button
            onClick={() => openDeveloperSettings()}
            style={{ width: '100%', justifyContent: 'center', background: '#10b981', color: '#ffffff' }}
          >
            Open Device Settings
          </Button>

          <Button
            variant="secondary"
            disabled={checkingDevMode}
            onClick={() => verifyDevMode()}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {checkingDevMode ? 'Checking...' : 'Re-check Status'}
          </Button>
        </div>
      </main>
    )
  }

  if (authLoading) return <div className="app-loading"><Logo/><LoaderCircle className="spin"/></div>
  // The landing page is web marketing — inside the APK it goes straight to
  // sign-in. (Capacitor's bridge can arrive after first paint, so re-check.)
  const showLanding = !isNativeApp() && landingOpen
  if (!authenticated) return showLanding
    ? <Landing onLaunch={() => setLandingOpen(false)} />
    : <Login onBack={() => setLandingOpen(true)} />
  if (profile.must_change_password) return <PasswordChangeRequired />
  if (profile.role === 'faculty' && profile.approval_status === 'pending') return <FacultyPendingApproval />
  if (profile.role === 'faculty' && profile.approval_status === 'approved_waiting_code') return <FacultyCodeEntry />
  return <Workspace />
}
