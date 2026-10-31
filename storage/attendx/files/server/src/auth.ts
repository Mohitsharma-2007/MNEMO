import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query, getOne, execute, hashPassword, verifyPassword } from './db.js';
import { extractFaceEmbedding } from './localAi.js';
import { uploadsDirectory } from './runtimePaths.js';

const UPLOADS_DIR = uploadsDirectory;
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// In-memory token store for active sessions — a fast path only. Sessions are
// also persisted to the database so tokens survive process restarts and
// serverless cold starts (Vercel functions start fresh on every invocation).
const activeSessions = new Map<string, { userId: string; role: string; email: string; expiresAt: number }>();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function generateToken(user: { id: string; role: string; email: string }): Promise<string> {
  const token = 'atx_' + crypto.randomBytes(32).toString('hex');
  const info = {
    userId: user.id,
    role: user.role,
    email: user.email,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  activeSessions.set(token, info);
  try {
    await execute(
      'INSERT INTO sessions (token, user_id, role, email, expires_at) VALUES (?, ?, ?, ?, ?)',
      [token, info.userId, info.role, info.email, info.expiresAt],
    );
  } catch (err) {
    console.warn('Could not persist session token:', (err as Error).message);
  }
  return token;
}

/**
 * Resolve a session token from the in-memory cache first, then the database
 * (so tokens issued before a restart still authenticate). Expired rows are
 * dropped lazily.
 */
async function lookupSession(token: string): Promise<{ userId: string; role: string; email: string; expiresAt: number } | null> {
  const cached = activeSessions.get(token);
  if (cached) return cached.expiresAt > Date.now() ? cached : null;
  try {
    const row = await getOne<any>('SELECT * FROM sessions WHERE token = ?', [token]);
    if (!row) return null;
    const expiresAt = Number(row.expires_at);
    if (!expiresAt || expiresAt < Date.now()) {
      await execute('DELETE FROM sessions WHERE token = ?', [token]);
      return null;
    }
    const info = { userId: row.user_id, role: row.role, email: row.email, expiresAt };
    activeSessions.set(token, info);
    return info;
  } catch {
    return null;
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const session = await lookupSession(token);
  if (!session) {
    res.status(401).json({ error: 'Invalid or expired session token' });
    return;
  }

  const user = await getOne('SELECT * FROM profiles WHERE id = ? AND is_active = 1', [session.userId]);
  if (!user) {
    res.status(401).json({ error: 'User not found or inactive' });
    return;
  }

  (req as any).user = user;
  next();
}

/**
 * Attaches req.user when a valid session token is present, but never rejects
 * the request. Used on read-only endpoints that can personalize results when
 * credentials are supplied (e.g. per-student summary views).
 */
export async function authenticateOptional(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const session = await lookupSession(token);
    if (session) {
      const user = await getOne('SELECT * FROM profiles WHERE id = ? AND is_active = 1', [session.userId]);
      if (user) (req as any).user = user;
    }
  }
  next();
}

/**
 * Save base64 image data URL to disk
 */
export function saveBase64Image(dataUrl: string, subfolder: string, prefix: string): string {
  const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!match) return '';

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const targetDir = path.join(UPLOADS_DIR, subfolder);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const filename = `${prefix}-${crypto.randomUUID()}.${ext}`;
  const filepath = path.join(targetDir, filename);
  fs.writeFileSync(filepath, buffer);
  return `/uploads/${subfolder}/${filename}`;
}

export async function handleLogin(req: Request, res: Response) {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password required' });
    return;
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const user = await getOne('SELECT * FROM profiles WHERE lower(email) = lower(?)', [cleanEmail]);
  if (!user) {
    res.status(400).json({ error: 'Invalid login credentials' });
    return;
  }

  if (!user.is_active) {
    res.status(403).json({ error: 'This account has been deactivated.' });
    return;
  }

  const passwordValid = user.password_hash ? verifyPassword(password, user.password_hash) : false;
  if (!passwordValid) {
    res.status(400).json({ error: 'Invalid login credentials' });
    return;
  }

  const token = await generateToken(user);
  res.json({
    access_token: token,
    token_type: 'bearer',
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      user_metadata: {
        full_name: user.full_name,
        role: user.role,
      },
    },
    profile: user,
  });
}

