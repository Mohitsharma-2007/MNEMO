import { useState, useRef, useEffect, type KeyboardEvent, type ClipboardEvent } from 'react';
import { ShieldCheck, Mail, ArrowRight, RefreshCw, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from './ui';
import { getLocalServerUrl } from '../lib/supabase';

interface OtpModalProps {
  email: string;
  purpose?: 'login' | 'signup' | 'password_reset' | 'general';
  isOpen: boolean;
  onClose: () => void;
  /** Called when the code verifies. For password_reset the verified code is passed back so the reset can be completed. */
  onSuccess?: () => void;
  onVerified?: (code: string) => void;
}

export function OtpModal({ email, purpose = 'login', isOpen, onClose, onSuccess, onVerified }: OtpModalProps) {
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (!isOpen) {
      setDigits(['', '', '', '', '', '']);
      setError('');
      setSuccessMsg('');
      setCountdown(60);
      return;
    }
    // Auto-focus first input when opened
    setTimeout(() => {
      inputRefs.current[0]?.focus();
    }, 100);
  }, [isOpen]);

  useEffect(() => {
    if (countdown > 0 && isOpen) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [countdown, isOpen]);

  if (!isOpen) return null;

  const handleChange = (index: number, val: string) => {
    const char = val.slice(-1);
    if (!/^\d*$/.test(char)) return;

    const next = [...digits];
    next[index] = char;
    setDigits(next);
    setError('');

    if (char && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // If all 6 digits entered, auto-verify
    if (char && index === 5 && next.every((d) => d !== '')) {
      verifyCode(next.join(''));
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').trim();
    if (/^\d{6}$/.test(pasted)) {
      const arr = pasted.split('');
      setDigits(arr);
      inputRefs.current[5]?.focus();
      verifyCode(pasted);
    }
  };

  const verifyCode = async (codeStr: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${getLocalServerUrl()}/api/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: codeStr, purpose }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || 'Invalid or expired verification code');
      } else {
        setSuccessMsg('Code verified successfully!');
        setTimeout(() => {
          if (onVerified) onVerified(codeStr);
          else onSuccess?.();
        }, 600);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (countdown > 0) return;
    setResending(true);
    setError('');
    try {
      const res = await fetch(`${getLocalServerUrl()}/api/auth/send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, purpose }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || data.message || 'Failed to resend code');
      } else {
        setCountdown(60);
        setSuccessMsg('New security code sent to your email');
        setTimeout(() => setSuccessMsg(''), 4000);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 1000 }}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '420px',
          padding: '2rem',
          background: '#131d1b',
          border: '1px solid rgba(16, 185, 129, 0.25)',
          borderRadius: '16px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          textAlign: 'center',
          color: '#f1f5f9',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '-10px' }}>
          <button className="icon-button" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </div>

        <div
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            background: 'rgba(16, 185, 129, 0.12)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            display: 'grid',
            placeItems: 'center',
            margin: '0 auto 1.25rem',
            color: '#10b981',
          }}
        >
          <ShieldCheck size={28} />
        </div>

        <h3 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '0 0 0.4rem', color: '#ffffff' }}>
          Security Verification
        </h3>
        <p style={{ fontSize: '0.88rem', color: '#94a3b8', margin: '0 0 1.5rem', lineHeight: 1.5 }}>
          Enter the 6-digit code sent via Gmail to <br />
          <strong style={{ color: '#34d399' }}>{email}</strong>
        </p>

        {/* 6 Digit segmented input boxes */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '0.5rem',
            marginBottom: '1.25rem',
          }}
        >
          {digits.map((digit, idx) => (
            <input
              key={idx}
              ref={(el) => { inputRefs.current[idx] = el; }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={(e) => handleChange(idx, e.target.value)}
              onKeyDown={(e) => handleKeyDown(idx, e)}
              onPaste={handlePaste}
              style={{
                width: '46px',
                height: '54px',
                fontSize: '1.5rem',
                fontWeight: 700,
                textAlign: 'center',
                background: '#0b1311',
                border: digit ? '2px solid #10b981' : '1px solid #223733',
                borderRadius: '10px',
                color: '#ffffff',
                outline: 'none',
                boxShadow: digit ? '0 0 10px rgba(16, 185, 129, 0.25)' : 'none',
                transition: 'all 0.15s ease',
              }}
            />
          ))}
        </div>

        {error && (
          <div
            style={{
              padding: '0.6rem',
              borderRadius: '8px',
              backgroundColor: 'rgba(239, 68, 68, 0.15)',
              color: '#ef4444',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.4rem',
              marginBottom: '1rem',
            }}
          >
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {successMsg && (
          <div
            style={{
              padding: '0.6rem',
              borderRadius: '8px',
              backgroundColor: 'rgba(34, 197, 94, 0.15)',
              color: '#22c55e',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.4rem',
              marginBottom: '1rem',
            }}
          >
            <CheckCircle2 size={15} />
            {successMsg}
          </div>
        )}

        <Button
          style={{ width: '100%', marginBottom: '1rem', justifyContent: 'center' }}
          disabled={loading || digits.some((d) => !d)}
          onClick={() => verifyCode(digits.join(''))}
        >
          {loading ? 'Verifying...' : 'Verify Code'}
          <ArrowRight size={16} />
        </Button>

        <div style={{ fontSize: '0.85rem', color: '#64748b' }}>
          Didn't receive the email?{' '}
          <button
            type="button"
            className="text-button"
            disabled={countdown > 0 || resending}
            onClick={handleResend}
            style={{
              color: countdown > 0 ? '#64748b' : '#38bdf8',
              cursor: countdown > 0 ? 'default' : 'pointer',
              fontWeight: 600,
            }}
          >
            {resending ? 'Sending...' : countdown > 0 ? `Resend in ${countdown}s` : 'Resend code'}
          </button>
        </div>
      </div>
    </div>
  );
}
