import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { query, execute, getOne, getMongoDb, isMongoActive } from './db.js';

const ALLOWED_TABLES = new Set([
  'profiles',
  'batches',
  'classes',
  'class_schedules',
  'enrollments',
  'batch_members',
  'batch_faculty',
  'attendance_sessions',
  'qr_tokens',
  'devices',
  'attendance_records',
  'join_tokens',
  'password_resets',
  'face_profiles',
  'audit_logs',
  'system_settings',
  'attendance_queries',
  'admin_password_reset_queue', // virtual: password_resets joined with profiles
  'student_attendance_summary', // virtual: per-class percentages for a student
  'faculty_assignments', // virtual: batch_faculty joined with batches
]);

type Row = Record<string, any>;

function parseFilterValue(valStr: string): { op: string; value: any } {
  if (valStr.startsWith('eq.')) return { op: 'eq', value: valStr.slice(3) };
  if (valStr.startsWith('neq.')) return { op: 'neq', value: valStr.slice(4) };
  if (valStr.startsWith('gt.')) return { op: 'gt', value: valStr.slice(3) };
  if (valStr.startsWith('gte.')) return { op: 'gte', value: valStr.slice(4) };
  if (valStr.startsWith('lt.')) return { op: 'lt', value: valStr.slice(3) };
  if (valStr.startsWith('lte.')) return { op: 'lte', value: valStr.slice(4) };
  return { op: 'eq', value: valStr };
}

