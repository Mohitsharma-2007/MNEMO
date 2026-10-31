import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { query, execute, getMongoDb, isMongoActive } from './db.js';
import { transporter, FROM_HEADER, smtpConfigured, ADMIN_NOTIFY_EMAIL } from './mailer.js';

/**
 * Admin mass-mail system.
 *
 * Sends a notice to every active user (optionally filtered by role) using the
 * Gmail SMTP transport, with the latest APK download link appended so users
 * can update the Android app straight from the email. Every campaign is
 * recorded in the audit log with recipient counts.
 */

function apkLinkHtml(apkUrl: string, version: string | null): string {
  return `
    <div class="highlight">
      <p style="margin:0 0 6px;font-size:12px;color:#64748b;">${version ? `ATTENDX ANDROID APP · v${version}` : 'ATTENDX ANDROID APP'}</p>
      <p style="margin:0 0 12px;color:#e2e8f0;font-size:14px;">Update or install the latest Android app:</p>
      <a href="${apkUrl}" style="display:inline-block;background:#10b981;color:#04110d;font-weight:800;font-size:14px;padding:12px 26px;border-radius:8px;text-decoration:none;">Download / Update APK</a>
      <p style="margin:10px 0 0;font-size:11px;color:#64748b;">If the button does not work, open: ${apkUrl}</p>
    </div>
  `;
}

function noticeShell(title: string, bodyHtml: string, apkUrl: string, version: string | null, includeApk: boolean): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b1311; color: #f1f5f9; margin: 0; padding: 24px; }
        .card { max-width: 540px; margin: 0 auto; background: #131d1b; border: 1px solid #223733; border-radius: 14px; padding: 32px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .logo { font-weight: 800; font-size: 20px; color: #10b981; margin-bottom: 24px; letter-spacing: 0.5px; }
        .logo span { color: #f1f5f9; }
        h1 { font-size: 20px; margin: 0 0 12px; color: #ffffff; }
        p { font-size: 14px; color: #94a3b8; line-height: 1.6; margin: 0 0 14px; }
        .msg { background: #0b1311; border: 1px solid #1e293b; border-radius: 10px; padding: 16px; color: #e2e8f0; font-size: 14px; line-height: 1.6; white-space: pre-wrap; }
        .highlight { background: linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(59, 130, 246, 0.12)); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 10px; padding: 18px; text-align: center; margin: 22px 0; }
        .footer { border-top: 1px solid #1e293b; padding-top: 16px; margin-top: 24px; font-size: 12px; color: #64748b; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo"><span>Attend</span>X</div>
        <h1>${title}</h1>
        <p>An official notice from your institution's administration:</p>
        <div class="msg">${bodyHtml}</div>
        ${includeApk ? apkLinkHtml(apkUrl, version) : ''}
        <div class="footer">AttendX · Institutional attendance infrastructure</div>
      </div>
    </body>
    </html>
  `;
}

// ── GET /api/admin/mass-email/recipients — preview recipient count ────
export async function handleMassEmailRecipients(req: Request, res: Response) {
  try {
    const admin = (req as any).user;
    if (admin.role !== 'admin') {
      res.status(403).json({ error: 'Only administrators can send notices' });
      return;
    }
    const role = String((req.query.role as string) || 'all');
    const params: any[] = [];
    let where = 'is_active IN (1, true)';
    if (role !== 'all') {
      where += ' AND role = ?';
      params.push(role);
    }
    const rows = await query(
      `SELECT email, full_name, role FROM profiles WHERE ${where} ORDER BY role, full_name`,
      params
    );
    res.json({ count: rows.length, recipients: rows.slice(0, 500) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── POST /api/admin/mass-email — send the notice ──────────────────────
export async function handleMassEmail(req: Request, res: Response) {
  try {
    const admin = (req as any).user;
    if (admin.role !== 'admin') {
      res.status(403).json({ error: 'Only administrators can send notices' });
      return;
    }
    if (!smtpConfigured) {
      res.status(503).json({ error: 'SMTP is not configured on the server. Set SMTP_USER and SMTP_PASS.' });
      return;
    }

    const { subject, message, role, includeApkLink, apkUrl, apkVersion } = req.body || {};
    if (!subject || !message) {
      res.status(400).json({ error: 'Subject and message are required' });
      return;
    }
    const targetRole = role && role !== 'all' ? String(role) : 'all';
    const withApk = Boolean(includeApkLink);
    const link = String(apkUrl || `https://github.com/Mohitsharma-2007/AttendX/releases/latest`);

    const params: any[] = [];
    let where = 'is_active IN (1, true)';
    if (targetRole !== 'all') {
      where += ' AND role = ?';
      params.push(targetRole);
    }
    const recipients = await query(
      `SELECT email, full_name FROM profiles WHERE ${where}`,
      params
    );
    if (!recipients.length) {
      res.status(404).json({ error: 'No active recipients match this filter' });
      return;
    }

    const html = noticeShell(
      String(subject),
      String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      link,
      apkVersion || null,
      withApk,
    );
    const text = `${subject}\n\n${message}${withApk ? `\n\nDownload / update the Android app: ${link}` : ''}`;

    let sent = 0;
    let failed = 0;
    const failures: string[] = [];
    // Small batches keep Gmail SMTP happy (anti-burst pacing).
    for (const person of recipients) {
      if (!person?.email) continue;
      try {
        await transporter.sendMail({
          from: FROM_HEADER,
          to: person.email,
          subject: `[AttendX] ${subject}`,
          html,
          text,
        });
        sent += 1;
      } catch {
        failed += 1;
        if (failures.length < 10) failures.push(person.email);
      }
    }

    const campaignId = crypto.randomUUID();
    await execute(
      `INSERT INTO audit_logs (id, actor_id, action, target_table, target_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [campaignId, admin.id, 'mass_email_sent', 'profiles', null,
       JSON.stringify({ subject, role: targetRole, recipients: recipients.length, sent, failed, includeApkLink: withApk }),
       new Date().toISOString()]
    );

    // Record the campaign for the admin panel history (Mongo primary).
    if (isMongoActive()) {
      await getMongoDb()!.collection('email_campaigns').insertOne({
        id: campaignId,
        subject,
        role: targetRole,
        recipients: recipients.length,
        sent,
        failed,
        include_apk_link: withApk,
        sent_by: admin.email,
        created_at: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      campaignId,
      recipients: recipients.length,
      sent,
      failed,
      failures,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// Re-export so the admin panel can surface the notify address if needed.
export { ADMIN_NOTIFY_EMAIL };
