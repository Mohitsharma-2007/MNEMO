import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Filter,
  Flag,
  Globe2,
  Inbox,
  KeyRound,
  LoaderCircle,
  LocateFixed,
  MapPin,
  MoreHorizontal,
  Plus,
  QrCode,
  RefreshCw,
  ScanLine,
  Search,
  Server,
  Settings,
  ShieldAlert,
  Smartphone,
  TrendingUp,
  Upload,
  UserRound,
  UsersRound,
  Users,
  Wifi,
  X,
  Share2,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { MailQuestion, ShieldCheck as ShieldCheckIcon } from "lucide-react";
import { Geolocation } from "@capacitor/geolocation";
import { Capacitor } from "@capacitor/core";
import { BarcodeScanner } from "@capacitor-mlkit/barcode-scanning";
import type { Role } from "./types";
import { useAppStore } from "./store";
import { supabase } from "./lib/apiClient";
import { getLocalServerUrl, setLocalServerUrl } from "./lib/apiClient";
import { checkDeviceIntegrity } from "./lib/deviceIntegrity";
import { Button, Initials, StatusPill } from "./components/ui";
import {
  CameraCaptureModal,
  captureNativePhoto,
  type LivePhoto,
} from "./components/CameraCapture";
import { extractJoinToken, QrScannerModal } from "./components/QrScanner";
import { ServerAndSyncSettings } from "./components/ServerAndSyncSettings";
import exifr from 'exifr';

type QueryState<T> = { data: T; loading: boolean; error: string };
type DbClass = {
  id: string;
  name: string;
  code: string;
  faculty_id?: string;
  batch_id?: string;
  subject_id?: string;
  department?: string;
  semester?: string;
  academic_year?: string;
  is_active?: boolean;
  publication_status?: "draft" | "published" | "archived";
  published_at?: string;
  class_schedules?: any[];
};
type DbRecord = {
  id: string;
  status: string;
  marked_at: string;
  gps_accuracy_m?: number;
  distance_from_center_m?: number;
  rejection_reason?: string;
  review_notes?: string;
  selfie_path?: string;
  classroom_photo_path?: string;
  student_id?: string;
  session_id?: string;
  attendance_sessions?: any;
  profiles?: any;
};

