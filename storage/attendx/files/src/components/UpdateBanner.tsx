import { useEffect, useState } from 'react';
import { RefreshCw, X, ArrowUpCircle } from 'lucide-react';
import { isNativeApp } from '../lib/platform';
import { getLocalServerUrl } from '../lib/apiClient';
import { checkForUpdate, type AppUpdateInfo } from '../lib/appVersion';

const DISMISS_KEY = 'attendx_update_dismissed_version';

/**
 * Update notice for the Android app. Polls the server once per session (and
 * whenever the app resumes) and shows a banner when a newer versionCode is
 * published. The user can open the APK link directly — updating happens by
 * downloading the new release, exactly like the mass-mail button.
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(
    typeof localStorage !== 'undefined' ? localStorage.getItem(DISMISS_KEY) : null,
  );

  useEffect(() => {
    if (!isNativeApp()) return; // web users are always current
    let cancelled = false;

    const verify = async () => {
      const result = await checkForUpdate(getLocalServerUrl());
      if (!cancelled) setInfo(result);
    };
    void verify();

    const onFocus = () => void verify();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void verify();
    });
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  if (!info?.updateAvailable || !info.latestVersion) return null;
  if (dismissed === info.latestVersion) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, info.latestVersion!);
    setDismissed(info.latestVersion);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        margin: '0 0 1rem',
        padding: '0.85rem 1rem',
        border: '1px solid rgba(16, 185, 129, 0.35)',
        borderRadius: '8px',
        background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(59, 130, 246, 0.08))',
      }}
    >
      <ArrowUpCircle size={22} style={{ color: '#10b981', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ display: 'block', fontSize: '0.9rem' }}>
          Update available — v{info.latestVersion}
        </strong>
        <small style={{ display: 'block', color: 'var(--muted)', fontSize: '0.78rem' }}>
          You are on v{info.currentVersion}. Tap update to download the latest APK.
        </small>
      </div>
      <a
        href={info.apkUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.35rem',
          padding: '0.45rem 0.9rem',
          borderRadius: '7px',
          background: '#10b981',
          color: '#04110d',
          fontSize: '0.8rem',
          fontWeight: 700,
          textDecoration: 'none',
          flexShrink: 0,
        }}
      >
        <RefreshCw size={14} />
        Update
      </a>
      <button
        className="icon-button"
        onClick={dismiss}
        aria-label="Dismiss update notice"
        style={{ flexShrink: 0 }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
