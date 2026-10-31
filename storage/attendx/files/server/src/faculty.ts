import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { query, getOne, execute, getMongoDb, isMongoActive } from './db.js';
import { sendFacultyCodeEmail } from './mailer.js';

/**
 * Faculty verification lifecycle:
 *  1. Faculty signs up -> approval_status = 'pending'
 *  2. Admin approves via this module -> status becomes 'approved_waiting_code'
 *     and a unique invitation code is generated and emailed via Gmail SMTP.
 *  3. Faculty enters the code (handleVerifyFacultyCode) -> 'approved'.
 */

export function generateInviteCode(): string {
  return `FAC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ── GET /api/faculty/pending — list faculty awaiting approval ─────────
export async function handleListPendingFaculty(_req: Request, res: Response) {
  try {
    if (isMongoActive()) {
      const docs = await getMongoDb()!
        .collection('profiles')
        .find({ role: 'faculty', approval_status: 'pending' })
        .sort({ created_at: -1 })
        .toArray();
      res.json(docs.map((d: any) => {
        const { _id, ...rest } = d;
        return { ...rest, id: rest.id || String(_id) };
      }));
      return;
    }
    const rows = await query(
      `SELECT id, email, full_name, identifier, department, approval_status, created_at
       FROM profiles WHERE role = 'faculty' AND approval_status = 'pending'
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── POST /api/faculty/approve — admin approves and emails the code ────
export async function handleApproveFaculty(req: Request, res: Response) {
  try {
    const admin = (req as any).user;
    if (admin.role !== 'admin') {
      res.status(403).json({ error: 'Only administrators can approve faculty' });
      return;
    }
    const { facultyId } = req.body || {};
    if (!facultyId) {
      res.status(400).json({ error: 'facultyId is required' });
      return;
    }
    const faculty = await getOne(
      `SELECT id, email, full_name, approval_status FROM profiles WHERE id = ? AND role = 'faculty'`,
      [facultyId]
    );
    if (!faculty) {
      res.status(404).json({ error: 'Faculty account not found' });
      return;
    }
    if (faculty.approval_status === 'approved') {
      res.status(409).json({ error: 'This faculty account is already approved' });
      return;
    }

    const code = generateInviteCode();
    await execute(`UPDATE profiles SET approval_status = 'approved_waiting_code', invite_code = ? WHERE id = ?`, [code, faculty.id]);

    const delivered = await sendFacultyCodeEmail(faculty.email, faculty.full_name, code);

    await execute(
      `INSERT INTO audit_logs (id, actor_id, action, target_table, target_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), admin.id, 'faculty_approved', 'profiles', faculty.id,
       JSON.stringify({ email_delivered: delivered, code }), new Date().toISOString()]
    );

    res.json({
      success: true,
      code,
      emailSent: delivered,
      message: delivered
        ? 'Faculty approved. The invitation code was emailed to them.'
        : 'Faculty approved, but the email could not be sent. Share the code manually.',
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── POST /api/functions/verify-faculty-code — faculty enters their code
export async function handleVerifyFacultyCode(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { inviteToken } = req.body || {};
    if (!inviteToken || !String(inviteToken).trim()) {
      res.status(400).json({ error: 'Invitation code is required' });
      return;
    }
    if (user.role !== 'faculty') {
      res.status(403).json({ error: 'Only faculty accounts can redeem invitation codes' });
      return;
    }

    const fresh = await getOne('SELECT invite_code, approval_status FROM profiles WHERE id = ?', [user.id]);
    if (!fresh) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    if (fresh.approval_status === 'approved') {
      res.json({ success: true, message: 'Account is already active' });
      return;
    }
    if (fresh.approval_status !== 'approved_waiting_code') {
      res.status(409).json({ error: 'Your application has not been approved yet' });
      return;
    }
    if (!fresh.invite_code || String(inviteToken).trim().toUpperCase() !== String(fresh.invite_code).toUpperCase()) {
      res.status(400).json({ error: 'Invalid invitation code. Check the email from AttendX.' });
      return;
    }

    await execute(`UPDATE profiles SET approval_status = 'approved', invite_code = NULL WHERE id = ?`, [user.id]);
    res.json({ success: true, message: 'Faculty account activated' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