function useLoad<T>(
  initial: T,
  loader: () => Promise<T>,
  dependencies: unknown[] = [],
): QueryState<T> & { reload: () => void } {
  const [state, setState] = useState<QueryState<T>>({
    data: initial,
    loading: true,
    error: "",
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setState((value) => ({ ...value, loading: true, error: "" }));
    loader()
      .then((data) => current && setState({ data, loading: false, error: "" }))
      .catch(
        (error) =>
          current &&
          setState({
            data: initial,
            loading: false,
            error:
              error instanceof Error ? error.message : "Could not load data",
          }),
      );
    return () => {
      current = false;
    };
    // The caller explicitly controls dependencies; loader functions are intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, revision]);
  return { ...state, reload: () => setRevision((value) => value + 1) };
}

async function rows<T>(
  query: PromiseLike<{ data: T[] | null; error: any }>,
): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data as T[]) ?? [];
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {action}
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  icon: Icon,
  tone = "mint",
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof Activity;
  tone?: string;
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-top">
        <span>{label}</span>
        <span className="metric-icon">
          <Icon size={17} />
        </span>
      </div>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

function DataState({
  loading,
  error,
  empty,
  children,
}: {
  loading: boolean;
  error: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  if (loading)
    return (
      <div className="data-state">
        <LoaderCircle className="spin" size={23} />
        <strong>Loading live data</strong>
      </div>
    );
  if (error)
    return (
      <div className="data-state data-error">
        <AlertTriangle size={23} />
        <strong>Could not load data</strong>
        <span>{error}</span>
      </div>
    );
  if (empty)
    return (
      <div className="data-state">
        <FileText size={24} />
        <strong>No records yet</strong>
        <span>New records will appear here when they are created.</span>
      </div>
    );
  return <>{children}</>;
}

function formatDate(value?: string) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "--";
}
function percent(present: number, total: number) {
  return total ? Math.round((present / total) * 100) : 0;
}

async function loadClasses(role: Role, userId: string): Promise<DbClass[]> {
  if (role === "admin")
    return rows<DbClass>(supabase.from("classes").select("*").order("name"));
  if (role === "faculty")
    return rows<DbClass>(
      supabase
        .from("classes")
        .select("*")
        .eq("faculty_id", userId)
        .order("name"),
    );
  const enrollments = await rows<any>(
    supabase
      .from("enrollments")
      .select("class_id")
      .eq("student_id", userId)
      .eq("status", "active"),
  );
  const ids = enrollments.map((item) => item.class_id);
  return ids.length
    ? rows<DbClass>(
        supabase
          .from("classes")
          .select("*")
          .in("id", ids)
          .order("name"),
      )
    : [];
}

async function loadFacultyBatches(userId: string): Promise<any[]> {
  const [assigned, owned] = await Promise.all([
    rows<any>(
      supabase
        .from("faculty_assignments")
        .select("*")
        .eq("faculty_id", userId),
    ),
    rows<any>(
      supabase
        .from("batches")
        .select("*")
        .eq("created_by", userId),
    ),
  ]);
  const combined = [
    ...assigned.map((item) => item.batches).filter(Boolean),
    ...owned,
  ];
  return Array.from(new Map(combined.map((item) => [item.id, item])).values());
}

/**
 * Load attendance records. The AttendX API enriches every record with its
 * session and class information, so filters that used embedded-resource
 * syntax are applied client-side here.
 */
async function loadAttendance(
  role: Role,
  userId: string,
  limit = 50,
  filters?: { date?: string; month?: string; classId?: string },
): Promise<DbRecord[]> {
  let records = await rows<DbRecord>(
    supabase
      .from("attendance_records")
      .select("*")
      .order("marked_at", { ascending: false })
      .limit(300),
  );

  if (role === "student") {
    records = records.filter((r) => r.student_id === userId);
  } else if (role === "faculty") {
    records = records.filter(
      (r) => r.attendance_sessions?.classes?.faculty_id === userId,
    );
  }
  if (filters?.classId) {
    records = records.filter(
      (r) => r.attendance_sessions?.class_id === filters.classId,
    );
  }
  if (filters?.date) {
    const start = new Date(filters.date);
    const end = new Date(filters.date);
    end.setDate(end.getDate() + 1);
    records = records.filter((r) => {
      const t = new Date(r.marked_at).getTime();
      return t >= start.getTime() && t < end.getTime();
    });
  } else if (filters?.month) {
    const start = new Date(filters.month + "-01");
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    records = records.filter((r) => {
      const t = new Date(r.marked_at).getTime();
      return t >= start.getTime() && t < end.getTime();
    });
  }
  return records.slice(0, limit);
}

export function StudentDashboard({ go }: { go: (key: any) => void }) {
  const { profile } = useAppStore();
  const dashboard = useLoad(
    {
      classes: [] as DbClass[],
      records: [] as DbRecord[],
      summaries: [] as any[],
      sessions: [] as any[],
    },
    async () => {
      const [classes, records, summaries] = await Promise.all([
        loadClasses("student", profile.id),
        loadAttendance("student", profile.id, 8),
        rows<any>(
          supabase
            .from("student_attendance_summary")
            .select("*"),
        ),
      ]);
      const classIds = classes.map((item) => item.id);
      const sessions = classIds.length
        ? await rows<any>(
            supabase
              .from("attendance_sessions")
              .select("*")
              .in("class_id", classIds)
              .eq("status", "active")
              .order("started_at", { ascending: false }),
          )
        : [];
      return { classes, records, summaries, sessions };
    },
    [profile.id],
  );
  const completed = dashboard.data.summaries.reduce(
    (sum, item) => sum + Number(item.completed_sessions || 0),
    0,
  );
  const present = dashboard.data.summaries.reduce(
    (sum, item) => sum + Number(item.sessions_present || 0),
    0,
  );
  const below = dashboard.data.summaries.filter(
    (item) => Number(item.attendance_percentage) < 75,
  ).length;
  return (
    <>
      <PageHeader
        eyebrow={new Intl.DateTimeFormat(undefined, {
          dateStyle: "full",
        }).format(new Date())}
        title={`Hello, ${profile.full_name.split(" ")[0] || "Student"}`}
        description="Your attendance data is loaded directly from your institution database."
        action={
          <div className="page-actions">
            <Button variant="secondary" onClick={() => go("classes")}>
              <UsersRound size={17} />
              Join batch
            </Button>
            <Button variant="secondary" onClick={() => go("mail")}>
              <Inbox size={17} />
              Mail Center
            </Button>
            <Button onClick={() => go("mark")}>
              <QrCode size={18} />
              Mark attendance
            </Button>
          </div>
        }
      />
      <DataState
        loading={dashboard.loading}
        error={dashboard.error}
        empty={false}
      >
        <>
          {dashboard.data.sessions[0] && (
            <div className="session-banner">
              <div className="banner-icon">
                <Activity size={22} />
              </div>
              <div>
                <strong>Attendance is open</strong>
                <span>
                  {dashboard.data.sessions[0].classes?.name} · started{" "}
                  {formatDate(dashboard.data.sessions[0].started_at)}
                </span>
              </div>
              <Button variant="secondary" onClick={() => go("mark")}>
                Scan QR <ArrowRight size={16} />
              </Button>
            </div>
          )}
          <section className="metric-grid">
            <Metric
              label="Overall attendance"
              value={`${percent(present, completed)}%`}
              note={`${present} present of ${completed} completed sessions`}
              icon={TrendingUp}
            />
            <Metric
              label="Enrolled classes"
              value={String(dashboard.data.classes.length)}
              note="Active class enrollments"
              icon={BookOpen}
              tone="blue"
            />
            <Metric
              label="Open sessions"
              value={String(dashboard.data.sessions.length)}
              note="Available to mark now"
              icon={Activity}
              tone="amber"
            />
            <Metric
              label="Below threshold"
              value={String(below)}
              note="Classes below 75%"
              icon={AlertTriangle}
              tone="rose"
            />
          </section>
          <div className="dashboard-grid">
            <section className="panel upcoming-panel">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">Enrollment</p>
                  <h2>My classes</h2>
                </div>
                <button className="text-button" onClick={() => go("classes")}>
                  View all <ChevronRight size={16} />
                </button>
              </div>
              <ClassRows classes={dashboard.data.classes} />
            </section>
            <section className="panel health-panel">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">Current standing</p>
                  <h2>By class</h2>
                </div>
              </div>
              <div className="summary-list">
                {dashboard.data.summaries.length ? (
                  dashboard.data.summaries.map((item) => (
                    <div className="health-row" key={item.class_id}>
                      <span>{item.class_code}</span>
                      <strong>
                        {Number(item.attendance_percentage).toFixed(1)}%
                      </strong>
                    </div>
                  ))
                ) : (
                  <SmallEmpty label="No completed sessions" />
                )}
              </div>
            </section>
          </div>
          <section className="panel recent-panel">
            <div className="panel-head">
              <div>
                <p className="eyebrow">Database records</p>
                <h2>Recent attendance</h2>
              </div>
              <button className="text-button" onClick={() => go("history")}>
                Full history <ChevronRight size={16} />
              </button>
            </div>
            <AttendanceTable records={dashboard.data.records} />
          </section>
        </>
      </DataState>
    </>
  );
}

function SmallEmpty({ label }: { label: string }) {
  return <div className="small-empty">{label}</div>;
}
function ClassRows({ classes }: { classes: DbClass[] }) {
  return (
    <div className="class-list">
      {classes.length ? (
        classes.map((item) => {
          const schedule = item.class_schedules?.[0];
          return (
            <div className="class-row" key={item.id}>
              <span className="class-badge">
                <FileText size={18} />
              </span>
              <span className="class-info">
                <strong>{item.name}</strong>
                <small>
                  {item.code}
                  {item.semester ? ` · ${item.semester}` : ""}
                  {schedule ? ` · ${new Date(schedule.session_date).toLocaleDateString()} ${schedule.start_time.slice(0, 5)} - ${schedule.end_time.slice(0, 5)}` : ""}
                </small>
              </span>
              <span className="active-status">
                <i />
                Active
              </span>
              <ChevronRight size={16} />
            </div>
          );
        })
      ) : (
        <SmallEmpty label="No classes assigned" />
      )}
    </div>
  );
}

export function StudentClasses({ go }: { go: (key: any) => void }) {
  const { role, profile } = useAppStore();
  const result = useLoad([] as DbClass[], () => loadClasses(role, profile.id), [
    role,
    profile.id,
  ]);
  const batches = useLoad(
    [] as any[],
    async () => {
      if (role === "faculty") return loadFacultyBatches(profile.id);
      if (role === "student")
        return rows<any>(
          supabase
            .from("batch_members")
            .select("*")
            .eq("student_id", profile.id)
            .eq("status", "active"),
        );
      return rows<any>(supabase.from("batches").select("*").order("name"));
    },
    [role, profile.id],
  );
  const [query, setQuery] = useState(""),
    [joinToken, setJoinToken] = useState(""),
    [scanningJoin, setScanningJoin] = useState(false),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [classForm, setClassForm] = useState({
    name: "",
    code: "",
    batchId: "",
    department: "",
    sessionDate: new Date().toISOString().split('T')[0],
    startTime: "09:00",
    endTime: "10:00",
  });
  const filtered = result.data.filter((item) =>
    `${item.name} ${item.code}`.toLowerCase().includes(query.toLowerCase()),
  );
  const join = async (value = joinToken) => {
    if (!value) return;
    setBusy(true);
    setMessage("");
    const { error } = await supabase.functions.invoke("join-batch", {
      body: { token: extractJoinToken(value) },
    });
    if (error) {
      setMessage(error.message);
    } else {
      setMessage("Batch joined. Published classes are now available.");
      setJoinToken("");
      batches.reload();
      result.reload();
    }
    setBusy(false);
  };
  const createClass = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const { data: newClass, error } = await supabase
      .from("classes")
      .insert({
        name: classForm.name.trim(),
        code: classForm.code.trim().toUpperCase(),
        batch_id: classForm.batchId,
        department: classForm.department.trim(),
        faculty_id: profile.id,
        created_by: profile.id,
        publication_status: "draft",
      })
      .select()
      .single();
    if (error) setMessage(error.message);
    else {
      if (classForm.sessionDate && classForm.startTime && classForm.endTime) {
        await supabase.from("class_schedules").insert({
          class_id: newClass.id,
          schedule_type: "one_off",
          session_date: classForm.sessionDate,
          start_time: classForm.startTime,
          end_time: classForm.endTime,
          room: "TBA",
        });
      }
      setMessage("Draft class & schedule created. Publish it when ready.");
      setClassForm({
        name: "",
        code: "",
        batchId: classForm.batchId,
        department: "",
        sessionDate: new Date().toISOString().split('T')[0],
        startTime: "09:00",
        endTime: "10:00",
      });
      result.reload();
    }
    setBusy(false);
  };
  const publish = async (item: DbClass) => {
    setBusy(true);
    const { error } = await supabase
      .from("classes")
      .update({
        publication_status: "published",
        published_by: profile.id,
        published_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    setMessage(
      error ? error.message : "Class published to all active batch students.",
    );
    setBusy(false);
    result.reload();
  };
  const facultyBatches = batches.data.map((item) => item.batches || item).filter(Boolean);
  return (
    <>
      <PageHeader
        eyebrow="Academic structure"
        title={
          role === "student"
            ? "My classes"
            : role === "faculty"
              ? "Create and publish classes"
              : "All classes"
        }
        description="Published classes are synchronized to active students in the selected batch."
      />
      {message && (
        <div
          className={
            message.toLowerCase().includes("error")
              ? "inline-error"
              : "session-banner"
          }
        >
          {message}
        </div>
      )}
      {role === "student" && (
        <section className="panel join-batch-panel">
          <div>
            <p className="eyebrow">Batch enrollment</p>
            <h2>Join a classroom batch</h2>
            <p>
              Scan the QR shown by your faculty member. Published classes appear
              automatically.
            </p>
          </div>
          <div className="join-controls">
            <input
              className="text-input"
              value={joinToken}
              onChange={(event) => setJoinToken(event.target.value)}
              placeholder="Join code"
            />
            <Button variant="secondary" onClick={() => setScanningJoin(true)}>
              <ScanLine size={17} />
              Scan QR
            </Button>
            <Button onClick={() => join()} disabled={!joinToken || busy}>
              Join batch
            </Button>
          </div>
        </section>
      )}
      {role === "faculty" && (
        <div className="faculty-class-tools">
          <form className="panel class-create-form" onSubmit={createClass}>
            <div className="panel-head">
              <div>
                <p className="eyebrow">New class</p>
                <h2>Create a draft class</h2>
              </div>
            </div>
            <div className="form-body">
              <label className="field-label">
                Batch
                <select
                  className="text-input"
                  value={classForm.batchId}
                  onChange={(event) => {
                    const batchId = event.target.value;
                    const selectedBatch = facultyBatches.find(b => b.id === batchId);
                    setClassForm((value) => ({
                      ...value,
                      batchId,
                      code: selectedBatch ? selectedBatch.code : value.code,
                    }));
                  }}
                  required
                >
                  <option value="">Select assigned batch</option>
                  {facultyBatches.map((batch) => (
                    <option key={batch.id} value={batch.id}>
                      {batch.code} · {batch.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Class / subject name
                <input
                  className="text-input"
                  value={classForm.name}
                  onChange={(event) =>
                    setClassForm((value) => ({
                      ...value,
                      name: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <label className="field-label">
                Class code
                <input
                  className="text-input"
                  value={classForm.code}
                  onChange={(event) =>
                    setClassForm((value) => ({
                      ...value,
                      code: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <label className="field-label">
                Department
                <input
                  className="text-input"
                  value={classForm.department}
                  onChange={(event) =>
                    setClassForm((value) => ({
                      ...value,
                      department: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <label className="field-label">
                Session Date
                <input
                  type="date"
                  className="text-input"
                  value={classForm.sessionDate}
                  onChange={(event) =>
                    setClassForm((value) => ({
                      ...value,
                      sessionDate: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <div className="year-fields">
                <label className="field-label">
                  Start Time
                  <input
                    type="time"
                    className="text-input"
                    value={classForm.startTime}
                    onChange={(event) =>
                      setClassForm((value) => ({
                        ...value,
                        startTime: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label className="field-label">
                  End Time
                  <input
                    type="time"
                    className="text-input"
                    value={classForm.endTime}
                    onChange={(event) =>
                      setClassForm((value) => ({
                        ...value,
                        endTime: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
              </div>
              <Button disabled={busy || !facultyBatches.length}>
                <Plus size={17} />
                Create draft
              </Button>
            </div>
          </form>
          <BatchQrPanel batches={facultyBatches} onChanged={batches.reload} />
        </div>
      )}
      <div className="filter-row">
        <div className="search-input search-wide">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search classes"
          />
        </div>
      </div>
      <DataState
        loading={result.loading || batches.loading}
        error={result.error || batches.error}
        empty={!filtered.length}
      >
        <div className="class-grid">
          {filtered.map((item) => (
            <article className="class-card" key={item.id}>
              <div className="class-card-top">
                <span className="class-badge">
                  <BookOpen size={18} />
                </span>
                <span className="class-card-code">{item.code}</span>
              </div>
              <div className="class-card-body">
                <h2>{item.name}</h2>
                <p>{item.department || "Department not set"}</p>
                {item.class_schedules?.[0] && (
                  <p style={{ fontSize: "12px", marginTop: "4px", marginBottom: "8px", color: "var(--muted)" }}>
                    {new Date(item.class_schedules[0].session_date).toLocaleDateString()} · {item.class_schedules[0].start_time.substring(0, 5)} - {item.class_schedules[0].end_time.substring(0, 5)}
                  </p>
                )}
                <span
                  className={`status ${item.publication_status === "published" ? "status-present" : "status-pending_review"}`}
                >
                  {item.publication_status || "draft"}
                </span>
                <div className="class-card-foot">
                  <span>
                    {item.publication_status === "published"
                      ? `Published ${formatDate(item.published_at)}`
                      : "Not visible to students"}
                  </span>
                  {role === "faculty" &&
                  item.publication_status !== "published" ? (
                    <button
                      className="text-button"
                      onClick={() => publish(item)}
                      disabled={busy}
                    >
                      Publish <Upload size={14} />
                    </button>
                  ) : role === "faculty" ? (
                    <button
                      className="text-button"
                      onClick={() => go("session")}
                    >
                      Start session <ArrowRight size={14} />
                    </button>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      </DataState>
      {scanningJoin && (
        <QrScannerModal
          title="Scan batch join QR"
          onClose={() => setScanningJoin(false)}
          onResult={(value) => {
            setScanningJoin(false);
            setJoinToken(extractJoinToken(value));
            void join(value);
          }}
        />
      )}
    </>
  );
}

function BatchQrPanel({
  batches,
  onChanged,
}: {
  batches: any[];
  onChanged?: () => void;
}) {
  const { profile } = useAppStore();
  const [batchId, setBatchId] = useState(""),
    [qr, setQr] = useState<any>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [expiresInMinutes, setExpiresInMinutes] = useState("30"),
    [showCreate, setShowCreate] = useState(false);
  const [batchForm, setBatchForm] = useState({
    name: "",
    code: "",
    department: "",
    startYear: String(new Date().getFullYear()),
    endYear: String(new Date().getFullYear() + 3),
  });
  useEffect(() => {
    if (!batchId && batches[0]) setBatchId(batches[0].id);
  }, [batches, batchId]);
  const generate = async () => {
    if (!batchId) return;
    setLoading(true);
    setError("");
    const { data, error } = await supabase.functions.invoke(
      "generate-join-qr",
      {
        body: {
          batchId,
          purpose: "batch_join",
          maxUses: 500,
          expiresInMinutes: Number(expiresInMinutes),
        },
      },
    );
    if (error) setError(error.message);
    else setQr(data);
    setLoading(false);
  };
  const createBatch = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    const { data, error } = await supabase
      .from("batches")
      .insert({
        name: batchForm.name.trim(),
        code: batchForm.code.trim().toUpperCase(),
        department: batchForm.department.trim(),
        start_year: Number(batchForm.startYear),
        end_year: Number(batchForm.endYear),
        created_by: profile.id,
      })
      .select()
      .single();
    if (error) setError(error.message);
    else {
      setBatchId(data.id);
      setShowCreate(false);
      onChanged?.();
    }
    setLoading(false);
  };
  return (
    <section className="panel batch-qr-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Batch pairing</p>
          <h2>Student join QR</h2>
        </div>
        <button
          className="text-button"
          onClick={() => setShowCreate((value) => !value)}
        >
          {showCreate ? "Cancel" : "Create batch"}
        </button>
      </div>
      <div className="form-body">
        {showCreate ? (
          <form className="compact-form" onSubmit={createBatch}>
            <label className="field-label">
              Batch name
              <input
                className="text-input"
                value={batchForm.name}
                onChange={(event) =>
                  setBatchForm((value) => ({
                    ...value,
                    name: event.target.value,
                  }))
                }
                placeholder="Computer Science 2024-2027"
                required
              />
            </label>
            <label className="field-label">
              Batch code
              <input
                className="text-input"
                value={batchForm.code}
                onChange={(event) =>
                  setBatchForm((value) => ({
                    ...value,
                    code: event.target.value,
                  }))
                }
                placeholder="CS-2024-27"
                required
              />
            </label>
            <label className="field-label">
              Department
              <input
                className="text-input"
                value={batchForm.department}
                onChange={(event) =>
                  setBatchForm((value) => ({
                    ...value,
                    department: event.target.value,
                  }))
                }
                required
              />
            </label>
            <div className="year-fields">
              <label className="field-label">
                Start year
                <input
                  type="number"
                  className="text-input"
                  value={batchForm.startYear}
                  onChange={(event) =>
                    setBatchForm((value) => ({
                      ...value,
                      startYear: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="field-label">
                End year
                <input
                  type="number"
                  className="text-input"
                  value={batchForm.endYear}
                  onChange={(event) =>
                    setBatchForm((value) => ({
                      ...value,
                      endYear: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
            <Button disabled={loading}>
              <Plus size={17} />
              Create batch
            </Button>
          </form>
        ) : (
          <>
            <label className="field-label">
              Batch
              <select
                className="text-input"
                value={batchId}
                onChange={(event) => {
                  setBatchId(event.target.value);
                  setQr(null);
                }}
              >
                <option value="">Select batch</option>
                {batches.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batch.code} · {batch.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              QR Expiry (Minutes)
              <input
                className="text-input"
                type="number"
                min="5"
                value={expiresInMinutes}
                onChange={(e) => setExpiresInMinutes(e.target.value)}
              />
            </label>
            {qr ? (
              <div className="join-qr">
                <QRCodeSVG
                  id="batch-join-qr"
                  value={qr.qrPayload}
                  size={190}
                  level="H"
                  includeMargin
                />
                <div className="qr-meta mt-2 flex flex-col gap-2">
                  <strong>Expires {formatDate(qr.expiresAt)}</strong>
                  <small>Students scan this from My Classes.</small>
                  <Button variant="secondary" onClick={() => {
                    const svg = document.getElementById('batch-join-qr');
                    if (!svg) return;
                    const svgData = new XMLSerializer().serializeToString(svg);
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    const img = new Image();
                    img.onload = () => {
                      canvas.width = img.width;
                      canvas.height = img.height;
                      ctx?.drawImage(img, 0, 0);
                      canvas.toBlob(blob => {
                        if (!blob) return;
                        const file = new File([blob], 'join-qr.png', { type: 'image/png' });
                        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                          navigator.share({
                            files: [file],
                            title: 'Batch Join QR Code',
                            text: 'Scan to join the batch',
                          }).catch(console.error);
                        } else {
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = 'join-qr.png';
                          a.click();
                          URL.revokeObjectURL(url);
                        }
                      });
                    };
                    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
                  }}>
                    <Share2 size={16} /> Share QR
                  </Button>
                </div>
              </div>
            ) : (
              <Button onClick={generate} disabled={!batchId || loading}>
                {loading && <LoaderCircle className="spin" size={17} />}Generate
                join QR
              </Button>
            )}
          </>
        )}
        {error && <div className="inline-error">{error}</div>}
      </div>
    </section>
  );
}

export function HistoryView({ role }: { role: Role }) {
  const { profile } = useAppStore();
  const [filters, setFilters] = useState({ date: "", month: "", classId: "" });
  
  const result = useLoad(
    [] as DbRecord[],
    () => loadAttendance(role, profile.id, 100, filters),
    [role, profile.id, filters.date, filters.month, filters.classId],
  );

  const classes = useLoad(
    [] as DbClass[],
    () => loadClasses(role, profile.id),
    [role, profile.id]
  );
  return (
    <>
      <PageHeader
        eyebrow="Verified records"
        title="Attendance records"
        description="Every row is read from the AttendX database and retains its evidence and review status."
        action={
          <Button
            variant="secondary"
            onClick={() => exportRecords(result.data)}
            disabled={!result.data.length}
          >
            <Download size={17} />
            Export CSV
          </Button>
        }
      />
      <section className="panel" style={{ padding: '1rem', display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end', background: 'var(--surface-color)' }}>
        <label className="field-label" style={{ marginBottom: 0 }}>
          Date
          <input
            type="date"
            className="text-input"
            value={filters.date}
            onChange={(e) => setFilters(prev => ({ ...prev, date: e.target.value, month: "" }))}
          />
        </label>
        <label className="field-label" style={{ marginBottom: 0 }}>
          Month
          <input
            type="month"
            className="text-input"
            value={filters.month}
            onChange={(e) => setFilters(prev => ({ ...prev, month: e.target.value, date: "" }))}
          />
        </label>
        <label className="field-label" style={{ marginBottom: 0, minWidth: '200px' }}>
          Class
          <select
            className="text-input"
            value={filters.classId}
            onChange={(e) => setFilters(prev => ({ ...prev, classId: e.target.value }))}
          >
            <option value="">All Classes</option>
            {classes.data.map(cls => (
              <option key={cls.id} value={cls.id}>{cls.name} ({cls.code})</option>
            ))}
          </select>
        </label>
        {(filters.date || filters.month || filters.classId) && (
          <button className="text-button" onClick={() => setFilters({ date: "", month: "", classId: "" })}>
            Clear filters
          </button>
        )}
      </section>
      <section className="panel table-panel">
        <DataState
          loading={result.loading}
          error={result.error}
          empty={!result.data.length}
        >
          <AttendanceTable records={result.data} />
        </DataState>
      </section>
    </>
  );
}

function exportRecords(records: DbRecord[]) {
  const csv = [
    "id,status,marked_at,distance_m,accuracy_m",
    ...records.map((record) =>
      [
        record.id,
        record.status,
        record.marked_at,
        record.distance_from_center_m ?? "",
        record.gps_accuracy_m ?? "",
      ].join(","),
    ),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "attendance.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AttendanceTable({ records }: { records: DbRecord[] }) {
  if (!records.length) return <SmallEmpty label="No attendance records" />;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Class</th>
            <th>Student</th>
            <th>Marked at</th>
            <th>Location</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const session = record.attendance_sessions;
            return (
              <tr key={record.id}>
                <td>
                  <div className="table-class">
                    <span className="mini-class-icon">
                      <FileText size={15} />
                    </span>
                    <span>
                      <strong>{session?.classes?.name || "Class"}</strong>
                      <small>{session?.classes?.code || ""}</small>
                    </span>
                  </div>
                </td>
                <td>
                  <strong>{record.profiles?.full_name || "Own record"}</strong>
                  <small>{record.profiles?.identifier || ""}</small>
                </td>
                <td>
                  <strong>{formatDate(record.marked_at)}</strong>
                </td>
                <td>
                  <span className="location-cell">
                    <MapPin size={14} />
                    {record.distance_from_center_m != null
                      ? `${Math.round(record.distance_from_center_m)} m`
                      : "--"}
                    <small>
                      {record.gps_accuracy_m != null
                        ? `±${Math.round(record.gps_accuracy_m)} m`
                        : ""}
                    </small>
                  </span>
                </td>
                <td>
                  <StatusPill status={record.status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type CapturedPhoto = LivePhoto;
type CaptureStep =
  "scan" | "location" | "selfie" | "classroom" | "review" | "done";
export function MarkAttendance({ go }: { go: (key: any) => void }) {
  const [step, setStep] = useState<CaptureStep>("scan"),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const [location, setLocation] = useState<any>(null),
    [selfie, setSelfie] = useState<CapturedPhoto | null>(null),
    [classroom, setClassroom] = useState<CapturedPhoto | null>(null),
    [cameraKind, setCameraKind] = useState<"selfie" | "classroom" | null>(null),
    [scanning, setScanning] = useState(false),
    [verdict, setVerdict] = useState<any>(null);
  const [integrity, setIntegrity] = useState<any>(null);
  useEffect(() => {
    checkDeviceIntegrity().then(setIntegrity);
  }, []);
  const acceptToken = (value: string) => {
    const raw = value.trim();
    
    // Strip URL prefixes if present
    let token = raw;
    if (raw.startsWith('http')) {
      try {
        const url = new URL(raw);
        // Check if token is in query param
        const urlToken = url.searchParams.get('token');
        if (urlToken) {
          token = urlToken;
        } else {
          // Try to get from path
          const pathParts = url.pathname.split('/').filter(Boolean);
          const last = pathParts[pathParts.length - 1];
          if (last) token = last;
        }
      } catch {
        // If URL parsing fails, use raw value
      }
    }
    
    const parts = token.split(".");
    if (parts.length !== 3) {
      setError("Invalid QR code format. Please scan a live attendance QR code.");
      setScanning(false);
      return;
    }
    try {
      const headerRaw = parts[0].replace(/-/g, "+").replace(/_/g, "/");
      const header = JSON.parse(atob(headerRaw));
      if (header.typ !== "ATXQR") throw new Error();
    } catch {
      setError("Unrecognized QR code type. Please scan a live attendance QR code.");
      setScanning(false);
      return;
    }
    setToken(token);
    setScanning(false);
    setStep("location");
  };
  const scan = async () => {
    setError("");
    if (!Capacitor.isNativePlatform()) {
      setScanning(true);
      return;
    }
    try {
      const permission = await BarcodeScanner.requestPermissions();
      if (permission.camera !== "granted")
        throw new Error("Camera permission denied");
      const result = await BarcodeScanner.scan();
      const value = result.barcodes[0]?.rawValue;
      if (!value) throw new Error("No QR code detected");
      acceptToken(value);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Scan failed");
    }
  };
  // Pre-warm GPS as soon as scan step renders so a fix is cached by the time user needs it
  useEffect(() => {
    Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }).catch(() => {});
  }, []);

  const locate = async () => {
    setError("");
    if (integrity?.developerMode || integrity?.mockLocation) {
      setError("Developer options or mock location is active.");
      return;
    }
    try {
      let perm = await Geolocation.checkPermissions();
      if (perm.location !== "granted") {
        perm = await Geolocation.requestPermissions();
      }
      if (perm.location !== "granted") {
        throw new Error("Location permission denied. Please allow location access in your browser or device settings.");
      }

      // Fast approach: try with very short timeout first, then fallback
      let result: any = null;
      try {
        result = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 3000,
          maximumAge: 5000,
        });
      } catch {
        // Quick timeout failed — try with longer timeout
        result = await Geolocation.getCurrentPosition({
          enableHighAccuracy: false,
          timeout: 8000,
          maximumAge: 15000,
        });
      }
      setLocation({
        latitude: result.coords.latitude,
        longitude: result.coords.longitude,
        accuracy: result.coords.accuracy,
      });
      setStep("selfie");
    } catch (error) {
      setError(`Could not obtain location: ${error instanceof Error ? error.message : 'Unknown error'}. Please ensure GPS is enabled.`);
    }
  };
  const captureNative = async (kind: "selfie" | "classroom") => {
    try {
      const photo = await captureNativePhoto(
        kind === "selfie" ? "user" : "environment",
      );
      if (!photo) {
        setCameraKind(kind);
        return;
      }
      kind === "selfie" ? setSelfie(photo) : setClassroom(photo);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Camera capture failed",
      );
    }
  };
  const submit = async () => {
    if (!location || !selfie || !classroom) return;
    setSubmitting(true);
    setError("");
    let deviceId = localStorage.getItem("attendx-device-id");
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem("attendx-device-id", deviceId);
    }
    const { data, error } = await supabase.functions.invoke(
      "submit-attendance",
      {
        body: {
          token,
          location,
          selfieDataUrl: selfie.dataUrl,
          selfieCapturedAt: selfie.capturedAt,
          classroomDataUrl: classroom.dataUrl,
          classroomCapturedAt: classroom.capturedAt,
          device: {
            uuid: deviceId,
            platform: Capacitor.getPlatform(),
            integrity,
          },
        },
      },
    );
    if (error) setError(error.message);
    else {
      setVerdict(data?.verdict);
      setStep("done");
    }
    setSubmitting(false);
  };
  return (
    <div className="capture-page">
      <button className="back-link" onClick={() => go("home")}>
        <ArrowLeft size={17} />
        Back
      </button>
      <PageHeader
        eyebrow="Live attendance"
        title="Verify your presence"
        description="QR, GPS, selfie, and classroom evidence are validated by the server."
      />
      <div className="capture-layout">
        <div className="capture-main">
          {error && (
            <div className="inline-error">
              <AlertTriangle size={17} />
              {error}
            </div>
          )}
          {step === "scan" && (
            <div className="capture-card centered-card">
              <div className="capture-icon">
                <ScanLine size={30} />
              </div>
              <h2>Scan the faculty QR</h2>
              <p>
                Use the live camera on Android or web. The code is validated by
                the server.
              </p>
              <Button onClick={scan}>
                <QrCode size={17} />
                Open QR scanner
              </Button>
            </div>
          )}
          {step === "location" && (
            <div className="capture-card centered-card">
              <div className="capture-icon">
                <LocateFixed size={30} />
              </div>
              <h2>Capture precise location</h2>
              <p>A new high-accuracy reading is required.</p>
              <Button onClick={locate}>
                <LocateFixed size={17} />
                Get live location
              </Button>
            </div>
          )}
          {step === "selfie" && (
            <PhotoCaptureStep
              title="Take a live selfie"
              photo={selfie}
              onCapture={() => captureNative("selfie")}
              onContinue={() => setStep("classroom")}
            />
          )}{" "}
          {step === "classroom" && (
            <PhotoCaptureStep
              title="Capture the classroom"
              photo={classroom}
              onCapture={() => captureNative("classroom")}
              onContinue={() => setStep("review")}
            />
          )}{" "}
          {step === "review" && (
            <div className="capture-card review-card">
              <h2>Submit captured evidence</h2>
              <div className="evidence-grid">
                <img src={selfie?.dataUrl} />
                <img src={classroom?.dataUrl} />
              </div>
              <div className="review-facts">
                <div>
                  <LocateFixed size={16} />
                  <span>
                    <strong>GPS accuracy</strong>
                    <small>{Math.round(location?.accuracy)} m</small>
                  </span>
                </div>
                <div>
                  <Clock3 size={16} />
                  <span>
                    <strong>Live captures</strong>
                    <small>Server will verify capture-to-upload delay</small>
                  </span>
                </div>
              </div>
              <Button
                className="full-button"
                onClick={submit}
                disabled={submitting}
              >
                {submitting && <LoaderCircle className="spin" size={17} />}
                Submit attendance
              </Button>
            </div>
          )}
          {step === "done" && (
            <div className="success-card">
              <div className="success-mark">
                <Check size={30} />
              </div>
              <h2>Server verdict: {verdict?.status || "received"}</h2>
              <p>
                {verdict?.reason ||
                  "Your attendance evidence has been processed."}
              </p>
              <Button variant="secondary" onClick={() => go("history")}>
                View record
              </Button>
            </div>
          )}
        </div>
        <aside className="capture-aside">
          <div className="trust-list">
            <p className="eyebrow">Captured signals</p>
            <Trust label="Signed QR" done={Boolean(token)} />
            <Trust label="Precise GPS" done={Boolean(location)} />
            <Trust label="Live selfie" done={Boolean(selfie)} />
            <Trust label="Classroom photo" done={Boolean(classroom)} />
          </div>
        </aside>
      </div>
      {cameraKind && (
        <CameraCaptureModal
          facing={cameraKind === "selfie" ? "user" : "environment"}
          title={
            cameraKind === "selfie"
              ? "Capture live selfie"
              : "Capture classroom"
          }
          onClose={() => setCameraKind(null)}
          onCapture={(photo) => {
            cameraKind === "selfie" ? setSelfie(photo) : setClassroom(photo);
            setCameraKind(null);
          }}
        />
      )}{" "}
      {scanning && (
        <QrScannerModal
          title="Scan attendance QR"
          onClose={() => setScanning(false)}
          onResult={acceptToken}
        />
      )}
    </div>
  );
}

function PhotoCaptureStep({
  title,
  photo,
  onCapture,
  onContinue,
}: {
  title: string;
  photo: CapturedPhoto | null;
  onCapture: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="capture-card centered-card">
      <div className="photo-frame">
        {photo ? <img src={photo.dataUrl} /> : <Camera size={34} />}
      </div>
      <h2>{title}</h2>
      <p>
        Only a live camera capture is accepted. Gallery selection is not
        available.
      </p>
      <Button variant="secondary" onClick={onCapture}>
        <Camera size={17} />
        {photo ? "Retake" : "Open camera"}
      </Button>
      {photo && (
        <Button className="full-button" onClick={onContinue}>
          Continue <ArrowRight size={17} />
        </Button>
      )}
    </div>
  );
}
function Trust({ label, done }: { label: string; done: boolean }) {
  return (
    <div className="trust-item">
      <span className={`trust-icon ${done ? "trust-complete" : ""}`}>
        {done ? <Check size={15} /> : <Clock3 size={15} />}
      </span>
      <span>{label}</span>
      <small>{done ? "Captured" : "Waiting"}</small>
    </div>
  );
}

export function FacultyDashboard({ go }: { go: (key: any) => void }) {
  const { profile } = useAppStore();
  const result = useLoad(
    {
      classes: [] as DbClass[],
      sessions: [] as any[],
      records: [] as DbRecord[],
      students: 0,
      batches: [] as any[],
    },
    async () => {
      const classes = await loadClasses("faculty", profile.id),
        ids = classes.map((item) => item.id);
      const sessions = ids.length
        ? await rows<any>(
            supabase
              .from("attendance_sessions")
              .select("*")
              .in("class_id", ids)
              .order("started_at", { ascending: false })
              .limit(10),
          )
        : [];
      const records = await loadAttendance("faculty", profile.id, 10);
      const enrollments = ids.length
        ? await rows<any>(
            supabase
              .from("enrollments")
              .select("student_id")
              .in("class_id", ids)
              .eq("status", "active"),
          )
        : [];
      const batches = await loadFacultyBatches(profile.id);
      return {
        classes,
        sessions,
        records,
        students: new Set(enrollments.map((item) => item.student_id)).size,
        batches,
      };
    },
    [profile.id],
  );
  const active = result.data.sessions.filter(
    (item) => item.status === "active",
  );
  const flagged = result.data.records.filter((item) =>
    ["flagged", "pending_review"].includes(item.status),
  );
  return (
    <>
      <PageHeader
        eyebrow="Faculty workspace"
        title={`Hello, ${profile.full_name.split(" ")[0] || "Faculty"}`}
        description="Live values for your assigned classes and students."
        action={
          <div className="page-actions">
            <Button variant="secondary" onClick={() => go("classes")}>
              <Plus size={17} />
              Create class
            </Button>
            <Button variant="secondary" onClick={() => go("mail")}>
              <Inbox size={17} />
              Mail Center
            </Button>
            <Button onClick={() => go("session")}>
              <QrCode size={18} />
              Start session
            </Button>
          </div>
        }
      />
      <DataState loading={result.loading} error={result.error} empty={false}>
        <>
          <section className="metric-grid">
            <Metric
              label="Assigned classes"
              value={String(result.data.classes.length)}
              note="Active teaching assignments"
              icon={BookOpen}
            />
            <Metric
              label="Unique students"
              value={String(result.data.students)}
              note="Across your classes"
              icon={UsersRound}
              tone="blue"
            />
            <Metric
              label="Active sessions"
              value={String(active.length)}
              note="Open right now"
              icon={Activity}
              tone="amber"
            />
            <Metric
              label="Needs review"
              value={String(flagged.length)}
              note="Flagged submissions"
              icon={ShieldAlert}
              tone="rose"
            />
          </section>
          <div className="dashboard-grid">
            <section className="panel">
              <div className="panel-head">
                <h2>Assigned classes</h2>
                <button className="text-button" onClick={() => go("classes")}>
                  View all
                </button>
              </div>
              <ClassRows classes={result.data.classes} />
            </section>
            <section className="panel">
              <div className="panel-head">
                <h2>Active sessions</h2>
              </div>
              {active.length ? (
                active.map((item) => (
                  <div className="review-row" key={item.id}>
                    <span className="review-icon review-blue">
                      <Activity size={17} />
                    </span>
                    <span>
                      <strong>{item.classes?.name}</strong>
                      <small>Started {formatDate(item.started_at)}</small>
                    </span>
                  </div>
                ))
              ) : (
                <SmallEmpty label="No live sessions" />
              )}
            </section>
          </div>
          <div className="dashboard-grid">
            <BatchQrPanel
              batches={result.data.batches}
              onChanged={result.reload}
            />
            <section className="panel quick-publish">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">Class publishing</p>
                  <h2>Publish to your batch</h2>
                </div>
              </div>
              <div className="empty-live">
                <BookOpen size={28} />
                <strong>Create subjects for assigned batches</strong>
                <p>
                  Draft classes stay private until you publish them. Publishing
                  enrolls every active batch student.
                </p>
                <Button onClick={() => go("classes")}>
                  Create or publish class
                </Button>
              </div>
            </section>
          </div>
          <section className="panel recent-panel">
            <div className="panel-head">
              <h2>Recent submissions</h2>
            </div>
            <AttendanceTable records={result.data.records} />
          </section>
        </>
      </DataState>
    </>
  );
}

export function FacultySession() {
  const { profile } = useAppStore();
  const classes = useLoad(
    [] as DbClass[],
    () => loadClasses("faculty", profile.id),
    [profile.id],
  );
  const [classId, setClassId] = useState(""),
    [qrRefreshIntervalS, setQrRefreshIntervalS] = useState("15"),
    [session, setSession] = useState<any>(null),
    [token, setToken] = useState(""),
    [expiresAt, setExpiresAt] = useState(""),
    [records, setRecords] = useState<DbRecord[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!classId && classes.data[0]) setClassId(classes.data[0].id);
  }, [classes.data, classId]);
  const issueQr = async (sessionId: string) => {
    if (!supabase) return;
    const { data, error } = await supabase.functions.invoke("issue-qr", {
      body: { sessionId },
    });
    if (error) {
      setError(error.message);
    } else {
      setToken(data.token);
      setExpiresAt(data.expiresAt);
    }
  };
  useEffect(() => {
    if (!session) return;
    void issueQr(session.id);
    const id = window.setInterval(
      () => void issueQr(session.id),
      Math.max(5, session.qr_refresh_interval_s || session.refresh_interval_s || 15) * 1000,
    );
    // Local API has no realtime channels — poll the roster instead.
    const rosterId = window.setInterval(
      () => void refreshRoster(session.id),
      5000,
    );
    void refreshRoster(session.id);
    return () => {
      clearInterval(id);
      clearInterval(rosterId);
    };
  }, [session?.id]);
  const refreshRoster = async (sessionId: string) => {
    try {
      const all = await rows<DbRecord>(
        supabase
          .from("attendance_records")
          .select("*")
          .eq("session_id", sessionId)
          .order("marked_at"),
      );
      setRecords(all.filter((r) => r.session_id === sessionId));
    } catch {}
  };
  const start = async () => {
    if (!classId) return;
    setLoading(true);
    setError("");
    try {
      let perm = await Geolocation.checkPermissions();
      if (perm.location !== "granted") {
        perm = await Geolocation.requestPermissions();
      }
      if (perm.location !== "granted") {
        throw new Error("Location permission denied. Please allow location access in your browser or device settings.");
      }

      // Fast race: try quick high-accuracy first, then fallback
      let position: any = null;
      try {
        position = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 4000,
          maximumAge: 10000,
        });
      } catch {
        position = await Geolocation.getCurrentPosition({
          enableHighAccuracy: false,
          timeout: 6000,
          maximumAge: 15000,
        });
      }

      const selectedClass = classes.data.find((item) => item.id === classId);
      const schedule = selectedClass?.class_schedules?.[0];
      let scheduledEndAt = undefined;
      let scheduleId = undefined;
      if (schedule && schedule.session_date && schedule.end_time) {
         const d = new Date(`${schedule.session_date}T${schedule.end_time}`);
         if (!isNaN(d.getTime())) {
           scheduledEndAt = d.toISOString();
           scheduleId = schedule.id;
         }
      }

      const { data, error } = await supabase.functions.invoke("start-session", {
        body: {
          classId,
          scheduleId,
          scheduledEndAt,
          refreshIntervalSeconds: Number(qrRefreshIntervalS),
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        },
      });
      if (error) throw error;
      setSession(data.session);
      await refreshRoster(data.session.id);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not start session",
      );
    }
    setLoading(false);
  };
  const end = async () => {
    if (!session) return;
    const { error } = await supabase
      .from("attendance_sessions")
      .update({ status: "closed", ended_at: new Date().toISOString() })
      .eq("id", session.id);
    if (error) setError(error.message);
    else {
      setSession(null);
      setToken("");
      setRecords([]);
    }
  };
  const selected = classes.data.find((item) => item.id === classId);
  return (
    <>
      <PageHeader
        eyebrow="Faculty session"
        title={session ? selected?.name || "Live session" : "Start attendance"}
        description="QR tokens are generated and signed by the AttendX server."
        action={
          session ? (
            <Button variant="danger" onClick={end}>
              <X size={17} />
              End session
            </Button>
          ) : undefined
        }
      />
      {error && (
        <div className="inline-error">
          <AlertTriangle size={17} />
          {error}
        </div>
      )}
      <DataState
        loading={classes.loading}
        error={classes.error}
        empty={!classes.data.length}
      >
        {!session ? (
          <section className="panel session-start-card">
            <label className="field-label">
              Class
              <select
                className="text-input"
                value={classId}
                onChange={(event) => setClassId(event.target.value)}
              >
                {classes.data.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              QR Refresh Interval (Seconds)
              <input
                className="text-input"
                type="number"
                min="5"
                value={qrRefreshIntervalS}
                onChange={(e) => setQrRefreshIntervalS(e.target.value)}
              />
            </label>
            <Button onClick={start} disabled={loading}>
              {loading && <LoaderCircle className="spin" size={17} />}Capture
              location and start
            </Button>
          </section>
        ) : (
          <div className="session-layout">
            <section className="qr-panel panel">
              <div className="session-live-head">
                <span className="live-dot-label">
                  <i />
                  Session live
                </span>
                <span>{formatDate(session.started_at)}</span>
              </div>
              <div className="qr-stage">
                {token ? (
                  <div className="qr-surface">
                    <QRCodeSVG
                      id="faculty-session-qr"
                      value={token}
                      size={240}
                      includeMargin
                    />
                    <div className="qr-meta mt-2 flex flex-col gap-2">
                      <div className="text-sm font-medium">Valid until: {new Date(expiresAt).toLocaleTimeString()}</div>
                      <Button variant="secondary" onClick={() => {
                        const svg = document.getElementById('faculty-session-qr');
                        if (!svg) return;
                        const svgData = new XMLSerializer().serializeToString(svg);
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        const img = new Image();
                        img.onload = () => {
                          canvas.width = img.width;
                          canvas.height = img.height;
                          ctx?.drawImage(img, 0, 0);
                          canvas.toBlob(blob => {
                            if (!blob) return;
                            const file = new File([blob], 'attendance-qr.png', { type: 'image/png' });
                            if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                              navigator.share({
                                files: [file],
                                title: 'Attendance QR Code',
                                text: 'Scan to mark attendance',
                              }).catch(console.error);
                            } else {
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = 'attendance-qr.png';
                              a.click();
                              URL.revokeObjectURL(url);
                            }
                          });
                        };
                        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
                      }}>
                        <Share2 size={16} /> Share QR
                      </Button>
                    </div>
                  </div>
                ) : (
                  <LoaderCircle className="spin" />
                )}
                <div className="qr-refresh">
                  <RefreshCw size={15} />
                  Expires {formatDate(expiresAt)}
                </div>
              </div>
              <div className="qr-footer">
                <div>
                  <strong>{records.length}</strong>
                  <span>Submitted</span>
                </div>
                <div>
                  <strong className="green-text">
                    {records.filter((item) => item.status === "present").length}
                  </strong>
                  <span>Present</span>
                </div>
                <div>
                  <strong className="amber-text">
                    {records.filter((item) => item.status === "flagged").length}
                  </strong>
                  <span>Review</span>
                </div>
              </div>
            </section>
            <section className="panel roster-panel">
              <div className="panel-head">
                <h2>Live submissions</h2>
              </div>
              {records.length ? (
                <div className="roster-list">
                  {records.map((record) => (
                    <div className="roster-row" key={record.id}>
                      <Initials name={record.profiles?.full_name || "?"} />
                      <span>
                        <strong>{record.profiles?.full_name}</strong>
                        <small>{record.profiles?.identifier}</small>
                      </span>
                      <span className="roster-time">
                        {formatDate(record.marked_at)}
                      </span>
                      <StatusPill status={record.status} />
                    </div>
                  ))}
                </div>
              ) : (
                <SmallEmpty label="Waiting for student submissions" />
              )}
            </section>
          </div>
        )}
      </DataState>
    </>
  );
}

function AdminMailCenterSummary({ go }: { go: (key: any) => void }) {
  const [notices, setNotices] = useState<any[]>([]);

  useEffect(() => {
    const token = localStorage.getItem("attendx_auth_token") || "";
    fetch(`${getLocalServerUrl()}/api/notices?status=open`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("offline"))))
      .then((rows) => setNotices(Array.isArray(rows) ? rows.slice(0, 4) : []))
      .catch(() => setNotices([]));
  }, []);

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Mail Center</p>
          <h2>Open requests</h2>
        </div>
        <button className="text-button" onClick={() => go("mail")}>
          Open Mail Center <ArrowRight size={15} />
        </button>
      </div>
      {notices.length ? (
        notices.map((item) => (
          <div className="review-row" key={item.id}>
            <span className="review-icon review-amber">
              <Inbox size={17} />
            </span>
            <span>
              <strong>{item.subject || item.type}</strong>
              <small>
                {item.tracking_id} · {item.sender_name || item.sender_email || "system"}
              </small>
            </span>
            <ChevronRight size={15} />
          </div>
        ))
      ) : (
        <SmallEmpty label="No open requests — all mail handled" />
      )}
    </section>
  );
}

function AdminFacultyApprovals() {
  const result = useLoad([] as any[], () =>
    fetch(`${getLocalServerUrl()}/api/faculty/pending`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('attendx_auth_token') || ''}` },
    }).then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load pending faculty');
      return res.json() as Promise<any[]>;
    }),
  []);
  const [selected, setSelected] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [code, setCode] = useState<any>(null)
  const [emailSent, setEmailSent] = useState(false)
  const [error, setError] = useState("")

  const approve = async () => {
    if (!selected) return
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`${getLocalServerUrl()}/api/faculty/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('attendx_auth_token') || ''}` },
        body: JSON.stringify({ facultyId: selected.id }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error || 'Approval failed')
      setCode(data.code)
      setEmailSent(Boolean(data.emailSent))
      setSelected(null)
      result.reload()
    } catch (err) {
      setError((err as Error).message)
    }
    setLoading(false)
  }

  return (
    <section className="panel batch-qr-panel" style={{ gridColumn: '1 / -1' }}>
      <div className="panel-head">
        <div>
          <p className="eyebrow">Onboarding</p>
          <h2>Faculty Approvals</h2>
        </div>
      </div>
      <div className="form-body">
        {result.loading ? <LoaderCircle className="spin" size={17} /> : null}
        {result.error && <div className="inline-error"><AlertTriangle size={16} />{result.error}</div>}
        {code && (
          <div className="active-qr" style={{ textAlign: 'center', padding: '2rem 1rem' }}>
            <CheckCircle2 size={32} style={{ color: 'var(--green)', margin: '0 auto 1rem' }} />
            <h3>Application Approved</h3>
            <p style={{ color: 'var(--muted)' }}>
              {emailSent ? 'The invitation code was emailed to the faculty member:' : 'Email delivery failed — share this code manually:'}
            </p>
            <div className="qr-value" style={{ fontSize: '1.5rem', margin: '1rem 0', userSelect: 'all', padding: '1rem', background: 'var(--green-pale)', borderRadius: '8px', border: '1px solid var(--line)' }}>{code}</div>
            <Button onClick={() => { setCode(null) }}>Done</Button>
          </div>
        )}
        {!code && result.data.length === 0 && !result.loading && <SmallEmpty label="No pending faculty applications" />}

        {!code && result.data.map(person => (
          <div className="review-row" key={person.id} style={{ cursor: 'pointer', padding: '1rem', border: '1px solid var(--line)', borderRadius: '8px', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }} onClick={() => setSelected(person)}>
             <span className="review-icon review-amber"><Users size={17} /></span>
             <span style={{ flex: 1 }}>
               <strong>{person.full_name}</strong>
               <small style={{ display: 'block' }}>{person.email} · {person.department}</small>
             </span>
             <Button variant="secondary" onClick={(e) => { e.stopPropagation(); setSelected(person) }}>Review</Button>
          </div>
        ))}

        {selected && !code && (
          <div className="review-detail" style={{ padding: '1rem', background: 'var(--surface)', borderRadius: '8px', border: '1px solid var(--line)' }}>
            <h3 style={{ marginBottom: '0.5rem' }}>Review: {selected.full_name}</h3>
            <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>ID: {selected.identifier} | Email: {selected.email} | Dept: {selected.department}</p>
            {error && <div className="login-error"><AlertTriangle size={16}/>{error}</div>}
            <div className="qr-actions" style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
              <Button onClick={approve} disabled={loading}>{loading ? <LoaderCircle className="spin" size={17}/> : 'Approve & Email Code'}</Button>
              <Button variant="secondary" onClick={() => setSelected(null)} disabled={loading}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export function AdminDashboard({ go }: { go: (key: any) => void }) {
  const result = useLoad(
    {
      people: 0,
      active: 0,
      sessions: 0,
      review: [] as DbRecord[],
      recent: [] as DbRecord[],
      resets: [] as any[],
    },
    async () => {
      const [people, active, sessions, review, recent, resets] =
        await Promise.all([
          rows<any>(supabase.from("profiles").select("*")),
          rows<any>(supabase.from("profiles").select("*").eq("is_active", true)),
          rows<any>(supabase.from("attendance_sessions").select("*").eq("status", "active")),
          rows<DbRecord>(
            supabase
              .from("attendance_records")
              .select("*")
              .in("status", ["flagged", "pending_review"])
              .order("marked_at")
              .limit(5),
          ),
          loadAttendance("admin", "", 6),
          rows<any>(supabase.from("admin_password_reset_queue").select("*")),
        ]);
      return {
        people: people.length,
        active: active.length,
        sessions: sessions.length,
        review,
        recent,
        resets,
      };
    },
    [],
  );
  useEffect(() => {
    const poll = window.setInterval(result.reload, 15000);
    return () => window.clearInterval(poll);
  }, [result.reload]);
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Control center"
        description="All counts and queues are live from the AttendX database."
        action={
          <div className="page-actions">
            <Button onClick={() => go("people")}>
              <UsersRound size={17} />
              Manage people
            </Button>
            <Button variant="secondary" onClick={() => go("mail")}>
              <Inbox size={17} />
              Mail Center
            </Button>
            <Button variant="secondary" onClick={() => go("invites")}>
              <KeyRound size={17} />
              Invites
            </Button>
          </div>
        }
      />
      <DataState loading={result.loading} error={result.error} empty={false}>
        <>
          <section className="metric-grid">
            <Metric
              label="People"
              value={String(result.data.people)}
              note={`${result.data.active} active accounts`}
              icon={UsersRound}
            />
            <Metric
              label="Active sessions"
              value={String(result.data.sessions)}
              note="Open now"
              icon={Activity}
              tone="blue"
            />
            <Metric
              label="Review queue"
              value={String(result.data.review.length)}
              note="Loaded unresolved flags"
              icon={ShieldAlert}
              tone="rose"
            />
            <Metric
              label="Password requests"
              value={String(result.data.resets.length)}
              note="Awaiting admin action"
              icon={KeyRound}
              tone="amber"
            />
          </section>
          <div className="dashboard-grid admin-grid">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <p className="eyebrow">Credential support</p>
                  <h2>Password reset requests</h2>
                </div>
                <button className="text-button" onClick={() => go("passwords")}>
                  Open requests <ArrowRight size={15} />
                </button>
              </div>
              {result.data.resets.length ? (
                result.data.resets.slice(0, 4).map((item) => (
                  <div className="review-row" key={item.id}>
                    <span className="review-icon review-amber">
                      <KeyRound size={17} />
                    </span>
                    <span>
                      <strong>{item.full_name}</strong>
                      <small>
                        {item.identifier} · {formatDate(item.requested_at)}
                      </small>
                    </span>
                    <ChevronRight size={15} />
                  </div>
                ))
              ) : (
                <SmallEmpty label="No pending password requests" />
              )}
            </section>
            <section className="panel">
              <div className="panel-head">
                <h2>Integrity queue</h2>
                <button className="text-button" onClick={() => go("review")}>
                  Open queue
                </button>
              </div>
              {result.data.review.length ? (
                result.data.review.map((item) => (
                  <div className="review-row" key={item.id}>
                    <span className="review-icon review-rose">
                      <ShieldAlert size={17} />
                    </span>
                    <span>
                      <strong>{item.profiles?.full_name}</strong>
                      <small>{item.rejection_reason || item.status}</small>
                    </span>
                  </div>
                ))
              ) : (
                <SmallEmpty label="No records need review" />
              )}
            </section>
            <AdminFacultyApprovals />
            <AdminMailCenterSummary go={go} />
          </div>
          <section className="panel recent-panel">
            <div className="panel-head">
              <h2>Recent attendance</h2>
            </div>
            <AttendanceTable records={result.data.recent} />
          </section>
        </>
      </DataState>
    </>
  );
}

export function PasswordRequestsView() {
  const result = useLoad(
    [] as any[],
    () => rows<any>(supabase.from("admin_password_reset_queue").select("*")),
    [],
  );
  useEffect(() => {
    const poll = window.setInterval(result.reload, 15000);
    return () => window.clearInterval(poll);
  }, [result.reload]);
  return (
    <>
      <PageHeader
        eyebrow="Credential support"
        title="Password requests"
        description="Student and faculty requests appear here in realtime. Set a temporary password and communicate it manually."
      />
      <div className="reset-guidance">
        <ShieldAlert size={18} />
        <span>
          <strong>Existing passwords cannot be viewed.</strong>
          <small>
            Temporary passwords are never stored in AttendX tables or audit
            metadata. The user must replace one after login.
          </small>
        </span>
      </div>
      <DataState
        loading={result.loading}
        error={result.error}
        empty={!result.data.length}
      >
        <PasswordResetManager requests={result.data} onDone={result.reload} />
      </DataState>
    </>
  );
}

function PasswordResetManager({
  requests,
  onDone,
}: {
  requests: any[];
  onDone: () => void;
}) {
  const [passwords, setPasswords] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const reset = async (item: any) => {
    const temporaryPassword = passwords[item.id] || "";
    if (temporaryPassword.length < 12) {
      setError("Temporary passwords require at least 12 characters.");
      return;
    }
    setBusy(item.id);
    setError("");
    const { error } = await supabase.functions.invoke("admin-reset-password", {
      body: {
        userId: item.user_id,
        requestId: item.id,
        temporaryPassword,
        adminNote: "Reset completed from admin dashboard",
      },
    });
    if (error) setError(error.message);
    else {
      setPasswords((current) => ({ ...current, [item.id]: "" }));
      onDone();
    }
    setBusy("");
  };
  return (
    <section className="panel reset-manager">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Credential support</p>
          <h2>Password reset requests</h2>
        </div>
      </div>
      {error && <div className="inline-error reset-error">{error}</div>}
      {requests.length ? (
        requests.map((item) => (
          <div className="reset-request" key={item.id}>
            <div>
              <strong>{item.full_name}</strong>
              <small>
                {item.identifier} · {item.email}
              </small>
              <em>
                {item.reason || "Unable to sign in"} ·{" "}
                {formatDate(item.requested_at)}
              </em>
            </div>
            <div className="reset-action">
              <input
                type="password"
                className="text-input"
                value={passwords[item.id] || ""}
                onChange={(event) =>
                  setPasswords((current) => ({
                    ...current,
                    [item.id]: event.target.value,
                  }))
                }
                placeholder="Temporary password"
              />
              <Button onClick={() => reset(item)} disabled={busy === item.id}>
                {busy === item.id ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <KeyRound size={16} />
                )}
                Set password
              </Button>
            </div>
          </div>
        ))
      ) : (
        <SmallEmpty label="No pending password requests" />
      )}
    </section>
  );
}

export function PeopleView() {
  const [people, setPeople] = useState<any[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(true);
  const [peopleError, setPeopleError] = useState("");
  const [query, setQuery] = useState(""),
    [busy, setBusy] = useState("");
  const [roleFilter, setRoleFilter] = useState("all"),
    [departmentFilter, setDepartmentFilter] = useState("all"),
    [batchFilter, setBatchFilter] = useState("all");

  const loadPeople = async () => {
    setPeopleLoading(true);
    setPeopleError("");
    try {
      const token = localStorage.getItem("attendx_auth_token") || "";
      const res = await fetch(`${getLocalServerUrl()}/api/admin/directory`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load the directory");
      setPeople(Array.isArray(data.users) ? data.users : []);
    } catch (err) {
      setPeopleError((err as Error).message);
      // Fallback: plain profile list so the page still works offline
      const fallback = await rows<any>(supabase.from("profiles").select("*").order("full_name"));
      setPeople(fallback);
    }
    setPeopleLoading(false);
  };

  useEffect(() => { void loadPeople(); }, []);

  const departmentsList = [...new Set(people.map((p) => p.department).filter(Boolean))].sort();
  const batchesList = [...new Set(people.flatMap((p: any) => (p.batches_label || "").split(", ")).filter(Boolean))].sort();

  const filtered = people.filter((person) => {
    if (roleFilter !== "all" && person.role !== roleFilter) return false;
    if (departmentFilter !== "all" && (person.department || "") !== departmentFilter) return false;
    if (batchFilter && !(person.batches_label || "").includes(batchFilter)) return false;
    return `${person.full_name} ${person.email} ${person.identifier} ${person.batches_label || ""} ${person.year || ""}`
      .toLowerCase()
      .includes(query.toLowerCase());
  });
  const toggle = async (person: any) => {
    setBusy(person.id);
    // Dedicated endpoint fires the activation/deactivation mail automatically.
    try {
      const token = localStorage.getItem("attendx_auth_token") || "";
      await fetch(`${getLocalServerUrl()}/api/admin/users/${person.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isActive: !person.is_active }),
      });
    } catch {
      // fall back to the generic data update if the endpoint is unreachable
      await supabase
        .from("profiles")
        .update({ is_active: !person.is_active })
        .eq("id", person.id);
    }
    setBusy("");
    void loadPeople();
  };
  return (
    <>
      <PageHeader
        eyebrow="Directory"
        title="People"
        description="Accounts and profile details stored in the AttendX database."
      />
      <div className="filter-row" style={{ display: "flex", gap: ".6rem", flexWrap: "wrap" }}>
        <div className="search-input search-wide" style={{ flex: 1, minWidth: "220px" }}>
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, email, enrollment no, batch…"
          />
        </div>
        <select className="text-input" style={{ width: "150px", height: "42px" }} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
          <option value="all">All roles</option>
          <option value="student">Students</option>
          <option value="faculty">Faculty</option>
          <option value="admin">Admins</option>
        </select>
        <select className="text-input" style={{ width: "180px", height: "42px" }} value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)}>
          <option value="all">All departments</option>
          {departmentsList.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select className="text-input" style={{ width: "170px", height: "42px" }} value={batchFilter} onChange={(e) => setBatchFilter(e.target.value)}>
          <option value="all">All batches</option>
          {batchesList.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>
      <section className="panel table-panel">
        <DataState
          loading={peopleLoading}
          error={peopleError}
          empty={!filtered.length}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Email</th>
                  <th>Enrollment no</th>
                  <th>Department</th>
                  <th>Role</th>
                  <th>Classes</th>
                  <th>Batch / Year</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((person) => (
                  <tr key={person.id}>
                    <td>
                      <div className="table-class">
                        <Initials name={person.full_name} />
                        <span>
                          <strong>{person.full_name}</strong>
                        </span>
                      </div>
                    </td>
                    <td style={{ maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <a href={`mailto:${person.email}`} style={{ color: "var(--blue)", textDecoration: "none" }}>{person.email}</a>
                    </td>
                    <td>{person.identifier || "—"}</td>
                    <td>{person.department || "—"}</td>
                    <td>
                      <span className={`role-text role-${person.role}`}>
                        {person.role}
                      </span>
                    </td>
                    <td style={{ maxWidth: "180px", fontSize: "11px", color: "var(--muted)" }}>
                      {person.classes?.length ? person.classes.join(", ") : "—"}
                    </td>
                    <td style={{ maxWidth: "170px", fontSize: "11px", color: "var(--muted)" }}>
                      {person.batches_label || "—"}{person.year ? <><br /><span style={{ color: "var(--green)", fontWeight: 700 }}>{person.year}</span></> : null}
                    </td>
                    <td>
                      {person.is_active ? (
                        <span className="active-status">
                          <i />
                          Active
                        </span>
                      ) : (
                        "Inactive"
                      )}
                    </td>
                    <td>
                      <Button
                        variant="secondary"
                        onClick={() => toggle(person)}
                        disabled={busy === person.id}
                      >
                        {person.is_active ? "Deactivate" : "Activate"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataState>
      </section>
    </>
  );
}

export function ReviewQueue() {
  const result = useLoad(
    [] as DbRecord[],
    () =>
      rows<DbRecord>(
        supabase
          .from("attendance_records")
          .select("*")
          .in("status", ["flagged", "pending_review"])
          .order("marked_at"),
      ),
    [],
  );
  const [selectedId, setSelectedId] = useState(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (!selectedId && result.data[0]) setSelectedId(result.data[0].id);
  }, [result.data, selectedId]);
  const selected = result.data.find((item) => item.id === selectedId);
  const decide = async (status: "present" | "rejected") => {
    if (!selected) return;
    if (note.trim().length < 3) {
      setMessage("Enter a review note first.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.functions.invoke(
      "admin-update-attendance",
      { body: { attendanceId: selected.id, status, notes: note } },
    );
    setBusy(false);
    if (error) setMessage(error.message);
    else {
      setMessage("Decision saved and audit logged.");
      setNote("");
      setSelectedId("");
      result.reload();
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="Integrity center"
        title="Review queue"
        description="Only unresolved attendance records appear here."
      />
      <DataState
        loading={result.loading}
        error={result.error}
        empty={!result.data.length}
      >
        <div className="review-detail-grid">
          <section className="panel review-list-panel">
            <div className="panel-head">
              <h2>{result.data.length} open cases</h2>
            </div>
            <div className="queue-list">
              {result.data.map((item) => (
                <button
                  className={`queue-item ${selectedId === item.id ? "active" : ""}`}
                  key={item.id}
                  onClick={() => {
                    setSelectedId(item.id);
                    setMessage("");
                  }}
                >
                  <span className="review-icon review-amber">
                    <Flag size={17} />
                  </span>
                  <span>
                    <strong>{item.profiles?.full_name}</strong>
                    <small>
                      {item.attendance_sessions?.classes?.code} ·{" "}
                      {formatDate(item.marked_at)}
                    </small>
                  </span>
                  <em>{item.rejection_reason || item.status}</em>
                </button>
              ))}
            </div>
          </section>
          {selected && (
            <section className="panel evidence-panel">
              <div className="evidence-head">
                <div>
                  <p className="eyebrow">Selected case</p>
                  <h2>{selected.profiles?.full_name}</h2>
                </div>
                <StatusPill status={selected.status} />
              </div>
              <div className="evidence-facts">
                <div>
                  <MapPin size={16} />
                  <span>
                    <strong>Distance</strong>
                    <small>
                      {selected.distance_from_center_m != null
                        ? `${Math.round(selected.distance_from_center_m)} m`
                        : "Unavailable"}
                    </small>
                  </span>
                </div>
                <div>
                  <LocateFixed size={16} />
                  <span>
                    <strong>GPS accuracy</strong>
                    <small>
                      {selected.gps_accuracy_m != null
                        ? `${Math.round(selected.gps_accuracy_m)} m`
                        : "Unavailable"}
                    </small>
                  </span>
                </div>
                <div>
                  <ShieldAlert size={16} />
                  <span>
                    <strong>Reason</strong>
                    <small>
                      {selected.rejection_reason || "Automated review required"}
                    </small>
                  </span>
                </div>
              </div>
              <label className="field-label review-note">
                Decision note
                <textarea
                  className="text-input"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
              {message && <div className="inline-error">{message}</div>}
              <div className="decision-actions">
                <Button
                  variant="danger"
                  onClick={() => decide("rejected")}
                  disabled={busy}
                >
                  <X size={17} />
                  Reject
                </Button>
                <Button onClick={() => decide("present")} disabled={busy}>
                  <Check size={17} />
                  Approve
                </Button>
              </div>
            </section>
          )}
        </div>
      </DataState>
    </>
  );
}

export function SettingsView() {
  const result = useLoad(
    [] as any[],
    () => rows<any>(supabase.from("system_settings").select("*").order("key")),
    [],
  );
  const [values, setValues] = useState<Record<string, string>>({}),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState("");
  useEffect(
    () =>
      setValues(
        Object.fromEntries(
          result.data.map((item) => [item.key, String(item.value)]),
        ),
      ),
    [result.data],
  );
  // Legacy seeding could duplicate keys — render each setting once.
  const unique = useMemo(
    () =>
      Object.values(
        Object.fromEntries(
          (result.data as any[]).slice().reverse().map((item) => [item.key, item]),
        ),
      ) as any[],
    [result.data],
  );
  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      const token = localStorage.getItem('attendx_auth_token') || '';
      const res = await fetch(`${getLocalServerUrl()}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          settings: result.data.map((item: any) => ({
            key: item.key,
            value: values[item.key] ?? item.value,
            description: item.description,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not save settings');
      setMessage('Settings saved.');
      result.reload();
    } catch (err) {
      setMessage((err as Error).message);
    }
    setSaving(false);
  };
  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="System settings"
        description="Values are read from and written to the system_settings table."
        action={
          <Button onClick={save} disabled={saving}>
            <Check size={17} />
            Save
          </Button>
        }
      />
      {message && (
        <div className="session-banner">
          <CheckCircle2 size={18} />
          {message}
        </div>
      )}
      <DataState
        loading={result.loading}
        error={result.error}
        empty={!result.data.length}
      >
        <div className="panel settings-panel-new">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Configuration</p>
              <h2>Institution preferences</h2>
            </div>
            <span className="settings-count">{unique.length} setting{unique.length === 1 ? "" : "s"}</span>
          </div>
          {unique.map((item, index) => {
            const isBoolean = /^(true|false)$/i.test(String(values[item.key] ?? item.value));
            const title = item.key
              .replaceAll("_", " ")
              .replace(/\b\w/g, (c: string) => c.toUpperCase());
            return (
              <div className={`setting-row-new ${index % 2 ? "odd" : ""}`} key={item.key}>
                <div className="setting-row-new-text">
                  <strong>{title}</strong>
                  <small>{item.description || `Controls the ${title.toLowerCase()} behaviour across AttendX.`}</small>
                </div>
                {isBoolean ? (
                  <label className="toggle-wrap">
                    <input
                      type="checkbox"
                      className="toggle"
                      checked={String(values[item.key] ?? item.value).toLowerCase() === "true"}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [item.key]: event.target.checked ? "true" : "false",
                        }))
                      }
                    />
                    <span className="toggle-state" data-on={String(values[item.key] ?? item.value).toLowerCase() === "true"}>
                      {String(values[item.key] ?? item.value).toLowerCase() === "true" ? "Enabled" : "Disabled"}
                    </span>
                  </label>
                ) : (
                  <input
                    className="text-input settings-input-new"
                    value={values[item.key] ?? ""}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [item.key]: event.target.value,
                      }))
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      </DataState>
      <ServerAndSyncSettings />
    </>
  );
}

function ServerConnectionCard() {
  const [url, setUrl] = useState(getLocalServerUrl());
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const test = async () => {
    setTesting(true);
    setResult(null);
    const base = url.replace(/\/$/, "");
    // /api/health exists on both the Vercel serverless function and the
    // standalone server; /health only exists standalone. The first request
    // can absorb a serverless cold start, so allow 15s and retry once.
    const tryHealth = async (path: string) => {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15000) });
      return res.ok ? ((await res.json()) as { database?: string }) : null;
    };
    let json: { database?: string } | null = null;
    for (let attempt = 0; attempt < 2 && !json; attempt++) {
      try {
        json = await tryHealth("/api/health");
      } catch {
        /* cold start or network blip — retry */
      }
    }
    if (!json) {
      try {
        json = await tryHealth("/health");
      } catch {
        /* reported below */
      }
    }
    if (json) {
      setLocalServerUrl(url);
      setResult({ ok: true, text: `Connected — database ${(json.database || "active").toUpperCase()}.` });
    } else {
      setResult({
        ok: false,
        text: "Could not reach the server. Check the URL and your network — the first request after idle can take up to 15s.",
      });
    }
    setTesting(false);
  };

  return (
    <div className="form-body" style={{ padding: "1.5rem" }}>
      <p style={{ color: "var(--muted)", fontSize: "0.88rem", marginBottom: "1rem" }}>
        The AttendX app talks to your AttendX server for all data and mail.
        On this device it is currently using:
      </p>
      <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="text-input"
          style={{ flex: 1, minWidth: "240px" }}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://attendx-lilac-zeta.vercel.app or http://192.168.1.50:3001"
        />
        <Button onClick={test} disabled={testing}>
          <RefreshCw size={16} className={testing ? "spin" : ""} />
          {testing ? "Testing…" : "Test & save"}
        </Button>
      </div>
      {result && (
        <div
          style={{
            marginTop: "0.85rem",
            padding: "0.6rem 0.9rem",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "0.88rem",
            background: result.ok ? "rgba(22,125,100,.12)" : "rgba(188,75,87,.12)",
            color: result.ok ? "var(--green)" : "var(--rose)",
          }}
        >
          {result.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          {result.text}
        </div>
      )}
    </div>
  );
}

export function ProfileView() {
  const { profile, role } = useAppStore();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [passError, setPassError] = useState("");
  const [passMessage, setPassMessage] = useState("");
  const [changing, setChanging] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPassError("");
    setPassMessage("");
    if (password.length < 12) {
      setPassError("Use at least 12 characters.");
      return;
    }
    if (password !== confirm) {
      setPassError("Passwords do not match.");
      return;
    }
    setChanging(true);
    const { error: functionError } = await supabase.functions.invoke(
      "change-own-password",
      { body: { password } }
    );
    if (functionError) setPassError(functionError.message);
    else {
      setPassMessage("Password updated successfully.");
      setPassword("");
      setConfirm("");
    }
    setChanging(false);
  };
  const devices = useLoad(
    [] as any[],
    () =>
      rows<any>(
        supabase
          .from("devices")
          .select("*")
          .eq("user_id", profile.id)
          .order("last_seen_at", { ascending: false }),
      ),
    [profile.id],
  );

  const handleCapture = async (photo: LivePhoto) => {
    try {
      setChanging(true);
      setPassError("");
      setPassMessage("Uploading verified face image...");

      // Upload via the AttendX server (replaces Supabase storage)
      const res = await fetch(`${getLocalServerUrl()}/api/profile/photo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('attendx_auth_token') || ''}`,
        },
        body: JSON.stringify({ dataUrl: photo.dataUrl }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setPassError(data.error || 'Could not save the face image');
        setPassMessage("");
        setChanging(false);
        return;
      }

      setPassMessage("Face image updated successfully!");
      useAppStore.getState().bootstrap();
      setChanging(false);
    } catch (err: any) {
      setPassError(err.message || "Failed to process image.");
      setPassMessage("");
      setChanging(false);
    }
  };

  const startCamera = async () => {
    setPassError("");
    setPassMessage("");
    try {
      const result = await captureNativePhoto("user");
      if (result) {
        await handleCapture(result);
      } else {
        setCameraActive(true);
      }
    } catch (reason) {
      setPassError(reason instanceof Error ? reason.message : "Camera failed");
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Your profile"
        description="Profile and trusted-device data from the AttendX database."
      />
      <div className="profile-grid">
        <section className="panel profile-card">
          <div className="profile-cover">
            <div className="profile-avatar">
              <Initials name={profile.full_name} size="lg" />
            </div>
          </div>
          <div className="profile-body">
            <h2>{profile.full_name}</h2>
            <p>{profile.email}</p>
            <span className={`role-text role-${role}`}>{role}</span>
            <div className="profile-meta">
              <div>
                <small>Identifier</small>
                <strong>{profile.identifier}</strong>
              </div>
              <div>
                <small>Department</small>
                <strong>{profile.department || "Not set"}</strong>
              </div>
            </div>
          </div>
        </section>
        <section className="panel face-upload-card">
          <div className="panel-head">
            <h2>Face Verification</h2>
            <Camera size={20} />
          </div>
          <div className="form-body" style={{ padding: '1.5rem' }}>
            <p className="text-sm" style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>
              Capture a clear photo of your face using your camera. This will be used to verify your identity during attendance.
            </p>
            
            <Button onClick={startCamera} disabled={changing}>
              {changing ? <><LoaderCircle className="spin" size={16} style={{marginRight: 8}}/> Processing...</> : <><Camera size={16} style={{marginRight: 8}}/> Capture Face</>}
            </Button>

            {cameraActive && (
              <CameraCaptureModal
                facing="user"
                title="Capture your face"
                onClose={() => setCameraActive(false)}
                onCapture={(photo) => {
                  setCameraActive(false);
                  void handleCapture(photo);
                }}
              />
            )}

            {profile.enrollment_photo_path && (
              <div className="mt-4">
                <p className="text-sm font-medium mb-2">Current Verified Face:</p>
                <img
                  src={profile.enrollment_photo_path.startsWith('data:') || profile.enrollment_photo_path.startsWith('http') ? profile.enrollment_photo_path : `${getLocalServerUrl()}${profile.enrollment_photo_path}`}
                  alt="Face"
                  style={{ width: 100, height: 100, borderRadius: 8, objectFit: 'cover' }}
                />
              </div>
            )}
          </div>
        </section>
        <section className="panel password-card">
          <div className="panel-head">
            <h2>Server connection</h2>
            <Server size={20} />
          </div>
          <ServerConnectionCard />
        </section>
        <section className="panel password-card">
          <div className="panel-head">
            <h2>Change password</h2>
            <KeyRound size={20} />
          </div>
          <form className="form-body" style={{ padding: '1.5rem' }} onSubmit={changePassword}>
            {passError && <div className="login-error" style={{ marginBottom: '1rem' }}><AlertTriangle size={16}/>{passError}</div>}
            {passMessage && <div className="session-banner" style={{ marginBottom: '1rem' }}><CheckCircle2 size={18} />{passMessage}</div>}
            <label className="field-label">
              New password
              <input className="text-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
            </label>
            <label className="field-label">
              Confirm password
              <input className="text-input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={12} />
            </label>
            <Button disabled={changing} style={{ marginTop: '0.5rem' }}>
              {changing ? "Updating..." : "Update password"}
            </Button>
          </form>
        </section>
      </div>
      <div className="profile-grid" style={{ marginTop: '1.5rem' }}>
        <section className="panel device-card">
          <div className="panel-head">
            <h2>Trusted devices</h2>
            <Smartphone size={20} />
          </div>
          <DataState
            loading={devices.loading}
            error={devices.error}
            empty={!devices.data.length}
          >
            <>
              {devices.data.map((device) => (
                <div className="device-row" key={device.id}>
                  <span className="device-icon">
                    {device.platform === "android" ? (
                      <Smartphone size={19} />
                    ) : (
                      <Globe2 size={19} />
                    )}
                  </span>
                  <span>
                    <strong>{device.model || device.platform}</strong>
                    <small>Last seen {formatDate(device.last_seen_at)}</small>
                  </span>
                  <span
                    className={
                      device.is_trusted ? "active-status" : "web-label"
                    }
                  >
                    {device.is_trusted ? "Trusted" : "Blocked"}
                  </span>
                </div>
              ))}
            </>
          </DataState>
        </section>
      </div>
    </>
  );
}

export function InvitationCodesView() {
  const result = useLoad([] as any[], () => rows<any>(supabase.from('join_tokens').select('*').order('created_at', { ascending: false })), []);

  const discard = async (id: string) => {
    const { error } = await supabase.from('join_tokens').update({ is_active: false }).eq('id', id);
    if (!error) result.reload();
  };

  return (
    <>
      <PageHeader eyebrow="Administration" title="Invitation Codes" description="Manage signup and join tokens for faculty and students." />
      <DataState loading={result.loading} error={result.error} empty={!result.data.length}>
        <section className="panel">
          <div className="panel-head"><h2>All generated tokens</h2></div>
          <table className="data-table">
            <thead><tr><th>Created</th><th>Type</th><th>Target</th><th>Uses</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              {result.data.map((item) => (
                <tr key={item.id}>
                  <td>{formatDate(item.created_at)}</td>
                  <td>{item.token_type || 'batch_join'}</td>
                  <td>{item.batches?.name || item.batches?.code || 'General'}</td>
                  <td>{item.use_count ?? 0} / {item.max_uses ?? '∞'}</td>
                  <td><span className={`status ${item.is_active ? 'status-present' : 'status-pending_review'}`}>{item.is_active ? 'Active' : 'Expired/Used'}</span></td>
                  <td>
                    {item.is_active && (
                      <Button variant="secondary" onClick={() => discard(item.id)}>Discard</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </DataState>
    </>
  );
}

// ── Attendance queries / complaints with tracking numbers ─────────────

type AttendanceQuery = {
  id: string;
  tracking_id: string;
  student_name?: string;
  student_email?: string;
  student_identifier?: string;
  class_label?: string | null;
  type: string;
  message: string;
  status: string;
  admin_note?: string;
  email_sent?: boolean;
  created_at?: string;
  updated_at?: string;
  resolved_at?: string | null;
};

const QUERY_TYPES = [
  { value: 'not_marked', label: 'Attendance not marked' },
  { value: 'wrong_status', label: 'Wrong status recorded' },
  { value: 'location_issue', label: 'Location / GPS problem' },
  { value: 'other', label: 'Other issue' },
];

function QueryStatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: 'status-flagged',
    in_review: 'status-pending_review',
    resolved: 'status-present',
    rejected: 'status-rejected',
  };
  return <span className={`status ${map[status] || 'status-pending_review'}`}>{status.replace('_', ' ')}</span>;
}

export function AttendanceQueriesView() {
  const { role, profile } = useAppStore();
  const isAdmin = role === 'admin';
  const result = useLoad(
    [] as AttendanceQuery[],
    async () => {
      const token = localStorage.getItem('attendx_auth_token') || '';
      const res = await fetch(`${getLocalServerUrl()}/api/queries`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load queries');
      return res.json() as Promise<AttendanceQuery[]>;
    },
    [role, profile.id],
  );
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ classId: '', type: 'not_marked', details: '' });
  const [submitting, setSubmitting] = useState(false);
  const [lastTracking, setLastTracking] = useState('');
  const [trackLookup, setTrackLookup] = useState('');
  const [trackResult, setTrackResult] = useState<any>(null);
  const [resolving, setResolving] = useState<Record<string, string>>({});

  const classes = useLoad([] as DbClass[], () => loadClasses(role, profile.id), [role, profile.id]);

  const raise = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage('');
    try {
      const cls = classes.data.find((c) => c.id === form.classId);
      const token = localStorage.getItem('attendx_auth_token') || '';
      const res = await fetch(`${getLocalServerUrl()}/api/queries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          classId: form.classId || undefined,
          classLabel: cls ? `${cls.name} (${cls.code})` : undefined,
          type: form.type,
          message: form.details,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not raise the query');
      setLastTracking(data.trackingId);
      setForm({ classId: '', type: 'not_marked', details: '' });
      result.reload();
    } catch (err) {
      setMessage((err as Error).message);
    }
    setSubmitting(false);
  };

  const track = async () => {
    setTrackResult(null);
    if (!trackLookup.trim()) return;
    try {
      const res = await fetch(`${getLocalServerUrl()}/api/queries/track/${encodeURIComponent(trackLookup.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Not found');
      setTrackResult(data);
    } catch (err) {
      setTrackResult({ error: (err as Error).message });
    }
  };

  const resolve = async (item: AttendanceQuery, status: 'resolved' | 'rejected') => {
    try {
      const token = localStorage.getItem('attendx_auth_token') || '';
      const res = await fetch(`${getLocalServerUrl()}/api/queries/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status, adminNote: resolving[item.id] || '' }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not update the query');
      setMessage(`Query ${data.trackingId} marked ${status}. The student has been emailed.`);
      result.reload();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Attendance support"
        title={isAdmin ? 'Attendance queries' : 'Raise an attendance query'}
        description={
          isAdmin
            ? 'Student complaints with tracking numbers. Resolving emails the student automatically.'
            : 'Report a missing or incorrect attendance record. You will receive a request number by email.'
        }
      />
      {message && <div className="session-banner"><CheckCircle2 size={18} />{message}</div>}

      {!isAdmin && (
        <section className="panel" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
          <div className="panel-head" style={{ padding: '0 0 12px', borderBottom: '1px solid var(--line)' }}>
            <div>
              <p className="eyebrow">New complaint</p>
              <h2>Describe your attendance issue</h2>
            </div>
            <MailQuestion size={20} />
          </div>
          {lastTracking && (
            <div className="pending-box" style={{ marginTop: '1rem' }}>
              <CheckCircle2 size={20} />
              <div>
                <strong>Query raised — request number {lastTracking}</strong>
                <small>"This student's query has been raised and it will be resolved by the request number." A confirmation email was sent to {profile.email}.</small>
              </div>
            </div>
          )}
          <form className="form-body" style={{ padding: '1rem 0 0' }} onSubmit={raise}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <label className="field-label">
                Class (optional)
                <select className="text-input" value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
                  <option value="">Not class specific</option>
                  {classes.data.map((c) => (
                    <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Issue type
                <select className="text-input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {QUERY_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field-label">
              Details
              <textarea
                className="text-input"
                style={{ minHeight: '90px', paddingTop: '10px', resize: 'vertical' }}
                value={form.details}
                onChange={(e) => setForm({ ...form, details: e.target.value })}
                placeholder="Explain what happened — e.g. your attendance was not marked even though you scanned the QR code."
                required
              />
            </label>
            <Button type="submit" disabled={submitting}>
              {submitting ? <LoaderCircle className="spin" size={17} /> : <MailQuestion size={17} />}
              Raise query &amp; get request number
            </Button>
          </form>
        </section>
      )}

      <section className="panel" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
        <div className="panel-head" style={{ padding: '0 0 12px', borderBottom: '1px solid var(--line)' }}>
          <div>
            <p className="eyebrow">Tracking</p>
            <h2>Track by request number</h2>
          </div>
          <ShieldCheckIcon size={20} />
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem', flexWrap: 'wrap' }}>
          <input
            className="text-input"
            style={{ maxWidth: '280px' }}
            value={trackLookup}
            onChange={(e) => setTrackLookup(e.target.value)}
            placeholder="ATX-Q-XXXXXX"
          />
          <Button variant="secondary" onClick={track} disabled={!trackLookup.trim()}>Track status</Button>
        </div>
        {trackResult && (
          trackResult.error ? (
            <div className="inline-error" style={{ marginTop: '0.75rem' }}><AlertTriangle size={16} />{trackResult.error}</div>
          ) : (
            <div style={{ marginTop: '0.75rem', padding: '0.9rem', border: '1px solid var(--line)', borderRadius: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <strong>{trackResult.tracking_id}</strong>
                <QueryStatusPill status={trackResult.status} />
              </div>
              <small style={{ display: 'block', marginTop: '6px', color: 'var(--muted)' }}>
                {QUERY_TYPES.find((t) => t.value === trackResult.type)?.label || trackResult.type}
                {trackResult.class_label ? ` · ${trackResult.class_label}` : ''}
                {trackResult.created_at ? ` · raised ${formatDate(trackResult.created_at)}` : ''}
              </small>
              {trackResult.admin_note && <small style={{ display: 'block', marginTop: '6px' }}>Admin note: {trackResult.admin_note}</small>}
            </div>
          )
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">{isAdmin ? 'Support queue' : 'Your queries'}</p>
            <h2>{result.data.length} {result.data.length === 1 ? 'query' : 'queries'}</h2>
          </div>
          <button className="text-button" onClick={result.reload}>Refresh</button>
        </div>
        <DataState loading={result.loading} error={result.error} empty={!result.data.length}>
          <div style={{ padding: '0.5rem 1rem 1rem' }}>
            {result.data.map((item) => (
              <div key={item.id} style={{ padding: '1rem', border: '1px solid var(--line)', borderRadius: '8px', marginBottom: '0.6rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ fontFamily: 'monospace', fontSize: '0.95rem' }}>{item.tracking_id}</strong>
                  <QueryStatusPill status={item.status} />
                </div>
                {isAdmin && (
                  <small style={{ display: 'block', marginTop: '4px', color: 'var(--muted)' }}>
                    {item.student_name} ({item.student_identifier}) · {item.student_email}
                  </small>
                )}
                <small style={{ display: 'block', marginTop: '4px', color: 'var(--muted)' }}>
                  {QUERY_TYPES.find((t) => t.value === item.type)?.label || item.type}
                  {item.class_label ? ` · ${item.class_label}` : ''}
                  {item.created_at ? ` · ${formatDate(item.created_at)}` : ''}
                </small>
                <p style={{ margin: '8px 0 0', fontSize: '0.9rem' }}>{item.message}</p>
                {item.admin_note && <small style={{ display: 'block', marginTop: '6px', color: 'var(--green)' }}>Admin note: {item.admin_note}</small>}
                {isAdmin && (item.status === 'open' || item.status === 'in_review') && (
                  <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                    <input
                      className="text-input"
                      style={{ flex: 1, minWidth: '200px' }}
                      placeholder="Resolution note (included in the email)"
                      value={resolving[item.id] || ''}
                      onChange={(e) => setResolving({ ...resolving, [item.id]: e.target.value })}
                    />
                    <Button onClick={() => resolve(item, 'resolved')}><Check size={16} />Resolve</Button>
                    <Button variant="danger" onClick={() => resolve(item, 'rejected')}><X size={16} />Reject</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </DataState>
      </section>
    </>
  );
}