export async function handleSignup(req: Request, res: Response) {
  try {
    // Accept both legacy field names and the live client payload.
    const b = req.body || {};
    const fullName = b.fullName || b.full_name;
    const email = b.email;
    const password = b.password;
    const role = b.role === 'faculty' ? 'faculty' : 'student';
    const identifier = b.identifier;
    const department = b.department;
    const inviteToken = b.inviteToken || b.invite_token;
    const identityImage = b.identityImage || (b.identityPhotoDataUrl ? { dataUrl: b.identityPhotoDataUrl } : null);
    const idCardFront = b.idCardFront || (b.idCardFrontDataUrl ? { dataUrl: b.idCardFrontDataUrl } : null);
    const idCardBack = b.idCardBack || (b.idCardBackDataUrl ? { dataUrl: b.idCardBackDataUrl } : null);

    if (!email || !password || !fullName || !role) {
      res.status(400).json({ error: 'Full name, email, password, and role are required' });
      return;
    }
    if (String(password).length < 12) {
      res.status(400).json({ error: 'Password must be at least 12 characters' });
      return;
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const existing = await getOne('SELECT id FROM profiles WHERE lower(email) = lower(?)', [cleanEmail]);
    if (existing) {
      res.status(409).json({ error: 'A user with this email already exists' });
      return;
    }

    const userId = crypto.randomUUID();
    const passwordHash = hashPassword(password);
    
    // Save photos to disk
    let identityPath = '';
    let frontPath = '';
    let backPath = '';

    if (identityImage?.dataUrl) {
      identityPath = saveBase64Image(identityImage.dataUrl, `profiles/${userId}`, 'selfie');
    }
    if (idCardFront?.dataUrl) {
      frontPath = saveBase64Image(idCardFront.dataUrl, `profiles/${userId}`, 'id-front');
    }
    if (idCardBack?.dataUrl) {
      backPath = saveBase64Image(idCardBack.dataUrl, `profiles/${userId}`, 'id-back');
    }

    const initialApproval = role === 'student' ? 'approved' : 'pending';

    await execute(
      `INSERT INTO profiles (id, email, full_name, role, identifier, department, approval_status, is_active, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, cleanEmail, fullName, role, identifier || null, department || null, initialApproval, 1, passwordHash]
    );

    // If student identity photo provided, generate and save face embedding locally
    if (identityImage?.dataUrl) {
      try {
        const faceResult = await extractFaceEmbedding(identityImage.dataUrl);
        const faceProfileId = crypto.randomUUID();
        await execute(
          `INSERT INTO face_profiles (id, user_id, model, model_version, embedding, quality_score, source_photo_path)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [faceProfileId, userId, faceResult.model, faceResult.model_version, JSON.stringify(faceResult.embedding), faceResult.quality_score, identityPath]
        );
      } catch (faceError) {
        console.warn('Face embedding extraction failed, continuing without face verification:', (faceError as Error).message);
        // Continue signup without face embedding if local AI fails
      }
    }

    // Process invite token / batch joining if provided
    if (inviteToken && role === 'student') {
      const tokenRow = await getOne('SELECT * FROM join_tokens WHERE token = ? AND is_active = 1', [inviteToken]);
      if (tokenRow) {
        const classes = await query('SELECT id FROM classes WHERE batch_id = ?', [tokenRow.batch_id]);
        for (const cls of classes) {
          await execute(
            `INSERT OR IGNORE INTO enrollments (id, class_id, student_id, status) VALUES (?, ?, ?, ?)`,
            [crypto.randomUUID(), cls.id, userId, 'active']
          );
        }
      }
    }

    // New-user onboarding welcome mail (Gmail SMTP)
    try {
      const { sendOnboardingEmail } = await import('./mailer.js');
      await sendOnboardingEmail(cleanEmail, fullName, role);
    } catch (mailError) {
      console.warn('Onboarding email failed:', (mailError as Error).message);
    }

    res.status(201).json({
      success: true,
      message: role === 'faculty' ? 'Faculty registration submitted for administrator approval' : 'Account created successfully',
      userId,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
