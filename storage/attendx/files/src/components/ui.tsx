import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { CheckCircle2, Clock3, Flag, XCircle } from 'lucide-react'

export function Button({ className = '', variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button className={`button button-${variant} ${className}`} {...props} />
}

export function StatusPill({ status }: { status: string }) {
  const config: Record<string, { icon: ReactNode; label: string }> = {
    present: { icon: <CheckCircle2 size={14} />, label: 'Present' },
    flagged: { icon: <Flag size={14} />, label: 'Needs review' },
    rejected: { icon: <XCircle size={14} />, label: 'Rejected' },
    pending_review: { icon: <Clock3 size={14} />, label: 'Pending' },
    absent: { icon: <Clock3 size={14} />, label: 'Not marked' }
  }
  const item = config[status] || config.pending_review
  return <span className={`status status-${status}`}>{item.icon}{item.label}</span>
}

export function Initials({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const letters = name.split(' ').map((part) => part[0]).slice(0, 2).join('')
  return <span className={`avatar avatar-${size}`} aria-hidden="true">{letters}</span>
}

export function Logo({ compact = false, size = 36 }: { compact?: boolean; size?: number }) {
  if (compact) {
    return (
      <div className="logo" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.65rem' }}>
        <img
          src="/logom.png"
          alt="AttendX"
          style={{
            width: `${size}px`,
            height: `${size}px`,
            borderRadius: '8px',
            objectFit: 'contain',
            display: 'block'
          }}
        />
      </div>
    );
  }

  return (
    <div className="logo" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.65rem' }}>
      <img
        src="/logo.png"
        alt="AttendX Logo"
        style={{
          height: `${size + 8}px`,
          width: 'auto',
          maxWidth: '220px',
          objectFit: 'contain',
          display: 'block'
        }}
      />
    </div>
  );
}

