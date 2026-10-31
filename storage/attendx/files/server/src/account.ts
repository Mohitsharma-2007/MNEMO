import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { getOne, execute } from './db.js';
import { verifyOtpCode } from './otp.js';
import { saveBase64Image } from './auth.js';

/**
 * POST /api/auth/reset-password
 * Body: { email, code, newPassword }
 * Completes the Gmail-SMTP OTP password reset: verify the code, then set the
 * new password and force a password change on next sign-in.
 */
export async function handleResetPassword(req: Request, res: Response) {
  try {
    const { email, code, newPassword } = req.body || {};
    if (!email || !code || !newPassword) {
      res.status(400).json({ error: 'Email, verification code, and new password are required' });
      return;
    }
    if (String(newPassword).length < 12) {
      res.status(400).json({ error: 'Password must be at least 12 characters' });
      return;
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const user = await getOne('SELECT id FROM profiles WHERE lower(email) = ?', [cleanEmail]);
    if (!user) {
      res.status(404).json({ error: 'No account found for this email' });
      return;
    }

    const valid = await verifyOtpCode(cleanEmail, String(code), 'password_reset');
    if (!valid) {
      res.status(400).json({ error: 'Invalid or expired verification code' });
      return;
    }

    const { hashPassword } = await import('./db.js');
    const hash = hashPassword(String(newPassword));
    await execute(
      'UPDATE profiles SET password_hash = ?, must_change_password = 1 WHERE id = ?',
      [hash, user.id]
    );
    await execute(
      `INSERT INTO audit_logs (id, actor_id, action, target_table, target_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), user.id, 'otp_password_reset', 'profiles', user.id, '{}', new Date().toISOString()]
    );

    res.json({ success: true, message: 'Password updated. You can now sign in with your new password.' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

/**
 * POST /api/profile/photo
 * Body: { dataUrl } — stores the live face capture on disk and links it to the
 * profile (replaces Supabase storage uploads).
 */
export async function handleProfilePhoto(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      res.status(400).json({ error: 'A captured image data URL is required' });
      return;
    }
    const photoPath = saveBase64Image(dataUrl, `profiles/${user.id}`, 'face');
    if (!photoPath) {
      res.status(400).json({ error: 'Unsupported image format. Use JPEG, PNG, or WebP.' });
      return;
    }
    await execute('UPDATE profiles SET enrollment_photo_path = ? WHERE id = ?', [photoPath, user.id]);

    // Best-effort face embedding refresh for future verification
    try {
      const { extractFaceEmbedding } = await import('./localAi.js');
      const faceResult = await extractFaceEmbedding(dataUrl);
      await execute('DELETE FROM face_profiles WHERE user_id = ?', [user.id]);
      await execute(
        `INSERT INTO face_profiles (id, user_id, model, model_version, embedding, quality_score, source_photo_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), user.id, faceResult.model, faceResult.model_version,
         JSON.stringify(faceResult.embedding), faceResult.quality_score, photoPath]
      );
    } catch {
      // Verification enrollment is optional; profile photo is already saved.
    }

    res.json({ success: true, photoPath });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
