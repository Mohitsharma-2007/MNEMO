import { useState, useEffect } from 'react';
import { Server, Database, Download, CheckCircle2, AlertCircle, RefreshCw, ShieldCheck, Mail, Users, Send } from 'lucide-react';
import { Button } from './ui';
import { getLocalServerUrl, setLocalServerUrl } from '../lib/apiClient';

function MassMailPanel() {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [role, setRole] = useState('all');
  const [includeApk, setIncludeApk] = useState(true);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [recipientCount, setRecipientCount] = useState<number | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('attendx_auth_token') || '';
    fetch(`${getLocalServerUrl()}/api/admin/mass-email/recipients?role=${role}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Failed'))))
      .then((data) => setRecipientCount(data.count))
      .catch(() => setRecipientCount(null));
  }, [role]);

  const send = async () => {
    if (!subject.trim() || !message.trim()) {
      setResult({ ok: false, text: 'Add a subject and a message before sending.' });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const token = localStorage.getItem('attendx_auth_token') || '';
      const res = await fetch(`${getLocalServerUrl()}/api/admin/mass-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          subject: subject.trim(),
          message: message.trim(),
          role,
          includeApkLink: includeApk,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not send the notice');
      setResult({
        ok: true,
        text: `Notice sent to ${data.sent} of ${data.recipients} recipients${data.failed ? ` (${data.failed} failed)` : ''}.`,
      });
      setSubject('');
      setMessage('');
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    }
    setSending(false);
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <Mail size={20} />
          <h2>Mass Mail — Notice to Users</h2>
        </div>
      </div>
      <div className="panel-body">
      <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
        Send an official email notice to every active user. Include the latest
        Android APK link so everyone can update the app straight from the mail.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <label className="field-label" style={{ marginBottom: 0, flex: 1, minWidth: '180px' }}>
            Audience
            <select className="text-input" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="all">Everyone (students + faculty)</option>
              <option value="student">Students only</option>
              <option value="faculty">Faculty only</option>
            </select>
          </label>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.4rem', paddingBottom: '17px', fontSize: '0.85rem', color: 'var(--muted)' }}>
            <Users size={16} />
            <span>{recipientCount === null ? '…' : `${recipientCount} recipient${recipientCount === 1 ? '' : 's'}`}</span>
          </div>
        </div>
        <label className="field-label" style={{ marginBottom: 0 }}>
          Subject
          <input
            className="text-input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="New app update available — please update AttendX"
          />
        </label>
        <label className="field-label" style={{ marginBottom: 0 }}>
          Message
          <textarea
            className="text-input"
            style={{ minHeight: '110px', paddingTop: '10px', resize: 'vertical' }}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Dear users, a new version of the AttendX Android app is available. Please update using the button below…"
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.88rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            className="toggle"
            checked={includeApk}
            onChange={(e) => setIncludeApk(e.target.checked)}
          />
          Attach the latest APK download link to this notice
        </label>
        <div>
          <Button onClick={send} disabled={sending}>
            <Send size={16} />
            {sending ? 'Sending…' : 'Send notice to everyone'}
          </Button>
        </div>
      </div>
      {result && (
        <div
          style={{
            marginTop: '0.9rem',
            padding: '0.6rem 0.9rem',
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.88rem',
            backgroundColor: result.ok ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
            color: result.ok ? '#22c55e' : '#ef4444',
          }}
        >
          {result.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          {result.text}
        </div>
      )}
      </div>
    </section>
  );
}

export function ServerAndSyncSettings() {
  const [serverUrl, setServerUrlState] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setServerUrlState(getLocalServerUrl());
  }, []);

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const base = serverUrl.replace(/\/$/, '');
    // /api/health exists on both the Vercel serverless function and the
    // standalone server; /health only exists standalone. The first request
    // can absorb a serverless cold start, so allow 15s and retry once.
    const tryHealth = async (path: string) => {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15000) });
      return res.ok ? ((await res.json()) as { database?: string }) : null;
    };
    let json: { database?: string } | null = null;
    for (let attempt = 0; attempt < 2 && !json; attempt++) {
      try {
        json = await tryHealth('/api/health');
      } catch {
        /* cold start or network blip — retry */
      }
    }
    if (!json) {
      try {
        json = await tryHealth('/health');
      } catch {
        /* reported below */
      }
    }
    if (json) {
      setTestResult({
        ok: true,
        message: `Connected! Database: ${(json.database || 'active').toUpperCase()}`,
      });
      setLocalServerUrl(serverUrl);
    } else {
      setTestResult({
        ok: false,
        message: 'Could not reach the server. Check the URL and your network — the first request after idle can take up to 15s.',
      });
    }
    setTesting(false);
  };

  const handleExportBackup = async () => {
    setExporting(true);
    try {
      const res = await fetch(`${getLocalServerUrl()}/api/sync/export-json`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'attendx-backup.json';
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginTop: '1.5rem' }}>
      {/* Server / Database connection */}
      <section className="panel">
        <div className="panel-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Server size={20} />
            <h2>Server & Database Connection</h2>
          </div>
        </div>
        <div className="panel-body">
        <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          Connect this web application or mobile device to the AttendX server.
          Data is stored in MongoDB Atlas with an embedded fallback for offline use.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            className="text-input"
            value={serverUrl}
            onChange={(e) => setServerUrlState(e.target.value)}
            placeholder="http://localhost:3001 or http://192.168.1.50:3001"
            style={{ flex: 1, minWidth: '280px' }}
          />
          <Button onClick={handleTestConnection} disabled={testing}>
            <RefreshCw size={16} className={testing ? 'spin' : ''} />
            {testing ? 'Testing...' : 'Test & Save'}
          </Button>
        </div>
        {testResult && (
          <div
            style={{
              marginTop: '0.75rem',
              padding: '0.6rem 0.9rem',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.88rem',
              backgroundColor: testResult.ok ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
              color: testResult.ok ? '#22c55e' : '#ef4444',
            }}
          >
            {testResult.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            {testResult.message}
          </div>
        )}
        </div>
      </section>

      {/* Data & backup */}
      <section className="panel">
        <div className="panel-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Database size={20} />
            <h2>Data & Backup</h2>
          </div>
        </div>
        <div className="panel-body">
          <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
            Export a full JSON snapshot of the database — profiles, classes, attendance records, and queries.
          </p>
          <Button variant="secondary" onClick={handleExportBackup} disabled={exporting}>
            <Download size={16} />
            {exporting ? 'Preparing…' : 'Export Database Backup (JSON)'}
          </Button>
        </div>
      </section>

      {/* Admin mass-mail */}
      <MassMailPanel />

      {/* Security note */}
      <section className="panel">
        <div className="panel-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <ShieldCheck size={20} />
            <h2>Security</h2>
          </div>
        </div>
        <div className="panel-body">
          <p style={{ color: 'var(--muted)', marginBottom: '0', fontSize: '0.9rem' }}>
            Password resets are verified by one-time codes sent through Gmail SMTP.
            Faculty accounts are activated with emailed invitation codes. Attendance
            queries are tracked with unique request numbers and resolved by email.
          </p>
        </div>
      </section>
    </div>
  );
}
