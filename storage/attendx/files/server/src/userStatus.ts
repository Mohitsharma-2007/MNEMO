import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { getOne, execute } from './db.js';
import { sendAccountActivatedEmail, sendAccountDeactivatedEmail } from './mailer.js';

/**
 * PATCH /api/admin/users/:id/status
 * Body: { isActive: boolean, reason?: string }
 * Activates or deactivates an account and emails the owner automatically.
 * Every change is written to the audit log.
 */
export async function handleSetUserStatus(req: Request, res: Response) {
  try {
    const admin = (req as any).user;
    if (admin.role !== 'admin') {
      res.status(403).json({ error: 'Only administrators can change account status' });
      return;
    }
    const { id } = req.params;
    const { isActive, reason } = req.body || {};
    if (typeof isActive !== 'boolean') {
      res.status(400).json({ error: 'isActive (boolean) is required' });
      return;
    }
    if (id === admin.id) {
      res.status(400).json({ error: 'You cannot change your own account status' });
      return;
    }

    const target = await getOne('SELECT id, email, full_name, is_active FROM profiles WHERE id = ?', [id]);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const currentActive = Boolean(target.is_active);
    if (currentActive === isActive) {
      res.json({ success: true, message: `User is already ${isActive ? 'active' : 'inactive'}` });
      return;
    }

    await execute('UPDATE profiles SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
    await execute(
      `INSERT INTO audit_logs (id, actor_id, action, target_table, target_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), admin.id, isActive ? 'account_activated' : 'account_deactivated', 'profiles', id, JSON.stringify({ reason: reason || '' }), new Date().toISOString()],
    );

    let emailSent = false;
    try {
      emailSent = isActive
        ? await sendAccountActivatedEmail(target.email, target.full_name || 'User')
        : await sendAccountDeactivatedEmail(target.email, target.full_name || 'User', String(reason || ''));
    } catch (mailError) {
      console.warn('Account status email failed:', (mailError as Error).message);
    }

    res.json({
      success: true,
      isActive,
      emailSent,
      message: `${target.full_name || 'User'} has been ${isActive ? 'activated' : 'deactivated'}${emailSent ? ' and notified by email' : ''}.`,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
