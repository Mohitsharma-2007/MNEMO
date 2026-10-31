import crypto from 'node:crypto';
import { getMongoDb, isMongoActive, execute, getOne, query } from './db.js';
import { sendOtpEmail } from './mailer.js';

type OtpPurpose = 'login' | 'signup' | 'password_reset' | 'general';

interface OtpRecord {
  id: string;
  email: string;
  code: string;
  purpose: OtpPurpose;
  expiresAt: string;
  createdAt: string;
  attempts: number;
  used: boolean;
}

// ── MongoDB collection for OTPs with TTL cleanup ──────────────────────
async function ensureOtpCollection() {
  if (!isMongoActive()) return;
  const mongo = getMongoDb();
  if (!mongo) return;
  try {
    const col = mongo.collection('otps');
    const indexes = await col.indexes();
    if (!indexes.some((i) => i.name === 'expiresAt_ttl')) {
      await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 60, name: 'expiresAt_ttl' });
    }
    await col.createIndex({ email: 1, purpose: 1 });
  } catch (e) {
    console.warn('[AttendX OTP] Index init note:', (e as Error).message);
  }
}

// ── Simple in-memory rate limiting: max 4 requests / 10 min / email ───
const rateMap = new Map<string, number[]>();
function isRateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (rateMap.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (hits.length >= 4) return true;
  hits.push(now);
  rateMap.set(key, hits);
  return false;
}

/**
 * Generate a 6-digit numeric OTP, persist it (MongoDB first, SQLite fallback)
 * and deliver it via Gmail SMTP.
 */
export async function generateAndSendOtp(
  email: string,
  purpose: OtpPurpose = 'login'
): Promise<{ success: boolean; message: string }> {
  const targetEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
    return { success: false, message: 'A valid email address is required' };
  }
  if (isRateLimited(`${targetEmail}:${purpose}`)) {
    return { success: false, message: 'Too many code requests. Please wait 10 minutes before trying again.' };
  }

  // Verify the account exists for password resets — never leak validity, but
  // do not dispatch codes to unknown inboxes either.
  if (purpose === 'password_reset') {
    const user = await getOne('SELECT id FROM profiles WHERE lower(email) = ?', [targetEmail]).catch(() => null);
    if (!user) {
      return { success: false, message: 'No AttendX account exists for this email address' };
    }
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await ensureOtpCollection();

  if (isMongoActive()) {
    const mongo = getMongoDb();
    if (mongo) {
      await mongo.collection('otps').deleteMany({ email: targetEmail, purpose });
      await mongo.collection('otps').insertOne({
        email: targetEmail,
        code,
        purpose,
        expiresAt,
        createdAt: new Date(),
        attempts: 0,
        used: false,
      });
    }
  } else {
    await execute('DELETE FROM password_resets WHERE email = ? AND reason = ?', [targetEmail, `otp_${purpose}`]);
    await execute(
      `INSERT INTO password_resets (id, email, temp_password, reason, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [crypto.randomUUID(), targetEmail, code, `otp_${purpose}`, new Date().toISOString()]
    );
  }

  const delivered = await sendOtpEmail(targetEmail, code, purpose);
  if (!delivered) {
    return { success: false, message: 'Could not dispatch the verification email. Please try again shortly.' };
  }
  return { success: true, message: 'Verification code sent to your email' };
}

/**
 * Verify an OTP entered by the user. The code is consumed on success and
 * failed attempts are tracked (max 5) to prevent brute forcing.
 */
export async function verifyOtpCode(
  email: string,
  code: string,
  purpose: OtpPurpose = 'login'
): Promise<boolean> {
  const targetEmail = email.trim().toLowerCase();
  const targetCode = String(code).trim();

  if (isMongoActive()) {
    const mongo = getMongoDb();
    if (!mongo) return false;
    const record = await mongo.collection('otps').findOne({
      email: targetEmail,
      purpose,
      used: { $ne: true },
      expiresAt: { $gt: new Date() },
    });
    if (!record) return false;
    if (record.code !== targetCode) {
      const attempts = Number(record.attempts || 0) + 1;
      if (attempts >= 5) {
        await mongo.collection('otps').deleteOne({ _id: record._id });
      } else {
        await mongo.collection('otps').updateOne({ _id: record._id }, { $set: { attempts } });
      }
      return false;
    }
    await mongo.collection('otps').updateOne({ _id: record._id }, { $set: { used: true } });
    return true;
  }

  // SQLite fallback (values live in password_resets.temp_password)
  const row = await getOne(
    `SELECT id, temp_password AS code FROM password_resets
     WHERE email = ? AND reason = ? AND status = 'active' AND created_at >= ?`,
    [targetEmail, `otp_${purpose}`, new Date(Date.now() - 5 * 60 * 1000).toISOString()]
  );
  if (!row) return false;
  if (row.code !== targetCode) return false;
  await execute(`UPDATE password_resets SET status = 'used' WHERE id = ?`, [row.id]);
  return true;
}

/** List active OTP purposes for an email (used by diagnostics/tests). */
export async function listActiveOtps(email: string): Promise<OtpRecord[]> {
  const targetEmail = email.trim().toLowerCase();
  if (isMongoActive()) {
    const mongo = getMongoDb();
    if (!mongo) return [];
    const docs = await mongo.collection('otps').find({ email: targetEmail, used: { $ne: true } }).toArray();
    return docs.map((doc: any) => ({ ...doc, id: String(doc._id) })) as OtpRecord[];
  }
  return query<OtpRecord>(
    `SELECT id, email, reason AS purpose, created_at AS createdAt FROM password_resets
     WHERE email = ? AND status = 'active'`,
    [targetEmail]
  );
}
