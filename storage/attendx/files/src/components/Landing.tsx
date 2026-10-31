import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import {
  ArrowRight, BarChart3, Bell, Fingerprint, Globe2, Inbox,
  MapPin, QrCode, ShieldCheck, Smartphone, Zap,
} from 'lucide-react'
import '../landing.css'

gsap.registerPlugin(ScrollTrigger)

/**
 * AttendX landing page — cinematic dark showcase with GSAP scroll
 * choreography and Lenis smooth scrolling.
 */

const FEATURES = [
  { icon: QrCode, title: 'QR sessions in seconds', text: 'Faculty start a live session, a rotating QR appears, and the whole room is marked before the marker hits the board.' },
  { icon: Inbox, title: 'Mail Center with tracking', text: 'Every complaint, service request and attendance query gets an ATX request number — raised, emailed, resolved, all inside the app.' },
  { icon: Fingerprint, title: 'Face-verified presence', text: 'Live portrait capture and on-device face verification keep proxy attendance out of your classroom.' },
  { icon: MapPin, title: 'Location & device integrity', text: 'Geofenced check-ins and developer-mode detection so the numbers you see are the truth.' },
  { icon: Bell, title: 'Notices that reach everyone', text: 'Broadcast app updates or targeted notices over Gmail SMTP — students and faculty get it in-app and in their inbox.' },
  { icon: BarChart3, title: 'Live analytics', text: 'Attendance percentages, below-75 flags and class summaries update the moment a session closes.' },
]

const SHOWCASE = [
  {
    shot: '/screenshots/mail-center.png',
    tag: 'Mail Center',
    title: 'Every request, tracked to resolution',
    text: 'Students raise complaints, service requests and system-error reports; the administration resolves them with notes that land in the requester\'s inbox. Request numbers stay searchable forever.',
  },
  {
    shot: '/screenshots/classes.png',
    tag: 'Classes & sessions',
    title: 'Your timetable, live',
    text: 'Create classes, schedule sessions, assign batches and run live QR attendance — the roster updates as each student scans in.',
  },
  {
    shot: '/screenshots/queries.png',
    tag: 'Attendance queries',
    title: 'No more “sir, my attendance…”',
    text: 'Missed a mark? Students raise an attendance query with a tracking number, faculty and admin review the evidence, and the fix is emailed automatically.',
  },
]

const STATS = [
  { value: '<3s', label: 'to mark a student present' },
  { value: 'ATX', label: 'request numbers for every query' },
  { value: '100%', label: 'of notices delivered by email' },
  { value: '0', label: 'proxies that get past face checks' },
]

