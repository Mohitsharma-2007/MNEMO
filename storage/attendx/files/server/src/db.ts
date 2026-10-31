import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { MongoClient, Db } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { Pool } = pg;

export type DbKind = 'mongodb' | 'postgres' | 'sqlite';

let dbKind: DbKind = 'sqlite';
let pgPool: pg.Pool | null = null;
let sqliteDb: DatabaseSync | null = null;
let mongoClient: MongoClient | null = null;
let mongoDb: Db | null = null;

// Vercel mounts the deployment bundle read-only. Its writable /tmp directory
// is suitable for the local SQLite fallback during a serverless invocation.
// Production data should still use MONGODB_URI or DATABASE_URL for persistence.
const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'attendx')
  : path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function getMongoDb(): Db | null {
  return mongoDb;
}

export function isMongoActive(): boolean {
  return dbKind === 'mongodb' && Boolean(mongoDb);
}

export async function initDb(): Promise<DbKind> {
  // 1. Check MongoDB first (MongoDB Atlas or local URI)
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URL;
  if (mongoUri) {
    try {
      const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3500 });
      await client.connect();
      mongoClient = client;
      mongoDb = client.db(process.env.MONGODB_DB_NAME || 'attendx');
      dbKind = 'mongodb';
      console.log('🍃 Connected to MongoDB Atlas / Database at', mongoUri.replace(/:[^:@]+@/, ':***@'));
      await initMongoIndexes();
      await seedDefaults();
      return dbKind;
    } catch (err) {
      console.warn('⚠️ MongoDB connection failed, trying fallbacks:', (err as Error).message);
    }
  }

  // 2. Check PostgreSQL
  const pgUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (pgUrl) {
    try {
      const pool = new Pool({ connectionString: pgUrl, connectionTimeoutMillis: 3000 });
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      pgPool = pool;
      dbKind = 'postgres';
      console.log(' Connected to PostgreSQL database at', pgUrl.replace(/:[^:@]+@/, ':***@'));
      await runPostgresSchema();
      await seedDefaults();
      return dbKind;
    } catch (err) {
      console.warn('⚠️ PostgreSQL connection failed, falling back to embedded SQLite:', (err as Error).message);
    }
  }

  // 3. Fallback to embedded SQLite
  const dbPath = path.join(DATA_DIR, 'attendx.sqlite');
  sqliteDb = new DatabaseSync(dbPath);
  sqliteDb.exec('PRAGMA journal_mode = WAL;');
  sqliteDb.exec('PRAGMA foreign_keys = ON;');
  dbKind = 'sqlite';
  console.log(' Connected to embedded SQLite database at', dbPath);
  await runSqliteSchema();
  await seedDefaults();
  return dbKind;
}

export function getDbKind(): DbKind {
  return dbKind;
}

async function initMongoIndexes() {
  if (!mongoDb) return;
  try {
    await mongoDb.collection('profiles').createIndex({ email: 1 }, { unique: true });
    await mongoDb.collection('batches').createIndex({ code: 1 }, { unique: true });
    await mongoDb.collection('classes').createIndex({ code: 1 }, { unique: true });
    await mongoDb.collection('qr_tokens').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    await mongoDb.collection('otps').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await mongoDb.collection('attendance_records').createIndex({ session_id: 1, student_id: 1 }, { unique: true });
    await mongoDb.collection('enrollments').createIndex({ class_id: 1, student_id: 1 }, { unique: true });
    await mongoDb.collection('batch_members').createIndex({ batch_id: 1, student_id: 1 }, { unique: true });
    await mongoDb.collection('batch_faculty').createIndex({ batch_id: 1, faculty_id: 1 }, { unique: true });
    await mongoDb.collection('attendance_queries').createIndex({ tracking_id: 1 }, { unique: true });
    await mongoDb.collection('attendance_queries').createIndex({ student_id: 1, created_at: -1 });
    await mongoDb.collection('attendance_queries').createIndex({ status: 1, created_at: -1 });
  } catch (e) {
    console.warn('MongoDB index initialization note:', (e as Error).message);
  }
}

// ── MongoDB-aware query/execute layer ────────────────────────────────

/**
 * Translate simple SQL SELECT into MongoDB find.
 * Supports: SELECT <cols|*> FROM <col> WHERE <field>=? AND ... ORDER BY <f> ASC|DESC LIMIT N
 * Also handles lower(field) = ? / lower(field) = lower(?) and field IN (a,b,c).
 */
