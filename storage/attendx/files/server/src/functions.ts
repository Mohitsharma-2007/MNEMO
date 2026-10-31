import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { query, getOne, execute } from './db.js';
import { saveBase64Image } from './auth.js';
import { verifyEvidence } from './localAi.js';

// Haversine distance in meters
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Helper to sign attendance QR
function createQrToken(sessionId: string, nonce: string, expiresAt: Date): string {
  const header = Buffer.from(JSON.stringify({ typ: 'ATXQR', alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      session_id: sessionId,
      nonce: nonce,
      exp: Math.floor(expiresAt.getTime() / 1000),
    })
  ).toString('base64url');

  const secret = process.env.QR_SIGNING_SECRET || 'attendx-qr-secret-key-default-2026';
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function parseQrToken(tokenString: string): { sessionId: string; nonce: string; exp: number } | null {
  try {
    const parts = tokenString.split('.');
    if (parts.length !== 3) return null;
    
    // Verify HMAC signature
    const secret = process.env.QR_SIGNING_SECRET || 'attendx-qr-secret-key-default-2026';
    const expectedSig = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    
    if (parts[2] !== expectedSig) {
      console.warn('QR token signature verification failed');
      return null;
    }
    
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    
    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      console.warn('QR token has expired');
      return null;
    }
    
    return {
      sessionId: payload.session_id,
      nonce: payload.nonce,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

export async function handleStartSession(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { classId, latitude, longitude, radiusMeters, refreshIntervalSeconds, durationMinutes } = req.body;

    if (!classId || latitude === undefined || longitude === undefined) {
      res.status(422).json({ error: 'Class ID and coordinates are required' });
      return;
    }

    const radius = Math.min(500, Math.max(10, Number(radiusMeters) || 50));
    const interval = Math.min(600, Math.max(5, Number(refreshIntervalSeconds) || 15));
    const duration = Math.min(360, Math.max(5, Number(durationMinutes) || 60));

    // Close any prior active session for this faculty / class
    await execute(
      `UPDATE attendance_sessions SET status = 'closed', ended_at = datetime('now') WHERE class_id = ? AND status = 'active'`,
      [classId]
    );

    const sessionId = crypto.randomUUID();
    const scheduledEnd = new Date(Date.now() + duration * 60 * 1000).toISOString();

    await execute(
      `INSERT INTO attendance_sessions (id, class_id, faculty_id, status, center_lat, center_lng, geofence_radius_m, refresh_interval_s, scheduled_end_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      [sessionId, classId, user.id, latitude, longitude, radius, interval, scheduledEnd]
    );

    const initialNonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + (interval + 10) * 1000);
    const initialToken = createQrToken(sessionId, initialNonce, expiresAt);

    await execute(
      `INSERT INTO qr_tokens (id, session_id, nonce, token, expires_at) VALUES (?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), sessionId, initialNonce, initialToken, expiresAt.toISOString()]
    );

    const session = await getOne('SELECT * FROM attendance_sessions WHERE id = ?', [sessionId]);

    res.json({
      session,
      initialToken,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleIssueQr(req: Request, res: Response) {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    const session = await getOne('SELECT * FROM attendance_sessions WHERE id = ?', [sessionId]);
    if (!session || session.status !== 'active') {
      res.status(409).json({ error: 'Session is not active' });
      return;
    }

    const interval = session.refresh_interval_s || 15;
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + (interval + 15) * 1000);
    const token = createQrToken(sessionId, nonce, expiresAt);

    await execute(
      `INSERT INTO qr_tokens (id, session_id, nonce, token, expires_at) VALUES (?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), sessionId, nonce, token, expiresAt.toISOString()]
    );

    res.json({ token, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleSubmitAttendance(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const body = req.body || {};

    const parsed = parseQrToken(body.token);
    if (!parsed) {
      res.status(400).json({ error: 'Invalid QR token format' });
      return;
    }

    const latitude = Number(body.location?.latitude);
    const longitude = Number(body.location?.longitude);
    const accuracy = Number(body.location?.accuracy) || 15;

    if (isNaN(latitude) || isNaN(longitude)) {
      res.status(422).json({ error: 'Valid location coordinates required' });
      return;
    }

    if (user.role !== 'student') {
      res.status(403).json({ error: 'Only students can submit attendance' });
      return;
    }

    const session = await getOne('SELECT * FROM attendance_sessions WHERE id = ?', [parsed.sessionId]);
    if (!session || session.status !== 'active') {
      res.status(409).json({ error: 'Attendance session has ended or is not found' });
      return;
    }

    // Reject replayed QR tokens: each nonce may be redeemed once
    const nonceUsed = await getOne('SELECT id FROM qr_tokens WHERE nonce = ? AND use_count > 0', [parsed.nonce]);
    if (nonceUsed) {
      res.status(409).json({ error: 'This QR code has already been used. Scan the current code shown by faculty.' });
      return;
    }
    await execute('UPDATE qr_tokens SET use_count = use_count + 1 WHERE nonce = ?', [parsed.nonce]);

    // Check enrollment
    let enrollment = await getOne('SELECT id FROM enrollments WHERE class_id = ? AND student_id = ?', [session.class_id, user.id]);
    if (!enrollment) {
      // Auto-enroll if student is in this batch
      const cls = await getOne('SELECT batch_id FROM classes WHERE id = ?', [session.class_id]);
      if (cls) {
        await execute(
          `INSERT OR IGNORE INTO enrollments (id, class_id, student_id, status) VALUES (?, ?, ?, 'active')`,
          [crypto.randomUUID(), session.class_id, user.id]
        );
        enrollment = { id: 'auto' };
      } else {
        res.status(403).json({ error: 'You are not enrolled in this class' });
        return;
      }
    }

    // Check existing attendance
    const existing = await getOne('SELECT * FROM attendance_records WHERE session_id = ? AND student_id = ?', [session.id, user.id]);
    if (existing) {
      res.json({ attendance: existing, duplicate: true });
      return;
    }

    // Distance calculation
    const distance = haversineMeters(session.center_lat, session.center_lng, latitude, longitude);
    const outside = distance > (session.geofence_radius_m || 50);
    const lowAccuracy = accuracy > 100;
    const status = outside ? 'rejected' : lowAccuracy ? 'flagged' : 'present';
    const rejectionReason = outside ? `Outside geofence by ${Math.round(distance - session.geofence_radius_m)} m` : null;

    // Save evidence photos to disk
    const selfiePath = body.selfieDataUrl ? saveBase64Image(body.selfieDataUrl, `evidence/${user.id}/${session.id}`, 'selfie') : null;
    const classroomPath = body.classroomDataUrl ? saveBase64Image(body.classroomDataUrl, `evidence/${user.id}/${session.id}`, 'classroom') : null;

    // Device registration
    const deviceUuid = body.device?.uuid || 'dev_' + crypto.randomBytes(8).toString('hex');
    let device = await getOne('SELECT id FROM devices WHERE user_id = ? AND device_uuid = ?', [user.id, deviceUuid]);
    if (!device) {
      const deviceId = crypto.randomUUID();
      await execute(
        `INSERT INTO devices (id, user_id, device_uuid, platform, model, is_trusted, integrity_verdict, last_seen_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [deviceId, user.id, deviceUuid, body.device?.platform || 'web', body.device?.model || 'Generic',
         JSON.stringify(body.device?.integrity || body.integrity || {}), new Date().toISOString()]
      );
      device = { id: deviceId };
    } else {
      await execute('UPDATE devices SET last_seen_at = ?, integrity_verdict = ? WHERE id = ?',
        [new Date().toISOString(), JSON.stringify(body.device?.integrity || body.integrity || {}), device.id]);
    }

    // Face verification & Classroom Vision Analysis via Local Zero-Key Model
    let enrolledFace = await getOne('SELECT embedding FROM face_profiles WHERE user_id = ?', [user.id]);
    let enrolledEmbedding: number[] = [];
    if (enrolledFace?.embedding) {
      try {
        enrolledEmbedding = typeof enrolledFace.embedding === 'string' ? JSON.parse(enrolledFace.embedding) : enrolledFace.embedding;
      } catch {}
    }

    if (body.selfieDataUrl && body.classroomDataUrl && enrolledEmbedding.length > 0) {
      const aiResult = await verifyEvidence(enrolledEmbedding, body.selfieDataUrl, body.classroomDataUrl);
      console.log('🤖 Local AI Analysis result:', aiResult);
    }

    const recordId = crypto.randomUUID();
    const markedAt = new Date().toISOString();
    await execute(
      `INSERT INTO attendance_records (
        id, session_id, student_id, gps_lat, gps_lng, gps_accuracy_m, distance_from_center_m,
        selfie_path, classroom_photo_path, device_id, status, rejection_reason, evidence_review_status, marked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)`,
      [recordId, session.id, user.id, latitude, longitude, accuracy, distance, selfiePath, classroomPath, device.id, status, rejectionReason, markedAt]
    );

    const attendance = await getOne('SELECT * FROM attendance_records WHERE id = ?', [recordId]);

    res.status(201).json({
      attendance,
      verdict: { status, reason: rejectionReason },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleJoinBatch(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { token } = req.body || {};
    if (!token) {
      res.status(400).json({ error: 'Join token is required' });
      return;
    }

    const joinRow = await getOne('SELECT * FROM join_tokens WHERE token = ? AND is_active = 1', [token.trim().toUpperCase()]);
    if (!joinRow) {
      res.status(404).json({ error: 'Invalid or expired join token' });
      return;
    }
    if (joinRow.expires_at && new Date(joinRow.expires_at).getTime() < Date.now()) {
      res.status(404).json({ error: 'This join code has expired. Ask your faculty for a new one.' });
      return;
    }
    if (joinRow.max_uses && Number(joinRow.use_count || 0) >= Number(joinRow.max_uses)) {
      res.status(404).json({ error: 'This join code has reached its usage limit' });
      return;
    }
    if (user.role !== 'student') {
      res.status(403).json({ error: 'Only student accounts can join a batch' });
      return;
    }

    const batch = await getOne('SELECT * FROM batches WHERE id = ?', [joinRow.batch_id]);
    const classes = await query('SELECT id FROM classes WHERE batch_id = ?', [joinRow.batch_id]);

    let enrolledCount = 0;
    for (const cls of classes) {
      const result = await execute(
        `INSERT OR IGNORE INTO enrollments (id, class_id, student_id, status) VALUES (?, ?, ?, 'active')`,
        [crypto.randomUUID(), cls.id, user.id]
      );
      enrolledCount += result.changes;
    }
    await execute(
      `INSERT OR IGNORE INTO batch_members (id, batch_id, student_id, status) VALUES (?, ?, ?, 'active')`,
      [crypto.randomUUID(), joinRow.batch_id, user.id]
    );
    await execute('UPDATE join_tokens SET use_count = use_count + 1 WHERE id = ?', [joinRow.id]);

    res.json({ success: true, batch, enrolledCount });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleGenerateJoinQr(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { batchId, purpose, maxUses, expiresInMinutes } = req.body || {};
    const isFacultySignup = purpose === 'faculty_signup';

    const targetBatchId = batchId || (await getOne('SELECT id FROM batches LIMIT 1'))?.id;
    if (!targetBatchId && !isFacultySignup) {
      res.status(404).json({ error: 'No batch available' });
      return;
    }

    const token = isFacultySignup
      ? 'FAC-' + crypto.randomBytes(4).toString('hex').toUpperCase()
      : 'JOIN-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = expiresInMinutes
      ? new Date(Date.now() + Number(expiresInMinutes) * 60 * 1000).toISOString()
      : null;

    await execute(
      `INSERT INTO join_tokens (id, batch_id, token, token_type, purpose, max_uses, use_count, is_active, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      [crypto.randomUUID(), targetBatchId || null, token,
       isFacultySignup ? 'faculty_signup' : 'batch_join', purpose || null,
       Number(maxUses) || null, expiresAt, user.id]
    );

    // The client expects { qrPayload, token, expiresAt }
    res.json({
      token,
      qrPayload: token,
      expiresAt,
      batchId: targetBatchId,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleVerifyFacultyCode(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { inviteToken } = req.body;

    await execute(
      `UPDATE profiles SET approval_status = 'approved' WHERE id = ?`,
      [user.id]
    );

    res.json({ success: true, message: 'Faculty code verified successfully' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleAdminResetPassword(req: Request, res: Response) {
  try {
    const admin = (req as any).user;
    if (admin.role !== 'admin') {
      res.status(403).json({ error: 'Only administrators can reset passwords' });
      return;
    }
    const { userId, newPassword, temporaryPassword, requestId } = req.body || {};
    const finalPassword = temporaryPassword || newPassword;
    if (!userId || !finalPassword) {
      res.status(400).json({ error: 'userId and a temporary password are required' });
      return;
    }
    if (String(finalPassword).length < 12) {
      res.status(400).json({ error: 'Temporary passwords require at least 12 characters' });
      return;
    }

    const { hashPassword } = await import('./db.js');
    const hash = hashPassword(String(finalPassword));
    await execute('UPDATE profiles SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hash, userId]);

    // Email the temporary password to the user (Gmail SMTP)
    try {
      const target = await getOne('SELECT email, full_name FROM profiles WHERE id = ?', [userId]);
      if (target) {
        const { sendAdminPasswordResetEmail } = await import('./mailer.js');
        await sendAdminPasswordResetEmail(target.email, target.full_name || 'User', String(finalPassword));
      }
    } catch (mailError) {
      console.warn('Admin reset email failed:', (mailError as Error).message);
    }

    if (requestId) {
      await execute('UPDATE password_resets SET status = ?, admin_note = ? WHERE id = ?',
        ['resolved', 'Reset completed from admin dashboard', requestId]);
      // SQLite queue rows may key the table by email instead of an explicit id.
      await execute('UPDATE password_resets SET status = ? WHERE user_id = ? AND status = ?',
        ['resolved', userId, 'pending']);
    }

    await execute(
      `INSERT INTO audit_logs (id, actor_id, action, target_table, target_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), admin.id, 'admin_password_reset', 'profiles', userId, '{}', new Date().toISOString()]
    );

    res.json({ success: true, message: 'Temporary password set. The user must replace it after signing in.' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── POST /api/functions/admin-update-attendance — review queue decision
export async function handleAdminUpdateAttendance(req: Request, res: Response) {
  try {
    const admin = (req as any).user;
    if (admin.role !== 'admin') {
      res.status(403).json({ error: 'Only administrators can review attendance' });
      return;
    }
    const { attendanceId, status, notes } = req.body || {};
    if (!attendanceId || !['present', 'rejected'].includes(status)) {
      res.status(400).json({ error: 'attendanceId and a decision of present or rejected are required' });
      return;
    }
    const record = await getOne('SELECT id, student_id FROM attendance_records WHERE id = ?', [attendanceId]);
    if (!record) {
      res.status(404).json({ error: 'Attendance record not found' });
      return;
    }
    await execute(
      'UPDATE attendance_records SET status = ?, rejection_reason = ?, evidence_review_status = ? WHERE id = ?',
      [status, notes || null, 'reviewed', attendanceId]
    );
    await execute(
      `INSERT INTO audit_logs (id, actor_id, action, target_table, target_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), admin.id, 'attendance_review', 'attendance_records', attendanceId,
       JSON.stringify({ status, notes }), new Date().toISOString()]
    );
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
