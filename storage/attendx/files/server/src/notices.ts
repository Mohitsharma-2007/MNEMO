import type { Request, Response } from 'express';
import crypto from 'node:crypto';

type Row = Record<string, any>;
import { query, getOne, execute, getMongoDb, isMongoActive } from './db.js';
import { transporter, FROM_HEADER, smtpConfigured, ADMIN_NOTIFY_EMAIL } from './mailer.js';

/**
 * AttendX Mail Center — every institutional email event in one system.
 *
 * Event types cover new-user onboarding, password resets, service requests,
 * complaints, system errors, server outages, app updates, account
 * activation/deactivation, attendance data requests, and more. Every
 * trackable request is stored with a unique request number (ATX-S-XXXXXX)
 * so students and faculty can follow its status, and every transition sends
 * a Gmail SMTP update.
 */

export type NoticeTypeDef = {
  type: string;
  label: string;
  description: string;
  icon: string;
  audience: 'system' | 'users' | 'targeted';
  trackable: boolean;
};

export const NOTICE_TYPES: NoticeTypeDef[] = [
  { type: 'onboarding', label: 'New user onboarding', description: 'Welcome mail sent when a new account joins AttendX.', icon: 'user-plus', audience: 'targeted', trackable: false },
  { type: 'password_reset', label: 'Password reset', description: 'OTP-based password reset and reset confirmations.', icon: 'key-round', audience: 'targeted', trackable: true },
  { type: 'service_request', label: 'Service request', description: 'Ask the administration for a service or change.', icon: 'wrench', audience: 'system', trackable: true },
  { type: 'complaint', label: 'Complaint', description: 'File a formal complaint for review.', icon: 'message-square-warning', audience: 'system', trackable: true },
  { type: 'system_error', label: 'System error', description: 'Report an error you hit inside the app.', icon: 'bug', audience: 'system', trackable: true },
  { type: 'server_down', label: 'Server down', description: 'Report that the AttendX server is unreachable.', icon: 'server-off', audience: 'system', trackable: true },
  { type: 'app_update', label: 'App update', description: 'Broadcast a new Android app release to everyone.', icon: 'smartphone', audience: 'users', trackable: false },
  { type: 'account_activation', label: 'Account activation', description: 'Activate an account and email the user.', icon: 'user-check', audience: 'targeted', trackable: true },
  { type: 'account_deactivation', label: 'Account deactivation', description: 'Deactivate an account and notify its owner.', icon: 'user-x', audience: 'targeted', trackable: true },
  { type: 'attendance_data_request', label: 'Attendance data request', description: 'Request your full attendance record or a correction.', icon: 'clipboard-list', audience: 'system', trackable: true },
  { type: 'general', label: 'General enquiry', description: 'Any other question for the administration.', icon: 'mail', audience: 'system', trackable: true },
];

function typeDef(type: string): NoticeTypeDef | undefined {
  return NOTICE_TYPES.find((t) => t.type === type);
}

function noticesCol() {
  if (!isMongoActive()) return null;
  return getMongoDb()!.collection('system_notices');
}

async function ensureSqliteTable() {
  await execute(`CREATE TABLE IF NOT EXISTS system_notices (
    id TEXT PRIMARY KEY,
    tracking_id TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    subject TEXT,
    message TEXT,
    status TEXT DEFAULT 'open',
    audience TEXT,
    sender_id TEXT,
    sender_name TEXT,
    sender_email TEXT,
    sender_role TEXT,
    target_email TEXT,
    recipients TEXT,
    emailed INTEGER DEFAULT 0,
    admin_note TEXT,
    created_at TEXT,
    updated_at TEXT,
    resolved_at TEXT
  )`);
}