function splitOrderBy(order: string): { col: string; dir: string } {
  const parts = String(order).split('.');
  return { col: parts[0], dir: (parts[1] || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC' };
}

const OP_SQL: Record<string, string> = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const OP_MONGO: Record<string, string> = { neq: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' };

/** Coerce literal booleans so both MongoDB and SQLite match stored values. */
function coerceValue(value: any): any {
  if (value === 'true') return { sql: 1, mongo: { $in: [true, 1] } };
  if (value === 'false') return { sql: 0, mongo: { $in: [false, 0] } };
  return { sql: value, mongo: value };
}

// ── Virtual views ─────────────────────────────────────────────────────

async function passwordResetQueue(): Promise<Row[]> {
  if (isMongoActive()) {
    const mongo = getMongoDb()!;
    const resets = await mongo.collection('password_resets').find({ status: 'pending' }).sort({ created_at: -1 }).toArray();
    const profileIds = resets.map((r: any) => r.user_id).filter(Boolean);
    const profiles = profileIds.length
      ? await mongo.collection('profiles').find({ id: { $in: profileIds } }).toArray()
      : [];
    const byId = new Map(profiles.map((p: any) => [p.id, p]));
    return resets.map((r: any) => {
      const { _id, ...item } = r;
      const profile: any = byId.get(item.user_id);
      return {
        ...item,
        id: item.id || String(_id),
        full_name: profile?.full_name || item.email,
        identifier: profile?.identifier || '—',
        requested_at: item.created_at,
      };
    });
  }
  return query(
    `SELECT password_resets.*, profiles.full_name, profiles.identifier,
            password_resets.created_at AS requested_at
     FROM password_resets LEFT JOIN profiles ON profiles.id = password_resets.user_id
     WHERE password_resets.status = 'pending'
     ORDER BY password_resets.created_at DESC`
  );
}

async function studentAttendanceSummary(studentId: string): Promise<Row[]> {
  if (!studentId) return [];
  if (isMongoActive()) {
    const mongo = getMongoDb()!;
    const records = await mongo.collection('attendance_records')
      .find({ student_id: studentId, status: { $in: ['present', 'flagged', 'rejected'] } })
      .toArray();
    const sessionIds = [...new Set(records.map((r: any) => r.session_id).filter(Boolean))];
    const sessions = sessionIds.length
      ? await mongo.collection('attendance_sessions').find({ id: { $in: sessionIds } }).toArray()
      : [];
    const classIds = [...new Set(sessions.map((s: any) => s.class_id).filter(Boolean))];
    const classes = classIds.length
      ? await mongo.collection('classes').find({ id: { $in: classIds } }).toArray()
      : [];
    const sessionById = new Map(sessions.map((s: any) => [s.id, s]));
    const classById = new Map(classes.map((c: any) => [c.id, c]));
    const totals = new Map<string, { present: number; completed: number }>();
    for (const record of records) {
      const session: any = sessionById.get(record.session_id);
      if (!session) continue;
      const entry = totals.get(session.class_id) || { present: 0, completed: 0 };
      entry.completed += 1;
      if (record.status === 'present') entry.present += 1;
      totals.set(session.class_id, entry);
    }
    return [...totals.entries()].map(([classId, t]) => {
      const cls: any = classById.get(classId) || {};
      return {
        class_id: classId,
        class_code: cls.code || '',
        class_name: cls.name || '',
        completed_sessions: t.completed,
        sessions_present: t.present,
        attendance_percentage: t.completed ? (t.present / t.completed) * 100 : 0,
      };
    });
  }
  return query(
    `SELECT c.id AS class_id, c.code AS class_code, c.name AS class_name,
            COUNT(r.id) AS completed_sessions,
            SUM(CASE WHEN r.status = 'present' THEN 1 ELSE 0 END) AS sessions_present,
            CASE WHEN COUNT(r.id) = 0 THEN 0
                 ELSE SUM(CASE WHEN r.status = 'present' THEN 1 ELSE 0 END) * 100.0 / COUNT(r.id)
            END AS attendance_percentage
     FROM attendance_records r
     JOIN attendance_sessions s ON s.id = r.session_id
     JOIN classes c ON c.id = s.class_id
     WHERE r.student_id = ? AND r.status IN ('present','flagged','rejected')
     GROUP BY c.id, c.code, c.name`,
    [studentId]
  );
}

async function facultyAssignments(facultyId: string): Promise<Row[]> {
  if (isMongoActive()) {
    const mongo = getMongoDb()!;
    const links = await mongo.collection('batch_faculty').find({ faculty_id: facultyId }).toArray();
    const batchIds = links.map((l: any) => l.batch_id).filter(Boolean);
    const batches = batchIds.length
      ? await mongo.collection('batches').find({ id: { $in: batchIds } }).toArray()
      : [];
    const byId = new Map(batches.map((b: any) => [b.id, b]));
    return links.map((l: any) => ({
      faculty_id: l.faculty_id,
      batch_id: l.batch_id,
      is_active: 1,
      batches: byId.get(l.batch_id) || null,
    })).filter((row: Row) => row.batches);
  }
  const rows = await query(
    `SELECT bf.faculty_id, bf.batch_id, 1 AS is_active, b.*
     FROM batch_faculty bf JOIN batches b ON b.id = bf.batch_id
     WHERE bf.faculty_id = ?`,
    [facultyId]
  );
  // Provide the nested shape the UI expects alongside the flat columns.
  return rows.map((row: Row) => ({ ...row, batches: { ...row } }));
}

// ── Relation enrichment for supported tables ──────────────────────────

async function enrichRows(table: string, rowsIn: Row[]): Promise<Row[]> {
  if (!rowsIn.length) return rowsIn;
  const rows = rowsIn.map((r) => ({ ...r }));

  if (table === 'classes') {
    const ids = rows.map((r) => r.id);
    let schedules: Row[] = [];
    if (isMongoActive()) {
      schedules = await getMongoDb()!.collection('class_schedules').find({ class_id: { $in: ids } }).toArray();
    } else {
      schedules = await query(`SELECT * FROM class_schedules WHERE class_id IN (${ids.map(() => '?').join(',')})`, ids);
    }
    const byClass = new Map<string, Row[]>();
    for (const s of schedules) {
      const list = byClass.get(s.class_id) || [];
      list.push(s);
      byClass.set(s.class_id, list);
    }
    for (const row of rows) row.class_schedules = byClass.get(row.id) || [];
    return rows;
  }

  if (table === 'attendance_records') {
    const sessionIds = [...new Set(rows.map((r) => r.session_id).filter(Boolean))];
    const studentIds = [...new Set(rows.map((r) => r.student_id).filter(Boolean))];
    let sessions: Row[] = [];
    let people: Row[] = [];
    if (isMongoActive()) {
      const mongo = getMongoDb()!;
      sessions = sessionIds.length ? await mongo.collection('attendance_sessions').find({ id: { $in: sessionIds } }).toArray() : [];
      people = studentIds.length ? await mongo.collection('profiles').find({ id: { $in: studentIds } }).toArray() : [];
    } else {
      if (sessionIds.length) {
        sessions = await query(`SELECT * FROM attendance_sessions WHERE id IN (${sessionIds.map(() => '?').join(',')})`, sessionIds);
      }
      if (studentIds.length) {
        people = await query(`SELECT id, full_name, identifier, department FROM profiles WHERE id IN (${studentIds.map(() => '?').join(',')})`, studentIds);
      }
    }
    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const profileById = new Map(people.map((p) => [p.id, p]));

    const classIds = [...new Set(sessions.map((s) => s.class_id).filter(Boolean))];
    let classes: Row[] = [];
    if (classIds.length) {
      if (isMongoActive()) {
        classes = await getMongoDb()!.collection('classes').find({ id: { $in: classIds } }).toArray();
      } else {
        classes = await query(`SELECT id, name, code, faculty_id FROM classes WHERE id IN (${classIds.map(() => '?').join(',')})`, classIds);
      }
    }
    const classById = new Map(classes.map((c) => [c.id, c]));

    for (const row of rows) {
      const session = sessionById.get(row.session_id);
      row.profiles = row.student_id ? profileById.get(row.student_id) || null : null;
      if (session) {
        row.attendance_sessions = { ...session, classes: classById.get(session.class_id) || null };
      } else {
        row.attendance_sessions = null;
      }
    }
    return rows;
  }

  if (table === 'join_tokens') {
    const batchIds = [...new Set(rows.map((r) => r.batch_id).filter(Boolean))];
    let batches: Row[] = [];
    if (batchIds.length) {
      if (isMongoActive()) {
        batches = await getMongoDb()!.collection('batches').find({ id: { $in: batchIds } }).toArray();
      } else {
        batches = await query(`SELECT id, name, code FROM batches WHERE id IN (${batchIds.map(() => '?').join(',')})`, batchIds);
      }
    }
    const batchById = new Map(batches.map((b) => [b.id, b]));
    for (const row of rows) row.batches = row.batch_id ? batchById.get(row.batch_id) || null : null;
    return rows;
  }

  if (table === 'batch_members') {
    const batchIds = [...new Set(rows.map((r) => r.batch_id).filter(Boolean))];
    let batches: Row[] = [];
    if (batchIds.length) {
      if (isMongoActive()) {
        batches = await getMongoDb()!.collection('batches').find({ id: { $in: batchIds } }).toArray();
      } else {
        batches = await query(`SELECT * FROM batches WHERE id IN (${batchIds.map(() => '?').join(',')})`, batchIds);
      }
    }
    const batchById = new Map(batches.map((b) => [b.id, b]));
    for (const row of rows) row.batches = row.batch_id ? batchById.get(row.batch_id) || null : null;
    return rows;
  }

  return rows;
}

// ── GET ───────────────────────────────────────────────────────────────

export async function handleQuery(req: Request, res: Response) {
  try {
    const table = req.params.table as string;
    if (!ALLOWED_TABLES.has(table)) {
      res.status(400).json({ error: `Table '${table}' not permitted` });
      return;
    }
    const user = (req as any).user as Row | undefined;

    // Virtual views first
    if (table === 'admin_password_reset_queue') {
      res.json(await passwordResetQueue());
      return;
    }
    if (table === 'student_attendance_summary') {
      const studentId = String(req.query.student_id || user?.id || '');
      res.json(await studentAttendanceSummary(studentId));
      return;
    }
    if (table === 'faculty_assignments') {
      const facultyId = String(req.query.faculty_id || user?.id || '');
      res.json(await facultyAssignments(facultyId));
      return;
    }

    // Students may only read their own attendance records and queries.
    if (user && user.role === 'student' && (table === 'attendance_records' || table === 'attendance_queries')) {
      req.query.student_id = user.id;
    }

    const { select: _select, order, limit, count, head, ...rawFilters } = req.query;

    // ── MongoDB path ──
    if (isMongoActive()) {
      const mongo = getMongoDb()!;
      const filter: Record<string, any> = {};
      for (const [key, val] of Object.entries(rawFilters)) {
        const valStr = String(val);
        if (key.endsWith('!neq')) {
          filter[key.replace(/!neq$/, '')] = { $ne: valStr };
        } else if (key.endsWith('!in')) {
          filter[key.replace(/!in$/, '')] = { $in: valStr.split(',') };
        } else {
          const { op, value } = parseFilterValue(valStr);
          const coerced = coerceValue(value);
          if (op === 'eq') filter[key] = coerced.mongo;
          else filter[key] = { [OP_MONGO[op]]: coerced.mongo };
        }
      }

      let cursor = mongo.collection(table).find(filter);
      if (order) {
        const { col, dir } = splitOrderBy(String(order));
        cursor = cursor.sort({ [col]: dir === 'DESC' ? -1 : 1 });
      }
      const cap = Number(limit) || 300;
      cursor = cursor.limit(Math.min(cap, 1000));
      let rows: Row[] = (await cursor.toArray()).map((doc: any) => {
        const { _id, ...rest } = doc;
        return { ...rest, id: rest.id || String(_id) };
      });

      if (count === 'exact') {
        const total = await mongo.collection(table).countDocuments(filter);
        if (head === 'true') {
          res.json({ count: total });
          return;
        }
        res.setHeader('content-range', `0-${rows.length}/${total}`);
      }

      rows = await enrichRows(table, rows);
      res.json(rows);
      return;
    }

    // ── SQL path (SQLite / PostgreSQL) ──
    let sql = `SELECT * FROM ${table}`;
    const whereClauses: string[] = [];
    const params: any[] = [];
    for (const [key, val] of Object.entries(rawFilters)) {
      const valStr = String(val);
      if (key.endsWith('!neq')) {
        whereClauses.push(`${key.replace(/!neq$/, '')} != ?`);
        params.push(valStr);
      } else if (key.endsWith('!in')) {
        const values = valStr.split(',');
        whereClauses.push(`${key.replace(/!in$/, '')} IN (${values.map(() => '?').join(',')})`);
        params.push(...values);
      } else {
        const { op, value } = parseFilterValue(valStr);
        const coerced = coerceValue(value);
        whereClauses.push(`${key} ${OP_SQL[op]} ?`);
        params.push(coerced.sql);
      }
    }
    if (whereClauses.length) sql += ` WHERE ` + whereClauses.join(' AND ');
    if (order) {
      const { col, dir } = splitOrderBy(String(order));
      sql += ` ORDER BY ${col} ${dir}`;
    }
    if (limit) sql += ` LIMIT ${Math.min(Number(limit) || 300, 1000)}`;

    let rows: Row[] = await query(sql, params);
    if (count === 'exact') {
      if (head === 'true') {
        let countSql = `SELECT COUNT(*) AS total FROM ${table}`;
        if (whereClauses.length) countSql += ` WHERE ` + whereClauses.join(' AND ');
        const totals = await query<{ total: number }>(countSql, params);
        res.json({ count: Number(totals[0]?.total || 0) });
        return;
      }
      res.setHeader('content-range', `0-${rows.length}/${rows.length}`);
    }

    rows = await enrichRows(table, rows);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── Write permission helpers ──────────────────────────────────────────

const ADMIN_ONLY_TABLES = new Set(['system_settings', 'audit_logs', 'face_profiles']);

function canWrite(user: Row | undefined, table: string): boolean {
  if (!user) return false;
  if (ADMIN_ONLY_TABLES.has(table)) return user.role === 'admin';
  if (user.role === 'admin') return true;
  if (user.role === 'faculty') {
    return ['batches', 'classes', 'class_schedules', 'join_tokens', 'batch_faculty', 'enrollments', 'batch_members', 'attendance_sessions', 'devices', 'attendance_queries'].includes(table);
  }
  // Students may register devices and manage their own attendance queries.
  return ['devices', 'attendance_queries'].includes(table);
}

function canDelete(user: Row | undefined, table: string): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return table === 'devices';
}

// ── POST (insert) ─────────────────────────────────────────────────────

export async function handleInsert(req: Request, res: Response) {
  try {
    const table = req.params.table as string;
    if (!ALLOWED_TABLES.has(table) || table.startsWith('admin_') || table === 'student_attendance_summary' || table === 'faculty_assignments') {
      res.status(400).json({ error: `Table '${table}' not permitted` });
      return;
    }
    const user = (req as any).user as Row;
    if (!canWrite(user, table)) {
      res.status(403).json({ error: 'You do not have permission to create this record' });
      return;
    }

    const body = req.body;
    const items: Row[] = Array.isArray(body) ? body : [body];
    const inserted: Row[] = [];

    for (const item of items) {
      const record: Row = { ...item };
      if (!record.id) record.id = crypto.randomUUID();

      // Ownership guards
      if (table === 'profiles') record.id = user.id; // self-service profile creation is not allowed
      if (table === 'attendance_queries') {
        record.student_id = user.id;
        record.student_name = user.full_name;
        record.student_email = user.email;
        record.status = record.status || 'open';
      }

      if (isMongoActive()) {
        try {
          await getMongoDb()!.collection(table).insertOne(record);
        } catch (err: any) {
          if (err.code !== 11000) throw err; // duplicate key → treat as no-op
        }
      } else {
        const keys = Object.keys(record);
        await execute(
          `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
          keys.map((k) => {
            const v = record[k];
            return typeof v === 'boolean' ? (v ? 1 : 0) : v;
          })
        );
      }
      inserted.push(record);
    }

    res.status(201).json(Array.isArray(body) ? inserted : inserted[0]);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── PATCH (update) ────────────────────────────────────────────────────

export async function handleUpdate(req: Request, res: Response) {
  try {
    const table = req.params.table as string;
    if (!ALLOWED_TABLES.has(table) || table.startsWith('admin_') || table === 'student_attendance_summary' || table === 'faculty_assignments') {
      res.status(400).json({ error: `Table '${table}' not permitted` });
      return;
    }
    const user = (req as any).user as Row;
    if (!canWrite(user, table)) {
      res.status(403).json({ error: 'You do not have permission to update this record' });
      return;
    }

    const updates: Row = { ...req.body };
    if (updates.id) delete updates.id;
    const filters = req.query;

    // Scope non-admin writes to their own rows for sensitive tables.
    if (user.role !== 'admin') {
      if (table === 'profiles') filters.id = user.id;
      if (table === 'devices') filters.user_id = user.id;
      if (table === 'attendance_queries') {
        res.status(403).json({ error: 'Students cannot modify a raised query' });
        return;
      }
    }

    const setEntries = Object.entries(updates);
    if (!setEntries.length) {
      res.json({ success: true, message: 'Nothing to update' });
      return;
    }

    const whereClauses: string[] = [];
    const params: any[] = [];
    const setEntriesDone: string[] = [];

    if (isMongoActive()) {
      const mongoFilter: Record<string, any> = {};
      for (const [key, val] of Object.entries(filters)) {
        const valStr = String(val);
        if (valStr.startsWith('eq.')) mongoFilter[key] = valStr.slice(3);
        else mongoFilter[key] = valStr;
      }
      const setFields: Row = {};
      for (const [k, v] of setEntries) setFields[k] = v;
      const result = await getMongoDb()!.collection(table).updateMany(mongoFilter, { $set: setFields });
      res.json({ success: true, updated: result.modifiedCount });
      return;
    }

    for (const [key, val] of Object.entries(filters)) {
      const valStr = String(val);
      whereClauses.push(`${key} = ?`);
      params.push(valStr.startsWith('eq.') ? valStr.slice(3) : valStr);
    }
    for (const [key, val] of setEntries) {
      setEntriesDone.push(`${key} = ?`);
      params.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
    }

    if (!whereClauses.length) {
      res.status(400).json({ error: 'Update requires at least one filter' });
      return;
    }
    const sql = `UPDATE ${table} SET ${setEntriesDone.join(', ')} WHERE ${whereClauses.join(' AND ')}`;
    const result = await execute(sql, params);
    res.json({ success: true, updated: result.changes });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ── DELETE ────────────────────────────────────────────────────────────

export async function handleDelete(req: Request, res: Response) {
  try {
    const table = req.params.table as string;
    if (!ALLOWED_TABLES.has(table) || table.startsWith('admin_') || table === 'student_attendance_summary' || table === 'faculty_assignments') {
      res.status(400).json({ error: `Table '${table}' not permitted` });
      return;
    }
    const user = (req as any).user as Row;
    if (!canDelete(user, table)) {
      res.status(403).json({ error: 'You do not have permission to delete this record' });
      return;
    }
    const filters = req.query;
    const whereClauses: string[] = [];
    const params: any[] = [];

    if (isMongoActive()) {
      const mongoFilter: Record<string, any> = {};
      for (const [key, val] of Object.entries(filters)) {
        const valStr = String(val);
        mongoFilter[key] = valStr.startsWith('eq.') ? valStr.slice(3) : valStr;
      }
      if (!Object.keys(mongoFilter).length) {
        res.status(400).json({ error: 'Delete requires at least one filter' });
        return;
      }
      const result = await getMongoDb()!.collection(table).deleteMany(mongoFilter);
      res.json({ success: true, deleted: result.deletedCount });
      return;
    }

    for (const [key, val] of Object.entries(filters)) {
      const valStr = String(val);
      whereClauses.push(`${key} = ?`);
      params.push(valStr.startsWith('eq.') ? valStr.slice(3) : valStr);
    }
    if (!whereClauses.length) {
      res.status(400).json({ error: 'Delete requires at least one filter' });
      return;
    }
    const result = await execute(`DELETE FROM ${table} WHERE ${whereClauses.join(' AND ')}`, params);
    res.json({ success: true, deleted: result.changes });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
