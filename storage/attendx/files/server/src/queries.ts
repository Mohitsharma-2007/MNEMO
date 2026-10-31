import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { query, getOne, execute, getMongoDb, isMongoActive } from './db.js';
import { sendQueryRaisedEmail, sendQueryResolvedEmail, notifyAdminOfQuery } from './mailer.js';

// ── Mongo helper: uniform access to the attendance_queries collection ──
function queriesCol() {
  if (!isMongoActive()) return null;
  return getMongoDb()!.collection('attendance_queries');
}

function mapDoc(doc: any) {
  const { _id, ...rest } = doc;
  const item: any = { ...rest };
  if (!item.id && _id) item.id = String(_id);
  return item;
}

export function generateTrackingId(): string {
  // Format: ATX-Q-XXXXXX (6 base36 chars) — collision-safe via random + retry
  const rand = () => crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  return `ATX-Q-${rand()}`;
}

// ── POST /api/queries — student raises an attendance query ────────────
export async function handleRaiseQuery(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { classId, sessionId, type, message, classLabel } = req.body || {};

    if (!message || !String(message).trim()) {
      res.status(400).json({ error: 'Please describe the issue' });
      return;
    }
    const allowedTypes = ['not_marked', 'wrong_status', 'location_issue', 'other'];
    const queryType = allowedTypes.includes(type) ? type : 'other';

    let resolvedClassName = typeof classLabel === 'string' ? classLabel : '';
    if (classId) {
      const cls = await getOne('SELECT name, code FROM classes WHERE id = ?', [String(classId)]);
      if (cls) resolvedClassName = `${cls.name} (${cls.code})`;
    }

    const now = new Date().toISOString();
    const trackingId = generateTrackingId();
    const record = {
      id: crypto.randomUUID(),
      tracking_id: trackingId,
      student_id: user.id,
      student_name: user.full_name || '',
      student_email: user.email || '',
      student_identifier: user.identifier || '',
      class_id: classId || null,
      class_label: resolvedClassName || null,
      session_id: sessionId || null,
      type: queryType,
      message: String(message).trim().slice(0, 2000),
      status: 'open',
      admin_note: '',
      email_sent: false,
      created_at: now,
      updated_at: now,
      resolved_at: null,
    };

    if (queriesCol()) {
      await queriesCol()!.insertOne({ ...record });
    } else {
      await execute(
        `CREATE TABLE IF NOT EXISTS attendance_queries (
          id TEXT PRIMARY KEY,
          tracking_id TEXT UNIQUE NOT NULL,
          student_id TEXT,
          student_name TEXT,
          student_email TEXT,
          student_identifier TEXT,
          class_id TEXT,
          class_label TEXT,
          session_id TEXT,
          type TEXT,
          message TEXT,
          status TEXT DEFAULT 'open',
          admin_note TEXT,
          email_sent INTEGER DEFAULT 0,
          created_at TEXT,
          updated_at TEXT,
          resolved_at TEXT
        )`,
      );
      await execute(
        `INSERT INTO attendance_queries (id, tracking_id, student_id, student_name, student_email, student_identifier,
          class_id, class_label, session_id, type, message, status, admin_note, email_sent, created_at, updated_at, resolved_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [record.id, record.tracking_id, record.student_id, record.student_name, record.student_email, record.student_identifier,
         record.class_id, record.class_label, record.session_id, record.type, record.message, record.status,
         record.admin_note, record.email_sent ? 1 : 0, record.created_at, record.updated_at, record.resolved_at]
      );
    }

    // Email the student their tracking number
    const delivered = await sendQueryRaisedEmail(
      record.student_email,
      record.student_name || 'Student',
      trackingId,
      resolvedClassName,
      queryType,
      record.message,
    );
    // Notify the administration inbox
    await notifyAdminOfQuery(record.student_name, record.student_email, trackingId, resolvedClassName, record.message);

    if (queriesCol()) {
      await queriesCol()!.updateOne({ id: record.id }, { $set: { email_sent: delivered } });
    } else {
      await execute('UPDATE attendance_queries SET email_sent = ? WHERE id = ?', [delivered ? 1 : 0, record.id]);
    }

    res.status(201).json({
      success: true,
      trackingId,
      emailSent: delivered,
      query: { ...record, email_sent: delivered },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── GET /api/queries — list queries (role-aware) ──────────────────────
export async function handleListQueries(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { status, trackingId } = req.query;

    if (isMongoActive() && queriesCol()) {
      const filter: Record<string, any> = {};
      if (user.role !== 'admin') filter.student_id = user.id;
      if (status) filter.status = String(status);
      if (trackingId) filter.tracking_id = String(trackingId).toUpperCase();
      const docs = await queriesCol()!.find(filter).sort({ created_at: -1 }).limit(200).toArray();
      res.json(docs.map(mapDoc));
      return;
    }

    const where: string[] = [];
    const params: any[] = [];
    if (user.role !== 'admin') {
      where.push('student_id = ?');
      params.push(user.id);
    }
    if (status) {
      where.push('status = ?');
      params.push(String(status));
    }
    if (trackingId) {
      where.push('tracking_id = ?');
      params.push(String(trackingId).toUpperCase());
    }
    const sql = `SELECT * FROM attendance_queries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 200`;
    const rows = await query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── GET /api/queries/track/:trackingId — public tracking by number ────
export async function handleTrackQuery(req: Request, res: Response) {
  try {
    const trackingId = String(req.params.trackingId || '').trim().toUpperCase();
    if (!trackingId) {
      res.status(400).json({ error: 'Tracking ID is required' });
      return;
    }
    if (queriesCol()) {
      const doc = await queriesCol()!.findOne({ tracking_id: trackingId });
      if (!doc) {
        res.status(404).json({ error: 'No query found for this request number' });
        return;
      }
      const item = mapDoc(doc);
      res.json({
        tracking_id: item.tracking_id,
        status: item.status,
        type: item.type,
        class_label: item.class_label,
        message: item.message,
        admin_note: item.admin_note,
        created_at: item.created_at,
        updated_at: item.updated_at,
        resolved_at: item.resolved_at,
      });
      return;
    }
    const row = await getOne('SELECT * FROM attendance_queries WHERE tracking_id = ?', [trackingId]);
    if (!row) {
      res.status(404).json({ error: 'No query found for this request number' });
      return;
    }
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── PATCH /api/queries/:id — admin resolves / rejects a query ─────────
export async function handleResolveQuery(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    if (user.role !== 'admin') {
      res.status(403).json({ error: 'Only administrators can resolve queries' });
      return;
    }
    const { id } = req.params;
    const { status, adminNote } = req.body || {};
    const allowed = ['resolved', 'rejected', 'open', 'in_review'];
    const nextStatus = allowed.includes(status) ? status : 'resolved';

    let existing: any = null;
    if (queriesCol()) {
      existing = await queriesCol()!.findOne({ id });
    } else {
      existing = await getOne('SELECT * FROM attendance_queries WHERE id = ?', [id]);
    }
    if (!existing) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }

    const now = new Date().toISOString();
    const resolvedAt = nextStatus === 'resolved' || nextStatus === 'rejected' ? now : null;
    if (queriesCol()) {
      await queriesCol()!.updateOne(
        { id },
        { $set: { status: nextStatus, admin_note: adminNote || existing.admin_note || '', updated_at: now, resolved_at: resolvedAt } }
      );
    } else {
      await execute(
        'UPDATE attendance_queries SET status = ?, admin_note = ?, updated_at = ?, resolved_at = ? WHERE id = ?',
        [nextStatus, adminNote || existing.admin_note || '', now, resolvedAt, id]
      );
    }

    // Email the student the outcome, referencing their request number
    if (existing.student_email && nextStatus !== 'open') {
      await sendQueryResolvedEmail(
        existing.student_email,
        existing.student_name || 'Student',
        existing.tracking_id,
        nextStatus,
        adminNote || '',
      );
    }

    res.json({ success: true, status: nextStatus, trackingId: existing.tracking_id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