export function generateNoticeTrackingId(): string {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  return `ATX-S-${rand}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function noticeEmailHtml(title: string, rows: Array<[string, string]>, body?: string): string {
  return `
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b1311; color: #f1f5f9; margin: 0; padding: 24px; }
      .card { max-width: 520px; margin: 0 auto; background: #131d1b; border: 1px solid #223733; border-radius: 14px; padding: 32px; }
      .logo { font-weight: 800; font-size: 20px; color: #10b981; margin-bottom: 24px; } .logo span { color: #f1f5f9; }
      h1 { font-size: 20px; margin: 0 0 12px; color: #fff; }
      p { font-size: 14px; color: #94a3b8; line-height: 1.6; }
      .msg { background: #0b1311; border: 1px solid #1e293b; border-radius: 10px; padding: 16px; color: #e2e8f0; font-size: 14px; line-height: 1.6; white-space: pre-wrap; margin-bottom: 16px; }
      .code { font-size: 26px; font-weight: 800; letter-spacing: 3px; color: #34d399; font-family: monospace; }
      .highlight { background: rgba(16,185,129,.08); border: 1px solid rgba(16,185,129,.3); border-radius: 10px; padding: 16px; text-align: center; margin: 18px 0; }
      .row { display: flex; justify-content: space-between; border-bottom: 1px solid #1e293b; padding: 9px 0; font-size: 13px; }
      .row em { color: #64748b; font-style: normal; } .row strong { color: #e2e8f0; text-align: right; }
    </style></head>
    <body><div class="card"><div class="logo"><span>Attend</span>X</div>
    <h1>${title}</h1>
    ${body ? `<div class="msg">${body}</div>` : ''}
    ${rows.map(([k, v]) => `<div class="row"><em>${k}</em><strong>${v}</strong></div>`).join('')}
    <div class="highlight"><p style="margin:0 0 6px;font-size:12px;color:#64748b;">REQUEST NUMBER</p><div class="code">##TRACKING##</div></div>
    <p style="font-size:12px;color:#64748b;margin-top:18px;">Quote this request number in any follow-up. Track its status any time in the Mail Center of AttendX.</p>
    </div></body></html>`;
}

async function deliver(to: string, subject: string, html: string, text: string): Promise<boolean> {
  if (!smtpConfigured || !to) return false;
  try {
    await transporter.sendMail({ from: FROM_HEADER, to, subject, html, text });
    console.log(`[AttendX Mail Center] Delivered "${subject}" to ${to}`);
    return true;
  } catch (err) {
    console.error('[AttendX Mail Center] Delivery failed:', (err as Error).message);
    return false;
  }
}

/** Insert a notice record in the active datastore. */
async function insertNotice(record: Row): Promise<void> {
  if (noticesCol()) {
    await noticesCol()!.insertOne({ ...record });
  } else {
    await ensureSqliteTable();
    const keys = Object.keys(record);
    await execute(
      `INSERT INTO system_notices (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => (typeof (record as any)[k] === 'boolean' ? ((record as any)[k] ? 1 : 0) : (record as any)[k])),
    );
  }
}

// ── GET /api/notices/catalog — the mail event catalog ─────────────────
export async function handleNoticeCatalog(_req: Request, res: Response) {
  res.json({ types: NOTICE_TYPES, smtpConfigured, adminInbox: ADMIN_NOTIFY_EMAIL || null });
}

// ── POST /api/notices — raise a mail request / send an admin mail ─────
export async function handleRaiseNotice(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { type, subject, message, audience, targetEmail, recipientEmails } = req.body || {};
    const def = typeDef(String(type || ''));
    if (!def) {
      res.status(400).json({ error: 'Unknown notice type' });
      return;
    }
    if (!message || !String(message).trim()) {
      res.status(400).json({ error: 'Please write a message' });
      return;
    }

    const isAdmin = user.role === 'admin';
    const trackingId = def.trackable ? generateNoticeTrackingId() : `ATX-N-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const now = new Date().toISOString();

    // Determine recipients:
    //  - admin + audience users → broadcast mail to every active user in audience
    //  - admin + targetEmail → single-user mail (activation, deactivation, …)
    //  - anyone else → the institution administration inbox (+ copy to sender)
    let recipients: string[] = [];
    let finalAudience = def.audience;
    if (isAdmin && (def.audience === 'users' || audience === 'all' || audience === 'student' || audience === 'faculty')) {
      const roleFilter = audience && audience !== 'all' ? String(audience) : def.audience === 'users' ? 'all' : String(audience || 'all');
      const rows = roleFilter === 'all'
        ? await query(`SELECT email FROM profiles WHERE is_active = 1 AND email IS NOT NULL AND email != ''`)
        : await query(`SELECT email FROM profiles WHERE is_active = 1 AND role = ? AND email IS NOT NULL AND email != ''`, [roleFilter]);
      finalAudience = roleFilter;
      recipients = rows.map((r: any) => r.email).filter(Boolean);
    } else if (isAdmin && Array.isArray(recipientEmails) && recipientEmails.length) {
      // Explicit recipient list from the Mail Center picker
      recipients = unique(recipientEmails.map((e: unknown) => String(e).trim().toLowerCase()).filter(Boolean)).slice(0, 200);
      finalAudience = 'selected';
    } else if (isAdmin && targetEmail) {
      recipients = [String(targetEmail).trim().toLowerCase()];
      finalAudience = 'targeted';
    } else {
      recipients = ADMIN_NOTIFY_EMAIL ? [ADMIN_NOTIFY_EMAIL] : [];
      finalAudience = 'admin';
    }

    const record: Row = {
      id: crypto.randomUUID(),
      tracking_id: trackingId,
      type: def.type,
      subject: String(subject || def.label).trim().slice(0, 200),
      message: String(message).trim().slice(0, 4000),
      status: isAdmin ? 'sent' : 'open',
      audience: finalAudience,
      sender_id: user.id,
      sender_name: user.full_name || '',
      sender_email: user.email || '',
      sender_role: user.role,
      target_email: recipients.length === 1 ? recipients[0] : null,
      recipients: JSON.stringify({ count: recipients.length }),
      emailed: false,
      admin_note: '',
      created_at: now,
      updated_at: now,
      resolved_at: isAdmin ? now : null,
    };

    // Deliver the mail(s)
    const title = record.subject || def.label;
    const html = noticeEmailHtml(
      title,
      [
        ['Category', def.label],
        ['From', `${record.sender_name} (${record.sender_email || 'system'})`],
        ...(def.trackable ? [['Status', record.status.toUpperCase()] as [string, string]] : []),
      ],
      record.message,
    ).replace('##TRACKING##', trackingId);
    const text = `${title}\n\n${record.message}\n\nRequest number: ${trackingId}`;

    let delivered = true;
    const cap = 200;
    const targets = recipients.slice(0, cap);
    for (const to of targets) {
      const ok = await deliver(to, `[AttendX] ${title}`, html, text);
      if (!ok) delivered = false;
    }
    if (!targets.length) delivered = false;

    // Copy to the sender when the mail went to the administration
    if (finalAudience === 'admin' && record.sender_email && !targets.includes(record.sender_email)) {
      await deliver(
        record.sender_email,
        `[AttendX] ${def.trackable ? `Request ${trackingId} received` : title}`,
        noticeEmailHtml(
          'Your request has been raised',
          [['Category', def.label, ], ['Status', 'OPEN — under review by the administration']],
          record.message,
        ).replace('##TRACKING##', trackingId),
        text,
      );
    }

    record.emailed = delivered && targets.length > 0;
    await insertNotice(record);

    res.status(201).json({
      success: true,
      trackingId,
      emailSent: record.emailed,
      recipients: targets.length,
      notice: { ...record },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── GET /api/notices — role-aware list + ?trackingId= tracker ─────────
export async function handleListNotices(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { status, trackingId, type } = req.query;

    if (noticesCol()) {
      const filter: Row = {};
      if (user.role !== 'admin') {
        filter.$or = [{ sender_id: user.id }, { audience: { $in: ['all', user.role] } }];
      }
      if (status) filter.status = String(status);
      if (type) filter.type = String(type);
      if (trackingId) filter.tracking_id = String(trackingId).toUpperCase();
      const docs = await noticesCol()!.find(filter).sort({ created_at: -1 }).limit(200).toArray();
      res.json(docs.map((d: any) => ({ ...d, id: d.id || String(d._id) })));
      return;
    }

    await ensureSqliteTable();
    const where: string[] = [];
    const params: any[] = [];
    if (user.role !== 'admin') {
      where.push(`(sender_id = ? OR audience IN ('all', ?))`);
      params.push(user.id, user.role);
    }
    if (status) { where.push('status = ?'); params.push(String(status)); }
    if (type) { where.push('type = ?'); params.push(String(type)); }
    if (trackingId) { where.push('tracking_id = ?'); params.push(String(trackingId).toUpperCase()); }
    const rows = await query(
      `SELECT * FROM system_notices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 200`,
      params,
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── PATCH /api/notices/:id — admin resolves / updates a request ───────
export async function handleResolveNotice(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    if (user.role !== 'admin') {
      res.status(403).json({ error: 'Only administrators can update notices' });
      return;
    }
    const { id } = req.params;
    const { status, adminNote } = req.body || {};
    const allowed = ['open', 'in_review', 'resolved', 'rejected'];
    const nextStatus = allowed.includes(status) ? status : 'resolved';

    let existing: Row | null = null;
    if (noticesCol()) {
      existing = await noticesCol()!.findOne({ id });
    } else {
      await ensureSqliteTable();
      existing = await getOne('SELECT * FROM system_notices WHERE id = ?', [id]);
    }
    if (!existing) {
      res.status(404).json({ error: 'Notice not found' });
      return;
    }

    const now = new Date().toISOString();
    const resolvedAt = nextStatus === 'resolved' || nextStatus === 'rejected' ? now : null;
    if (noticesCol()) {
      await noticesCol()!.updateOne(
        { id },
        { $set: { status: nextStatus, admin_note: adminNote || existing.admin_note || '', updated_at: now, resolved_at: resolvedAt } },
      );
    } else {
      await execute(
        'UPDATE system_notices SET status = ?, admin_note = ?, updated_at = ?, resolved_at = ? WHERE id = ?',
        [nextStatus, adminNote || existing.admin_note || '', now, resolvedAt, id],
      );
    }

    // Email the requester the outcome with their request number
    if (existing.sender_email && nextStatus !== 'open' && existing.audience === 'admin') {
      const html = noticeEmailHtml(
        `Your request is ${nextStatus.replace('_', ' ')}`,
        [
          ['Category', typeDef(existing.type)?.label || existing.type],
          ['Status', nextStatus.toUpperCase()],
          ['Administrator note', adminNote || '—'],
        ],
        '',
      ).replace('##TRACKING##', existing.tracking_id);
      await deliver(
        existing.sender_email,
        `[AttendX] Request ${existing.tracking_id} — ${nextStatus.toUpperCase()}`,
        html,
        `Your AttendX request ${existing.tracking_id} is now ${nextStatus}. Note: ${adminNote || '—'}`,
      );
    }

    res.json({ success: true, status: nextStatus, trackingId: existing.tracking_id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
