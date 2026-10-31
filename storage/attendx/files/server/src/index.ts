import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import dotenv from 'dotenv';

// Load the repository root .env before any module reads process.env
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
// override: true so a stale empty shell variable can't shadow the real .env value
dotenv.config({ path: path.resolve(here, '../../.env'), override: true });
dotenv.config({ override: true }); // plus any local overrides

import { initDb, getDbKind } from './db.js';
import { handleLogin, handleSignup, authenticate, authenticateOptional } from './auth.js';
import {
  handleStartSession,
  handleIssueQr,
  handleSubmitAttendance,
  handleJoinBatch,
  handleGenerateJoinQr,
  handleAdminResetPassword,
  handleAdminUpdateAttendance,
} from './functions.js';
import { handleQuery, handleInsert, handleUpdate, handleDelete } from './data.js';
import { handleExportJson } from './sync.js';
import { generateAndSendOtp, verifyOtpCode } from './otp.js';
import { handleResetPassword, handleProfilePhoto } from './account.js';
import { handleListPendingFaculty, handleApproveFaculty, handleVerifyFacultyCode } from './faculty.js';
import { handleRaiseQuery, handleListQueries, handleTrackQuery, handleResolveQuery } from './queries.js';
import { handleAppLatest } from './appUpdate.js';
import { handleMassEmail, handleMassEmailRecipients } from './massMail.js';
import { uploadsDirectory } from './runtimePaths.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
let databaseInitialization: ReturnType<typeof initDb> | null = null;

/** Initialise the database once for both long-running and serverless hosts. */
export function ensureDatabase() {
  if (!databaseInitialization) {
    databaseInitialization = initDb().catch((error) => {
      databaseInitialization = null;
      throw error;
    });
  }
  return databaseInitialization;
}

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Info', 'apikey', 'X-Processor-Key', 'Range'],
    exposedHeaders: ['content-range'],
  })
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static uploads serving for photo evidence
const UPLOADS_DIR = uploadsDirectory;
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
app.use('/uploads', express.static(UPLOADS_DIR));

// Health check
app.get(['/health', '/api/health'], (_req, res) => {
  res.json({
    status: 'ok',
    app: 'AttendX Local Offline Server',
    database: getDbKind(),
    timestamp: new Date().toISOString(),
  });
});

// Auth endpoints
app.post(['/api/auth/login', '/auth/v1/token'], handleLogin);
app.post(['/api/auth/signup', '/auth/v1/signup', '/functions/v1/signup'], handleSignup);

// OTP Verification Engine (Gmail SMTP)
app.post(['/api/auth/send-otp', '/functions/v1/send-otp'], async (req, res) => {
  const { email, purpose } = req.body;
  if (!email) {
    res.status(400).json({ error: 'Email address is required' });
    return;
  }
  const result = await generateAndSendOtp(email, purpose || 'login');
  res.status(result.success ? 200 : 500).json(result);
});

app.post(['/api/auth/verify-otp', '/functions/v1/verify-otp'], async (req, res) => {
  const { email, code, purpose } = req.body;
  if (!email || !code) {
    res.status(400).json({ error: 'Email and 6-digit code are required' });
    return;
  }
  const valid = await verifyOtpCode(email, code, purpose || 'login');
  if (valid) {
    res.json({ success: true, message: 'Code verified successfully' });
  } else {
    res.status(400).json({ success: false, error: 'Invalid or expired verification code' });
  }
});

// Functions endpoints (matching both /api/functions/* and Supabase /functions/v1/*)
app.post(['/api/functions/start-session', '/functions/v1/start-session'], authenticate, handleStartSession);
app.post(['/api/functions/issue-qr', '/functions/v1/issue-qr'], authenticate, handleIssueQr);
app.post(['/api/functions/submit-attendance', '/functions/v1/submit-attendance'], authenticate, handleSubmitAttendance);
app.post(['/api/functions/join-batch', '/functions/v1/join-batch'], authenticate, handleJoinBatch);
app.post(['/api/functions/generate-join-qr', '/functions/v1/generate-join-qr'], authenticate, handleGenerateJoinQr);
app.post(['/api/functions/verify-faculty-code', '/functions/v1/verify-faculty-code'], authenticate, handleVerifyFacultyCode);
app.post(['/api/functions/admin-reset-password', '/functions/v1/admin-reset-password'], authenticate, handleAdminResetPassword);
app.post(['/api/functions/admin-update-attendance', '/functions/v1/admin-update-attendance'], authenticate, handleAdminUpdateAttendance);

// Faculty approval & verification lifecycle
app.get('/api/faculty/pending', authenticate, handleListPendingFaculty);

// Admin user directory (People page + Mail Center recipient picker)
import { handleDirectory } from './directory.js';
app.get('/api/admin/directory', authenticate, handleDirectory);
app.post('/api/faculty/approve', authenticate, handleApproveFaculty);

