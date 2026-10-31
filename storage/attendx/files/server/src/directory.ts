import type { Request, Response } from 'express';
import { query, isMongoActive, getMongoDb } from './db.js';

/**
 * GET /api/admin/directory
 * Admin-only user directory with academic context: email, enrollment number,
 * department, role, classes, batches and academic year. Powers the People page
 * and the Mail Center recipient picker (filter by department, batch, year,
 * enrollment number, or free text).
 *
 * Query params (all optional): role, department, batchId, year, q
 */

type Row = Record<string, any>;

function unique(values: (string | undefined | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v && String(v).trim())))] as string[];
}

export async function handleDirectory(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    if (user?.role !== 'admin') {
      res.status(403).json({ error: 'Only administrators can access the user directory' });
      return;
    }

    let profiles: Row[] = [];
    let classes: Row[] = [];
    let batches: Row[] = [];
    let enrollments: Row[] = [];
    let memberships: Row[] = [];

    if (isMongoActive() && getMongoDb()) {
      const db = getMongoDb()!;
      [profiles, classes, batches, enrollments, memberships] = await Promise.all([
        db.collection('profiles').find({}, { projection: { password_hash: 0 } }).limit(5000).toArray(),
        db.collection('classes').find({}).limit(2000).toArray(),
        db.collection('batches').find({}).limit(1000).toArray(),
        db.collection('enrollments').find({}).limit(20000).toArray(),
        db.collection('batch_members').find({}).limit(20000).toArray(),
      ]);
    } else {
      [profiles, classes, batches, enrollments, memberships] = await Promise.all([
        query('SELECT id, full_name, email, identifier, department, role, is_active, approval_status FROM profiles LIMIT 5000'),
        query('SELECT id, name, code, batch_id, department FROM classes LIMIT 2000'),
        query('SELECT id, name, code, department, academic_year, start_year, end_year FROM batches LIMIT 1000'),
        query('SELECT class_id, student_id FROM enrollments LIMIT 20000'),
        query('SELECT batch_id, student_id FROM batch_members LIMIT 20000'),
      ]);
    }

    const classById = new Map<string, Row>();
    for (const c of classes) classById.set(String(c.id), c);
    const batchById = new Map<string, Row>();
    for (const b of batches) batchById.set(String(b.id), b);

    const classIdsByStudent = new Map<string, string[]>();
    for (const e of enrollments) {
      if (!e?.student_id || !e?.class_id) continue;
      const list = classIdsByStudent.get(String(e.student_id)) ?? [];
      list.push(String(e.class_id));
      classIdsByStudent.set(String(e.student_id), list);
    }
    const batchIdsByStudent = new Map<string, string[]>();
    for (const m of memberships) {
      if (!m?.student_id || !m?.batch_id) continue;
      const list = batchIdsByStudent.get(String(m.student_id)) ?? [];
      list.push(String(m.batch_id));
      batchIdsByStudent.set(String(m.student_id), list);
    }

    const directory: Row[] = profiles.map((p) => {
      const classNames = unique((classIdsByStudent.get(String(p.id)) ?? []).map((cid) => {
        const c = classById.get(cid);
        return c ? `${c.name} (${c.code})` : undefined;
      }));
      const userBatches = unique(batchIdsByStudent.get(String(p.id)) ?? []).map((bid) => batchById.get(bid)).filter(Boolean) as Row[];
      const department = unique([p.department, ...userBatches.map((b) => b.department), ...classNames.length ? [] : []]).filter(Boolean)[0] || p.department || '';
      const years = unique(userBatches.map((b) => String(b.academic_year || b.start_year || '')).filter(Boolean));
      return {
        id: String(p.id),
        full_name: p.full_name || '',
        email: p.email || '',
        identifier: p.identifier || '',
        department: department || '',
        role: p.role || 'student',
        is_active: Boolean(p.is_active),
        approval_status: p.approval_status || null,
        classes: classNames,
        batches: userBatches.map((b) => ({ id: String(b.id), name: b.name, code: b.code })),
        batches_label: userBatches.map((b) => b.name || b.code).join(', '),
        year: years.join(', '),
      };
    });

    // Optional server-side filters
    const { role, department, batchId, year, q } = req.query as Record<string, string>;
    let result = directory;
    if (role) result = result.filter((r) => r.role === role);
    if (department) result = result.filter((r) => (r.department || '').toLowerCase().includes(String(department).toLowerCase()));
    if (batchId) result = result.filter((r) => r.batches.some((b) => b.id === String(batchId)));
    if (year) result = result.filter((r) => (r.year || '').toLowerCase().includes(String(year).toLowerCase()));
    if (q) {
      const needle = String(q).toLowerCase();
      result = result.filter((r) =>
        `${r.full_name} ${r.email} ${r.identifier} ${r.batches_label}`.toLowerCase().includes(needle),
      );
    }

    res.json({ count: result.length, users: result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