export function Landing({ onLaunch }: { onLaunch: () => void }) {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const lenis = new Lenis({ duration: 1.15, smoothWheel: true })
    lenis.on('scroll', ScrollTrigger.update)
    const raf = (time: number) => lenis.raf(time * 1000)
    if (!prefersReduced) gsap.ticker.add(raf)
    gsap.ticker.lagSmoothing(0)

    const ctx = gsap.context((self) => {
      // Hero intro
      gsap.timeline({ defaults: { ease: 'power3.out' } })
        .from('.ld-nav', { y: -28, opacity: 0, duration: 0.7 })
        .from('.ld-badge', { y: 18, opacity: 0, duration: 0.55 }, '-=0.35')
        .from('.ld-hero h1 .ld-line', { y: 44, opacity: 0, duration: 0.8, stagger: 0.12 }, '-=0.3')
        .from('.ld-hero p.ld-sub', { y: 22, opacity: 0, duration: 0.7 }, '-=0.45')
        .from('.ld-cta-row', { y: 18, opacity: 0, duration: 0.6 }, '-=0.4')
        .from('.ld-hero-meta', { opacity: 0, duration: 0.6 }, '-=0.3')

      // Hero visuals: gentle float + scroll parallax
      gsap.to('.ld-shot-main', { y: -18, repeat: -1, yoyo: true, duration: 4.2, ease: 'sine.inOut' })
      gsap.to('.ld-phone', { y: 16, repeat: -1, yoyo: true, duration: 3.4, ease: 'sine.inOut' })
      gsap.to('.ld-shot-main', {
        yPercent: -10,
        scrollTrigger: { trigger: '.ld-hero', start: 'top top', end: 'bottom top', scrub: true },
      })
      gsap.to('.ld-phone', {
        yPercent: 16,
        scrollTrigger: { trigger: '.ld-hero', start: 'top top', end: 'bottom top', scrub: true },
      })

      // Section reveals
      self.add('.ld-reveal', () => {})
      gsap.utils.toArray<HTMLElement>('.ld-reveal').forEach((el) => {
        gsap.from(el, {
          y: 46,
          opacity: 0,
          duration: 0.9,
          ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 86%' },
        })
      })

      // Feature cards stagger
      gsap.from('.ld-feature', {
        y: 40,
        opacity: 0,
        duration: 0.75,
        stagger: 0.09,
        ease: 'power3.out',
        scrollTrigger: { trigger: '.ld-features', start: 'top 80%' },
      })

      // Showcase screenshots scale-in
      gsap.utils.toArray<HTMLElement>('.ld-showcase-item').forEach((el) => {
        gsap.from(el.querySelector('.ld-shot-frame'), {
          scale: 0.92,
          opacity: 0,
          duration: 1,
          ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 78%' },
        })
      })

      // Stats count-up feel (reveal)
      gsap.from('.ld-stat', {
        y: 26,
        opacity: 0,
        duration: 0.7,
        stagger: 0.08,
        ease: 'power2.out',
        scrollTrigger: { trigger: '.ld-stats', start: 'top 85%' },
      })

      // Marquee drift
      gsap.to('.ld-marquee-inner', { xPercent: -50, duration: 26, repeat: -1, ease: 'none' })
    }, root.current ?? undefined)

    return () => {
      ctx.revert()
      gsap.ticker.remove(raf)
      lenis.destroy()
      ScrollTrigger.getAll().forEach((t) => t.kill())
    }
  }, [])

  return (
    <div className="ld-root" ref={root}>
      {/* ambient glows */}
      <div className="ld-glow ld-glow-a" />
      <div className="ld-glow ld-glow-b" />
      <div className="ld-grid-overlay" />

      <nav className="ld-nav">
        <div className="ld-brand">
          <img src="/logom.png" alt="AttendX" />
          <span>Attend<b>X</b></span>
        </div>
        <div className="ld-links">
          <a href="#features">Features</a>
          <a href="#showcase">Product</a>
          <a href="#security">Security</a>
        </div>
        <button className="ld-btn ld-btn-primary" onClick={onLaunch}>
          Launch app <ArrowRight size={16} />
        </button>
      </nav>

      <header className="ld-hero">
        <span className="ld-badge"><Zap size={13} /> Institutional attendance infrastructure</span>
        <h1>
          <span className="ld-line">Attendance that</span>
          <span className="ld-line">runs <em>itself.</em></span>
        </h1>
        <p className="ld-sub">
          QR sessions, face verification, tracked queries and a full mail center —
          AttendX turns the daily roll call into a five-second tap, on web and Android.
        </p>
        <div className="ld-cta-row">
          <button className="ld-btn ld-btn-primary ld-btn-lg" onClick={onLaunch}>
            Launch the app <ArrowRight size={17} />
          </button>
          <a className="ld-btn ld-btn-ghost ld-btn-lg" href="#showcase">
            See it in action
          </a>
        </div>
        <p className="ld-hero-meta">No setup required · Works on your LAN · MongoDB Atlas backed</p>

        <div className="ld-hero-visual">
          <div className="ld-shot-frame ld-shot-main">
            <div className="ld-frame-bar"><i /><i /><i /><span>attendx — admin workspace</span></div>
            <img src="/screenshots/admin-dashboard.png" alt="AttendX admin dashboard" loading="eager" />
          </div>
          <div className="ld-phone">
            <div className="ld-phone-notch" />
            <img src="/screenshots/mobile-dashboard.png" alt="AttendX mobile" loading="eager" />
          </div>
        </div>
      </header>

      <div className="ld-marquee" aria-hidden="true">
        <div className="ld-marquee-inner">
          {[0, 1].map((k) => (
            <span key={k}>
              {['QR LIVE SESSIONS', 'FACE VERIFICATION', 'TRACKED REQUEST NUMBERS', 'GMAIL SMTP NOTICES', 'LOCATION INTEGRITY', 'LIVE ANALYTICS', 'MONGODB ATLAS'].map((t) => (
                <em key={t}>{t}<i>·</i></em>
              ))}
            </span>
          ))}
        </div>
      </div>

      <section className="ld-section ld-features" id="features">
        <p className="ld-eyebrow ld-reveal">Why AttendX</p>
        <h2 className="ld-reveal">Built for the way your<br />campus actually works.</h2>
        <div className="ld-feature-grid">
          {FEATURES.map((f) => (
            <article className="ld-feature" key={f.title}>
              <span className="ld-feature-icon"><f.icon size={20} /></span>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="ld-section ld-showcase" id="showcase">
        <p className="ld-eyebrow ld-reveal">Product tour</p>
        <h2 className="ld-reveal">One platform.<br />Every attendance conversation.</h2>
        {SHOWCASE.map((s, i) => (
          <div className={`ld-showcase-item ${i % 2 ? 'flip' : ''}`} key={s.tag}>
            <div className="ld-showcase-copy">
              <span className="ld-tag">{s.tag}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
              <button className="ld-btn ld-btn-ghost" onClick={onLaunch}>
                Try it now <ArrowRight size={15} />
              </button>
            </div>
            <div className="ld-shot-frame ld-showcase-shot">
              <div className="ld-frame-bar"><i /><i /><i /><span>attendx — {s.tag.toLowerCase()}</span></div>
              <img src={s.shot} alt={s.title} loading="lazy" />
            </div>
          </div>
        ))}
      </section>

      <section className="ld-section ld-stats">
        {STATS.map((s) => (
          <div className="ld-stat" key={s.label}>
            <strong>{s.value}</strong>
            <span>{s.label}</span>
          </div>
        ))}
      </section>

      <section className="ld-section ld-security" id="security">
        <div className="ld-security-card ld-reveal">
          <div>
            <p className="ld-eyebrow">Security first</p>
            <h2>Hardened by default.</h2>
            <ul>
              <li><ShieldCheck size={17} /> OTP password resets over Gmail SMTP — no reset links to leak</li>
              <li><Smartphone size={17} /> Android app detects developer mode and blocks itself</li>
              <li><Globe2 size={17} /> Console protection with a branded AttendX console</li>
              <li><MapPin size={17} /> Location integrity flags on every check-in</li>
            </ul>
          </div>
          <div className="ld-security-shot">
            <img src="/screenshots/people.png" alt="AttendX people management" loading="lazy" />
          </div>
        </div>
      </section>

      <section className="ld-section ld-final-cta">
        <div className="ld-cta-card ld-reveal">
          <Bell size={26} />
          <h2>Roll call in seconds.<br />Not minutes.</h2>
          <p>Launch the app and take your first attendance session today.</p>
          <button className="ld-btn ld-btn-primary ld-btn-lg" onClick={onLaunch}>
            Launch AttendX <ArrowRight size={17} />
          </button>
        </div>
      </section>

      <footer className="ld-footer">
        <div className="ld-brand">
          <img src="/logom.png" alt="AttendX" />
          <span>Attend<b>X</b></span>
        </div>
        <span className="ld-copy">© {new Date().getFullYear()} AttendX · Institutional attendance infrastructure</span>
      </footer>
    </div>
  )
}