// Attendance query / complaint system with tracking numbers
app.post('/api/queries', authenticate, handleRaiseQuery);
app.get('/api/queries', authenticate, handleListQueries);
app.get('/api/queries/track/:trackingId', handleTrackQuery); // public status lookup
app.patch('/api/queries/:id', authenticate, handleResolveQuery);

// OTP password reset completion & profile face capture
app.post('/api/auth/reset-password', handleResetPassword);
app.post('/api/profile/photo', authenticate, handleProfilePhoto);

// App update metadata (Android APK from GitHub Releases)
app.get('/api/app/latest', handleAppLatest);

// Admin mass-mail notices
app.get('/api/admin/mass-email/recipients', authenticate, handleMassEmailRecipients);
app.post('/api/admin/mass-email', authenticate, handleMassEmail);

// Mail Center — every institutional mail event with tracking
import { handleNoticeCatalog, handleRaiseNotice, handleListNotices, handleResolveNotice } from './notices.js';
app.get('/api/notices/catalog', authenticate, handleNoticeCatalog);
app.post('/api/notices', authenticate, handleRaiseNotice);
app.get('/api/notices', authenticate, handleListNotices);
app.patch('/api/notices/:id', authenticate, handleResolveNotice);

// Admin account activation / deactivation with automatic mail
import { handleSetUserStatus } from './userStatus.js';
app.patch('/api/admin/users/:id/status', authenticate, handleSetUserStatus);

// PostgREST generic data endpoints (matching both /api/data/:table and Supabase /rest/v1/:table)
// GET is accessible with optional auth (demo/offline mode needs unauthenticated reads)
app.get(['/api/data/:table', '/rest/v1/:table'], authenticateOptional, handleQuery);
// Write operations require authentication
app.post(['/api/data/:table', '/rest/v1/:table'], authenticate, handleInsert);
app.patch(['/api/data/:table', '/rest/v1/:table'], authenticate, handleUpdate);
app.delete(['/api/data/:table', '/rest/v1/:table'], authenticate, handleDelete);

// Change own password
app.post(['/api/functions/change-own-password', '/functions/v1/change-own-password'], authenticate, async (req, res) => {
  try {
    const user = (req as any).user;
    const { password, currentPassword } = req.body || {};
    if (!password || password.length < 12) {
      res.status(400).json({ error: 'Password must be at least 12 characters' });
      return;
    }
    const db = await import('./db.js');
    // When not forced by an admin/OTP reset, verify the current password first
    if (!user.must_change_password && currentPassword) {
      const fresh = await db.getOne('SELECT password_hash FROM profiles WHERE id = ?', [user.id]);
      if (fresh?.password_hash && !db.verifyPassword(currentPassword, fresh.password_hash)) {
        res.status(400).json({ error: 'Current password is incorrect' });
        return;
      }
    }
    const hash = db.hashPassword(password);
    await db.execute('UPDATE profiles SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hash, user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// System settings upsert (admin). Allows creating new keys from the UI.
app.put('/api/settings', authenticate, async (req, res) => {
  try {
    const user = (req as any).user;
    if (user.role !== 'admin') {
      res.status(403).json({ error: 'Only administrators can change system settings' });
      return;
    }
    const { settings } = req.body || {};
    if (!Array.isArray(settings)) {
      res.status(400).json({ error: 'settings array is required' });
      return;
    }
    const { execute, getOne, isMongoActive, getMongoDb } = await import('./db.js');
    for (const item of settings) {
      const { key, value, description } = item || {};
      if (!key) continue;
      const existing = await getOne('SELECT key FROM system_settings WHERE key = ?', [key]);
      if (existing) {
        await execute('UPDATE system_settings SET value = ?, description = COALESCE(?, description), updated_at = ? WHERE key = ?',
          [String(value), description || null, new Date().toISOString(), key]);
      } else {
        await execute('INSERT INTO system_settings (key, value, description, updated_at) VALUES (?, ?, ?, ?)',
          [key, String(value), description || null, new Date().toISOString()]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Data export (JSON dump)
app.get('/api/sync/export-json', handleExportJson);

async function start() {
  await ensureDatabase();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`🚀 AttendX Local Server running on: http://localhost:${PORT}`);
    console.log(`📡 Network access on your LAN: http://<YOUR-IP>:${PORT}`);
    console.log(`💾 Database Engine: ${getDbKind().toUpperCase()}`);
    console.log(`📸 Evidence Uploads: ${UPLOADS_DIR}`);
    console.log(`======================================================\n`);
  });
}

export default app;

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  start().catch((err) => {
    console.error('Fatal server startup error:', err);
    process.exit(1);
  });
}