function parseSqlForMongo(sql: string, params: any[]): {
  collection: string;
  filter: Record<string, any>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  isInsert?: boolean;
  isUpdate?: boolean;
  isDelete?: boolean;
  updateSet?: Record<string, any>;
  insertRow?: Record<string, any>;
} | null {
  const trimmed = sql.trim();

  // SELECT
  const selectMatch = trimmed.match(
    /^SELECT\s+([\w\s,*]+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(\w+)\s+(ASC|DESC))?(?:\s+LIMIT\s+(\d+))?$/i
  );
  if (selectMatch) {
    const columnList = selectMatch[1].trim();
    const collection = selectMatch[2];
    const whereClause = selectMatch[3] || '';
    const orderCol = selectMatch[4];
    const orderDir = selectMatch[5];
    const limitVal = selectMatch[6];

    const filter: Record<string, any> = {};
    if (whereClause) {
      // Parse WHERE conditions
      const conditions = whereClause.split(/\s+AND\s+/i);
      let pIdx = 0;
      for (const cond of conditions) {
        const eqMatch = cond.match(/(\w+)\s*=\s*\?/);
        const neqMatch = cond.match(/(\w+)\s*!=\s*\?/);
        const gtMatch = cond.match(/(\w+)\s*>\s*\?/);
        const gteMatch = cond.match(/(\w+)\s*>=\s*\?/);
        const ltMatch = cond.match(/(\w+)\s*<\s*\?/);
        const lteMatch = cond.match(/(\w+)\s*<=\s*\?/);
        const lowerEqMatch = cond.match(/lower\((\w+)\)\s*=\s*lower\(\?\)/i);
        const lowerEqSingle = cond.match(/lower\((\w+)\)\s*=\s*\?/i);
        const inMatch = cond.match(/(\w+)\s+IN\s+\(([^)]*)\)/i);

        if (inMatch) {
          const values = inMatch[2].split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).map((v) => v === '?' ? params[pIdx++] : (isNaN(Number(v)) ? v : Number(v)));
          filter[inMatch[1]] = { $in: values };
        } else if (lowerEqSingle) {
          const val = params[pIdx++];
          filter[lowerEqSingle[1]] = { $regex: new RegExp(`^${String(val).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}$`, 'i') };
        } else if (lowerEqMatch) {
          const val = params[pIdx++];
          filter[lowerEqMatch[1]] = { $regex: new RegExp(`^${String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') };
        } else if (neqMatch) {
          filter[neqMatch[1]] = { $ne: params[pIdx++] };
        } else if (gteMatch) {
          filter[gteMatch[1]] = { $gte: params[pIdx++] };
        } else if (gtMatch) {
          filter[gtMatch[1]] = { $gt: params[pIdx++] };
        } else if (lteMatch) {
          filter[lteMatch[1]] = { $lte: params[pIdx++] };
        } else if (ltMatch) {
          filter[ltMatch[1]] = { $lt: params[pIdx++] };
        } else if (eqMatch) {
          filter[eqMatch[1]] = params[pIdx++];
        }
      }
    }

    const result: any = { collection, filter };
    // Column-list projection (SELECT id, name FROM …)
    if (!columnList.includes('*')) {
      const projection: Record<string, 1> = {};
      for (const c of columnList.split(',').map((s) => s.trim()).filter(Boolean)) projection[c] = 1;
      result.projection = projection;
    }
    if (orderCol) result.sort = { [orderCol]: orderDir?.toUpperCase() === 'DESC' ? -1 : 1 };
    if (limitVal) result.limit = parseInt(limitVal, 10);
    return result;
  }

  // INSERT (INSERT INTO ... VALUES ...)
  const insertMatch = trimmed.match(/^INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
  if (insertMatch) {
    const collection = insertMatch[1];
    const cols = insertMatch[2].split(',').map(c => c.trim());
    const row: Record<string, any> = {};
    cols.forEach((col, i) => { row[col] = params[i]; });
    return { collection, filter: {}, isInsert: true, insertRow: row };
  }

  // UPDATE ... SET ... WHERE ...
  const updateMatch = trimmed.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i);
  if (updateMatch) {
    const collection = updateMatch[1];
    const setClauses = updateMatch[2].split(',').map(s => s.trim());
    const whereStr = updateMatch[3];

    let pIdx = 0;
    const updateSet: Record<string, any> = {};
    for (const clause of setClauses) {
      const m = clause.match(/(\w+)\s*=\s*(?:\?|datetime\('now'\))/);
      if (m) {
        if (clause.includes("datetime('now')")) {
          updateSet[m[1]] = new Date().toISOString();
        } else {
          updateSet[m[1]] = params[pIdx++];
        }
      }
    }

    const filter: Record<string, any> = {};
    const conditions = whereStr.split(/\s+AND\s+/i);
    for (const cond of conditions) {
      const eqMatch = cond.match(/(\w+)\s*=\s*\?/);
      if (eqMatch) {
        filter[eqMatch[1]] = params[pIdx++];
      }
    }

    return { collection, filter, isUpdate: true, updateSet };
  }

  // DELETE FROM ... WHERE ...
  const deleteMatch = trimmed.match(/^DELETE\s+FROM\s+(\w+)\s+WHERE\s+(.+)$/i);
  if (deleteMatch) {
    const collection = deleteMatch[1];
    const whereStr = deleteMatch[2];
    let pIdx = 0;
    const filter: Record<string, any> = {};
    const conditions = whereStr.split(/\s+AND\s+/i);
    for (const cond of conditions) {
      const eqMatch = cond.match(/(\w+)\s*=\s*\?/);
      if (eqMatch) {
        filter[eqMatch[1]] = params[pIdx++];
      }
    }
    return { collection, filter, isDelete: true };
  }

  return null;
}

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  // MongoDB path
  if (dbKind === 'mongodb' && mongoDb) {
    const parsed = parseSqlForMongo(sql, params);
    if (!parsed) {
      console.warn('MongoDB: Could not parse SQL, returning empty:', sql);
      return [];
    }
    let cursor = mongoDb.collection(parsed.collection).find(parsed.filter, parsed.projection ? { projection: parsed.projection } : undefined);
    if (parsed.sort) cursor = cursor.sort(parsed.sort);
    if (parsed.limit) cursor = cursor.limit(parsed.limit);
    const docs = await cursor.toArray();
    // Normalize MongoDB _id to id
    return docs.map(doc => {
      const { _id, ...rest } = doc as any;
      if (!rest.id && _id) rest.id = String(_id);
      return rest as T;
    });
  }

  if (dbKind === 'postgres' && pgPool) {
    // Postgres uses $1, $2 instead of ?
    let pgSql = sql;
    let paramIdx = 1;
    pgSql = pgSql.replace(/\?/g, () => `$${paramIdx++}`);
    const res = await pgPool.query(pgSql, params);
    return res.rows as T[];
  }

  if (sqliteDb) {
    const stmt = sqliteDb.prepare(sql);
    return stmt.all(...params) as T[];
  }

  return [];
}

export async function execute(sql: string, params: any[] = []): Promise<{ changes: number; lastInsertRowid?: number | bigint }> {
  // MongoDB path
  if (dbKind === 'mongodb' && mongoDb) {
    const parsed = parseSqlForMongo(sql, params);
    if (!parsed) {
      console.warn('MongoDB: Could not parse SQL for execute, skipping:', sql);
      return { changes: 0 };
    }

    if (parsed.isInsert && parsed.insertRow) {
      const isIgnore = /INSERT\s+OR\s+IGNORE/i.test(sql.trim());
      try {
        await mongoDb.collection(parsed.collection).insertOne(parsed.insertRow);
        return { changes: 1 };
      } catch (err: any) {
        if (isIgnore && err.code === 11000) {
          // Duplicate key — INSERT OR IGNORE semantics
          return { changes: 0 };
        }
        throw err;
      }
    }

    if (parsed.isUpdate && parsed.updateSet) {
      const result = await mongoDb.collection(parsed.collection).updateMany(parsed.filter, { $set: parsed.updateSet });
      return { changes: result.modifiedCount };
    }

    if (parsed.isDelete) {
      const result = await mongoDb.collection(parsed.collection).deleteMany(parsed.filter);
      return { changes: result.deletedCount };
    }

    return { changes: 0 };
  }

  if (dbKind === 'postgres' && pgPool) {
    let pgSql = sql;
    let paramIdx = 1;
    // Convert INSERT OR IGNORE to ON CONFLICT DO NOTHING for postgres
    pgSql = pgSql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
    if (/INSERT\s+INTO/i.test(pgSql) && sql.match(/INSERT\s+OR\s+IGNORE/i)) {
      pgSql = pgSql.replace(/VALUES\s*\(([^)]+)\)$/i, (match) => `${match} ON CONFLICT DO NOTHING`);
    }
    pgSql = pgSql.replace(/\?/g, () => `$${paramIdx++}`);
    // Convert datetime('now') to NOW() for Postgres
    pgSql = pgSql.replace(/datetime\('now'\)/gi, 'NOW()');
    const res = await pgPool.query(pgSql, params);
    return { changes: res.rowCount || 0 };
  }

  if (sqliteDb) {
    const stmt = sqliteDb.prepare(sql);
    const info = stmt.run(...params);
    return { changes: Number(info.changes), lastInsertRowid: info.lastInsertRowid };
  }

  return { changes: 0 };
}

export async function getOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] || null;
}

async function runPostgresSchema() {
  if (!pgPool) return;
  const ddl = `
    CREATE TABLE IF NOT EXISTS profiles (
      id UUID PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('student', 'faculty', 'admin')),
      identifier TEXT,
      department TEXT,
      approval_status TEXT NOT NULL DEFAULT 'approved',
      is_active BOOLEAN NOT NULL DEFAULT true,
      invite_code TEXT,
      password_hash TEXT,
      must_change_password BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS batches (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      department TEXT,
      academic_year TEXT,
      start_year INTEGER,
      end_year INTEGER,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS classes (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      batch_id UUID REFERENCES batches(id) ON DELETE CASCADE,
      faculty_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
      created_by UUID,
      department TEXT,
      geofence_lat DOUBLE PRECISION,
      geofence_lng DOUBLE PRECISION,
      geofence_radius_m INTEGER DEFAULT 50,
      is_active BOOLEAN NOT NULL DEFAULT true,
      publication_status TEXT DEFAULT 'published',
      published_by UUID,
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS class_schedules (
      id UUID PRIMARY KEY,
      class_id UUID REFERENCES classes(id) ON DELETE CASCADE,
      day_of_week INTEGER,
      start_time TEXT,
      end_time TEXT,
      room TEXT,
      schedule_type TEXT,
      session_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      id UUID PRIMARY KEY,
      class_id UUID REFERENCES classes(id) ON DELETE CASCADE,
      student_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (class_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS batch_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id UUID REFERENCES batches(id) ON DELETE CASCADE,
      student_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (batch_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS batch_faculty (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id UUID REFERENCES batches(id) ON DELETE CASCADE,
      faculty_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (batch_id, faculty_id)
    );

    CREATE TABLE IF NOT EXISTS attendance_sessions (
      id UUID PRIMARY KEY,
      class_id UUID REFERENCES classes(id) ON DELETE CASCADE,
      faculty_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      center_lat DOUBLE PRECISION NOT NULL,
      center_lng DOUBLE PRECISION NOT NULL,
      geofence_radius_m INTEGER NOT NULL DEFAULT 50,
      refresh_interval_s INTEGER NOT NULL DEFAULT 15,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      scheduled_end_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS qr_tokens (
      id UUID PRIMARY KEY,
      session_id UUID REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      nonce TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS devices (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
      device_uuid TEXT NOT NULL,
      platform TEXT,
      model TEXT,
      os_version TEXT,
      app_version TEXT,
      is_trusted BOOLEAN NOT NULL DEFAULT true,
      integrity_verdict JSONB,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, device_uuid)
    );

    CREATE TABLE IF NOT EXISTS attendance_records (
      id UUID PRIMARY KEY,
      session_id UUID REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      student_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
      gps_lat DOUBLE PRECISION,
      gps_lng DOUBLE PRECISION,
      gps_accuracy_m DOUBLE PRECISION,
      distance_from_center_m DOUBLE PRECISION,
      is_mock_location BOOLEAN DEFAULT false,
      developer_mode_detected BOOLEAN DEFAULT false,
      selfie_path TEXT,
      classroom_photo_path TEXT,
      device_id UUID REFERENCES devices(id),
      ip_address TEXT,
      integrity_verdict JSONB,
      selfie_captured_at TIMESTAMPTZ,
      selfie_uploaded_at TIMESTAMPTZ,
      classroom_captured_at TIMESTAMPTZ,
      classroom_uploaded_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'present',
      rejection_reason TEXT,
      evidence_review_status TEXT DEFAULT 'approved',
      marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (session_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS join_tokens (
      id UUID PRIMARY KEY,
      batch_id UUID REFERENCES batches(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      token_type TEXT DEFAULT 'batch_join',
      purpose TEXT,
      max_uses INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      expires_at TIMESTAMPTZ,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      identifier TEXT,
      reason TEXT,
      temp_password TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS face_profiles (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
      model TEXT,
      model_version TEXT,
      embedding JSONB NOT NULL,
      quality_score DOUBLE PRECISION,
      source_photo_path TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY,
      actor_id UUID,
      action TEXT NOT NULL,
      target_table TEXT,
      target_id UUID,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS attendance_queries (
      id UUID PRIMARY KEY,
      tracking_id TEXT UNIQUE NOT NULL,
      student_id UUID,
      student_name TEXT,
      student_email TEXT,
      student_identifier TEXT,
      class_id UUID,
      class_label TEXT,
      session_id UUID,
      type TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      admin_note TEXT,
      email_sent BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id UUID NOT NULL,
      role TEXT NOT NULL,
      email TEXT,
      expires_at BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await pgPool.query(ddl);
  await pgPool.query(
    "ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
  );
}

async function runSqliteSchema() {
  if (!sqliteDb) return;
  const ddl = `
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('student', 'faculty', 'admin')),
      identifier TEXT,
      department TEXT,
      approval_status TEXT NOT NULL DEFAULT 'approved',
      is_active INTEGER NOT NULL DEFAULT 1,
      invite_code TEXT,
      password_hash TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      department TEXT,
      academic_year TEXT,
      start_year INTEGER,
      end_year INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      batch_id TEXT REFERENCES batches(id) ON DELETE CASCADE,
      faculty_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
      created_by TEXT,
      department TEXT,
      geofence_lat REAL,
      geofence_lng REAL,
      geofence_radius_m INTEGER DEFAULT 50,
      is_active INTEGER NOT NULL DEFAULT 1,
      publication_status TEXT DEFAULT 'published',
      published_by TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS class_schedules (
      id TEXT PRIMARY KEY,
      class_id TEXT REFERENCES classes(id) ON DELETE CASCADE,
      day_of_week INTEGER,
      start_time TEXT,
      end_time TEXT,
      room TEXT,
      schedule_type TEXT,
      session_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      id TEXT PRIMARY KEY,
      class_id TEXT REFERENCES classes(id) ON DELETE CASCADE,
      student_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (class_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS batch_members (
      id TEXT PRIMARY KEY,
      batch_id TEXT REFERENCES batches(id) ON DELETE CASCADE,
      student_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (batch_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS batch_faculty (
      id TEXT PRIMARY KEY,
      batch_id TEXT REFERENCES batches(id) ON DELETE CASCADE,
      faculty_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (batch_id, faculty_id)
    );

    CREATE TABLE IF NOT EXISTS attendance_sessions (
      id TEXT PRIMARY KEY,
      class_id TEXT REFERENCES classes(id) ON DELETE CASCADE,
      faculty_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      center_lat REAL NOT NULL,
      center_lng REAL NOT NULL,
      geofence_radius_m INTEGER NOT NULL DEFAULT 50,
      refresh_interval_s INTEGER NOT NULL DEFAULT 15,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      scheduled_end_at TEXT,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS qr_tokens (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      nonce TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
      device_uuid TEXT NOT NULL,
      platform TEXT,
      model TEXT,
      os_version TEXT,
      app_version TEXT,
      is_trusted INTEGER NOT NULL DEFAULT 1,
      integrity_verdict TEXT,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, device_uuid)
    );

    CREATE TABLE IF NOT EXISTS attendance_records (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      student_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
      gps_lat REAL,
      gps_lng REAL,
      gps_accuracy_m REAL,
      distance_from_center_m REAL,
      is_mock_location INTEGER DEFAULT 0,
      developer_mode_detected INTEGER DEFAULT 0,
      selfie_path TEXT,
      classroom_photo_path TEXT,
      device_id TEXT REFERENCES devices(id),
      ip_address TEXT,
      integrity_verdict TEXT,
      selfie_captured_at TEXT,
      selfie_uploaded_at TEXT,
      classroom_captured_at TEXT,
      classroom_uploaded_at TEXT,
      status TEXT NOT NULL DEFAULT 'present',
      rejection_reason TEXT,
      evidence_review_status TEXT DEFAULT 'approved',
      marked_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (session_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS join_tokens (
      id TEXT PRIMARY KEY,
      batch_id TEXT REFERENCES batches(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      token_type TEXT DEFAULT 'batch_join',
      purpose TEXT,
      max_uses INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      identifier TEXT,
      reason TEXT,
      temp_password TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS face_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
      model TEXT,
      model_version TEXT,
      embedding TEXT NOT NULL,
      quality_score REAL,
      source_photo_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      action TEXT NOT NULL,
      target_table TEXT,
      target_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS attendance_queries (
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
      status TEXT NOT NULL DEFAULT 'open',
      admin_note TEXT,
      email_sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      email TEXT,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `;
  sqliteDb.exec(ddl);

  // Existing local databases predate marked_at. SQLite cannot add this column
  // with a non-constant default, so backfill it from the existing timestamp.
  const columns = sqliteDb.prepare('PRAGMA table_info(attendance_records)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'marked_at')) {
    sqliteDb.exec('ALTER TABLE attendance_records ADD COLUMN marked_at TEXT');
    sqliteDb.exec('UPDATE attendance_records SET marked_at = created_at WHERE marked_at IS NULL');
  }

  // ── Migrations for databases created before these columns existed ──
  const columnsFor = (table: string): Array<{ name: string }> =>
    sqliteDb!.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>;
  const addColumn = (table: string, column: string, ddlType: string) => {
    if (!columnsFor(table).some((c) => c.name === column)) {
      sqliteDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
    }
  };

  addColumn('class_schedules', 'schedule_type', 'TEXT');
  addColumn('class_schedules', 'session_date', 'TEXT');
  addColumn('qr_tokens', 'use_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('batches', 'start_year', 'INTEGER');
  addColumn('batches', 'end_year', 'INTEGER');
  addColumn('batches', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('classes', 'created_by', 'TEXT');
  addColumn('classes', 'department', 'TEXT');
  addColumn('classes', 'published_by', 'TEXT');
  addColumn('classes', 'published_at', 'TEXT');
  addColumn('join_tokens', 'token_type', "TEXT DEFAULT 'batch_join'");
  addColumn('join_tokens', 'purpose', 'TEXT');
  addColumn('join_tokens', 'max_uses', 'INTEGER');
  addColumn('join_tokens', 'use_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('join_tokens', 'created_by', 'TEXT');
  addColumn('system_settings', 'description', 'TEXT');
  addColumn('system_settings', 'updated_at', 'TEXT');
}

// Simple hash for password
export function hashPassword(plain: string): string {
  return crypto.createHash('sha256').update(plain + 'attendx_salt_secure_2026').digest('hex');
}

export function verifyPassword(plain: string, hash: string): boolean {
  return hashPassword(plain) === hash;
}

async function seedDefaults() {
  const adminEmail = 'admin@attendx.edu';
  const facultyEmail = 'faculty@attendx.edu';
  const studentEmail = 'student@attendx.edu';

  let admin = await getOne('SELECT * FROM profiles WHERE email = ?', [adminEmail]);
  if (!admin) {
    const adminId = crypto.randomUUID();
    const passwordHash = hashPassword('Admin@123456');
    await execute(
      `INSERT INTO profiles (id, email, full_name, role, identifier, department, approval_status, is_active, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [adminId, adminEmail, 'System Administrator', 'admin', 'ADM-001', 'Administration', 'approved', 1, passwordHash]
    );
    console.log('✅ Seeded default administrator: admin@attendx.edu (Password: Admin@123456)');
    admin = { id: adminId };
  }

  let faculty = await getOne('SELECT * FROM profiles WHERE email = ?', [facultyEmail]);
  if (!faculty) {
    const facultyId = crypto.randomUUID();
    const passwordHash = hashPassword('Faculty@123456');
    await execute(
      `INSERT INTO profiles (id, email, full_name, role, identifier, department, approval_status, is_active, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [facultyId, facultyEmail, 'Prof. Robert Vance', 'faculty', 'FAC-001', 'Computer Science', 'approved', 1, passwordHash]
    );
    console.log('✅ Seeded default faculty: faculty@attendx.edu (Password: Faculty@123456)');
    faculty = { id: facultyId };
  }

  let student = await getOne('SELECT * FROM profiles WHERE email = ?', [studentEmail]);
  if (!student) {
    const studentId = crypto.randomUUID();
    const passwordHash = hashPassword('Student@123456');
    await execute(
      `INSERT INTO profiles (id, email, full_name, role, identifier, department, approval_status, is_active, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [studentId, studentEmail, 'Alex Mercer', 'student', 'STU-001', 'Computer Science', 'approved', 1, passwordHash]
    );
    console.log('✅ Seeded default student: student@attendx.edu (Password: Student@123456)');
    student = { id: studentId };
  }

  // Seed sample batch and class if empty
  const batches = await query('SELECT * FROM batches LIMIT 1');
  if (batches.length === 0) {
    const batchId = crypto.randomUUID();
    await execute(
      `INSERT INTO batches (id, name, code, department, academic_year, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [batchId, 'Computer Science 2026', 'CS-2026', 'Computer Science', '2025-2026', admin.id]
    );

    const classId = crypto.randomUUID();
    await execute(
      `INSERT INTO classes (id, name, code, batch_id, faculty_id, department, geofence_lat, geofence_lng, geofence_radius_m, is_active, publication_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [classId, 'Advanced Distributed Systems', 'CS401', batchId, faculty.id, 'Computer Science', 28.6139, 77.2090, 100, 1, 'published']
    );

    // Link faculty to batch and enroll student
    await execute(
      `INSERT OR IGNORE INTO batch_faculty (id, batch_id, faculty_id) VALUES (?, ?, ?)`,
      [crypto.randomUUID(), batchId, faculty.id]
    );
    await execute(
      `INSERT OR IGNORE INTO batch_members (id, batch_id, student_id, status) VALUES (?, ?, ?, ?)`,
      [crypto.randomUUID(), batchId, student.id, 'active']
    );
    await execute(
      `INSERT OR IGNORE INTO enrollments (id, class_id, student_id, status) VALUES (?, ?, ?, ?)`,
      [crypto.randomUUID(), classId, student.id, 'active']
    );

    console.log('✅ Seeded default batch (CS-2026), class (CS401), and linked faculty/student');
  } else {
    // Self-repair older seeded databases that are missing the faculty/student
    // links (the class previously shipped without faculty_id assigned).
    const batch = batches[0] as any;
    const linkedClass = await getOne('SELECT * FROM classes WHERE batch_id = ? LIMIT 1', [batch.id]);
    if (linkedClass) {
      await execute('UPDATE classes SET faculty_id = ? WHERE id = ? AND faculty_id IS NULL', [faculty.id, linkedClass.id]);
    }
    await execute('INSERT OR IGNORE INTO batch_faculty (id, batch_id, faculty_id) VALUES (?, ?, ?)', [crypto.randomUUID(), batch.id, faculty.id]);
    await execute('INSERT OR IGNORE INTO batch_members (id, batch_id, student_id, status) VALUES (?, ?, ?, ?)', [crypto.randomUUID(), batch.id, student.id, 'active']);
    if (linkedClass) {
      await execute('INSERT OR IGNORE INTO enrollments (id, class_id, student_id, status) VALUES (?, ?, ?, ?)', [crypto.randomUUID(), linkedClass.id, student.id, 'active']);
    }
  }

  // Seed default system settings — check-then-insert keeps Mongo idempotent
  // (INSERT OR IGNORE has no Mongo translation and would duplicate every boot).
  for (const [key, value] of [
    ['web_attendance_enabled', 'true'],
    ['identity_document_required', 'false'],
  ] as const) {
    const existing = await getOne('SELECT * FROM system_settings WHERE key = ?', [key]);
    if (!existing) {
      await execute(`INSERT INTO system_settings (key, value) VALUES (?, ?)`, [key, value]);
    }
  }

  // One-time cleanup: collapse duplicate keys (legacy seeding created repeats).
  if (isMongoActive() && mongoDb) {
    try {
      const dupes = await mongoDb.collection('system_settings').aggregate([
        { $group: { _id: '$key', ids: { $push: '$_id' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ]).toArray();
      for (const d of dupes) {
        const removeIds = d.ids.slice(1); // keep the first document
        if (removeIds.length) {
          await mongoDb.collection('system_settings').deleteMany({ _id: { $in: removeIds } });
          console.log(`System settings: removed ${removeIds.length} duplicate row(s) for key "${d._id}"`);
        }
      }
    } catch (e) {
      console.warn('System settings dedupe skipped:', (e as Error).message);
    }
  }
}
