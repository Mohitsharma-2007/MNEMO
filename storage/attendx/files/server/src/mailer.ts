import nodemailer from 'nodemailer';

const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
export const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_EMAIL || SMTP_USER;

export const smtpConfigured = Boolean(SMTP_USER && SMTP_PASS);

export const transporter = nodemailer.createTransport({
  service: 'gmail',
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

export const FROM_HEADER = `"AttendX" <${SMTP_USER || 'no-reply@attendx.edu'}>`;

function emailShell(heading: string, bodyHtml: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b1311; color: #f1f5f9; margin: 0; padding: 24px; }
        .card { max-width: 500px; margin: 0 auto; background: #131d1b; border: 1px solid #223733; border-radius: 14px; padding: 32px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; font-weight: 800; font-size: 20px; color: #10b981; letter-spacing: 0.5px; }
        .logo span { color: #f1f5f9; }
        h1 { font-size: 21px; font-weight: 700; margin: 0 0 10px; color: #ffffff; }
        p { font-size: 14px; color: #94a3b8; line-height: 1.55; margin: 0 0 16px; }
        .highlight { background: linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(59, 130, 246, 0.12)); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 10px; padding: 18px; text-align: center; margin: 22px 0; }
        .code { font-size: 30px; font-weight: 800; letter-spacing: 4px; color: #34d399; font-family: monospace; word-break: break-all; }
        .row { display: flex; justify-content: space-between; border-bottom: 1px solid #1e293b; padding: 10px 0; font-size: 13px; }
        .row em { color: #64748b; font-style: normal; }
        .row strong { color: #e2e8f0; text-align: right; }
        .footer { border-top: 1px solid #1e293b; padding-top: 16px; margin-top: 24px; font-size: 12px; color: #64748b; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo"><span>Attend</span>X</div>
        ${bodyHtml}
        <div class="footer">AttendX · Institutional attendance infrastructure</div>
      </div>
    </body>
    </html>
  `;
}

async function dispatch(to: string, subject: string, html: string, text: string): Promise<boolean> {
  if (!smtpConfigured) {
    console.warn('[AttendX Mail] SMTP credentials are not configured; email skipped for', to);
    return false;
  }
  try {
    await transporter.sendMail({ from: FROM_HEADER, to, subject, html, text });
    console.log(`[AttendX Mail] Delivered "${subject}" to ${to}`);
    return true;
  } catch (err) {
    console.error('[AttendX Mail] Failed to deliver:', (err as Error).message);
    return false;
  }
}

/** OTP verification code email. */
export async function sendOtpEmail(to: string, code: string, purpose: string): Promise<boolean> {
  const html = emailShell('Verification code', `
    <h1>Verification code</h1>
    <p>Use the one-time security code below to complete your ${purpose.replace('_', ' ')} for <strong>${to}</strong>.</p>
    <div class="highlight">
      <div class="code">${code}</div>
      <p style="margin:6px 0 0;font-size:12px;color:#64748b;">Valid for 5 minutes · Do not share this code</p>
    </div>
    <p style="font-size:13px;">If you didn't request this verification code, please ignore this email.</p>
  `);
  return dispatch(to, `Your AttendX verification code: ${code}`, html, `Your AttendX verification code is: ${code}. Valid for 5 minutes.`);
}

/** Raised when a student files an attendance query/complaint. */
export async function sendQueryRaisedEmail(
  to: string,
  studentName: string,
  trackingId: string,
  className: string,
  queryType: string,
  message: string,
): Promise<boolean> {
  const html = emailShell('Query received', `
    <h1>Attendance query received</h1>
    <p>Dear <strong>${studentName}</strong>,</p>
    <p style="color:#e2e8f0;">This student's query has been raised and it will be resolved by the request number.</p>
    <div class="highlight">
      <p style="margin:0 0 6px;font-size:12px;color:#64748b;">YOUR REQUEST / TRACKING NUMBER</p>
      <div class="code">${trackingId}</div>
    </div>
    <div class="row"><em>Class</em><strong>${className || '—'}</strong></div>
    <div class="row"><em>Issue type</em><strong>${queryType.replace(/_/g, ' ')}</strong></div>
    <div class="row"><em>Details</em><strong>${(message || '—').slice(0, 240)}</strong></div>
    <div class="row"><em>Status</em><strong>Open · Under review</strong></div>
    <p style="margin-top:18px;">Keep this request number safe. Quote it in any follow-up; the administration will email you once your query is resolved.</p>
  `);
  const text = `Dear ${studentName}, this student's query has been raised and it will be resolved by the request number ${trackingId}. Class: ${className}. Type: ${queryType}.`;
  return dispatch(to, `[AttendX] Query raised — Request number ${trackingId}`, html, text);
}

/** Sent to the student once an admin resolves their query. */
export async function sendQueryResolvedEmail(
  to: string,
  studentName: string,
  trackingId: string,
  status: string,
  adminNote: string,
): Promise<boolean> {
  const resolved = status === 'resolved';
  const html = emailShell('Query update', `
    <h1>Query ${resolved ? 'resolved' : 'reviewed'}</h1>
    <p>Dear <strong>${studentName}</strong>,</p>
    <p>Your attendance query with request number <strong style="color:#34d399;">${trackingId}</strong> has been <strong>${resolved ? 'resolved' : 'closed as ' + status}</strong>.</p>
    <div class="row"><em>Request number</em><strong>${trackingId}</strong></div>
    <div class="row"><em>Status</em><strong style="color:${resolved ? '#34d399' : '#f87171'}">${status.toUpperCase()}</strong></div>
    <div class="row"><em>Administrator note</em><strong>${adminNote || '—'}</strong></div>
    <p style="margin-top:18px;">You can view the full record any time in the Attendance Queries section of AttendX. If you believe this decision is incorrect, raise a new query quoting this request number.</p>
  `);
  return dispatch(to, `[AttendX] Query ${trackingId} — ${status.toUpperCase()}`, html, `Your AttendX query ${trackingId} has been marked ${status}. Note: ${adminNote}`);
}

/** Faculty invitation code after admin approval. */
export async function sendFacultyCodeEmail(to: string, name: string, code: string): Promise<boolean> {
  const html = emailShell('Faculty application approved', `
    <h1>Your faculty application is approved</h1>
    <p>Dear <strong>${name}</strong>,</p>
    <p>Your AttendX faculty application has been approved. Use the invitation code below to activate your account: sign in, and you will be asked to enter it once.</p>
    <div class="highlight"><div class="code">${code}</div></div>
    <p>This code is single-use. If you did not expect this email, contact your institution's administrator.</p>
  `);
  return dispatch(to, `[AttendX] Your faculty invitation code: ${code}`, html, `Your AttendX faculty invitation code is: ${code}`);
}

/** Alerts the administration that a query needs attention. */
export async function notifyAdminOfQuery(
  studentName: string,
  studentEmail: string,
  trackingId: string,
  className: string,
  message: string,
): Promise<boolean> {
  if (!ADMIN_NOTIFY_EMAIL || ADMIN_NOTIFY_EMAIL === studentEmail) return false;
  const html = emailShell('New attendance query', `
    <h1>New attendance query raised</h1>
    <p>A student query requires review in the AttendX admin dashboard.</p>
    <div class="highlight"><div class="code">${trackingId}</div></div>
    <div class="row"><em>Student</em><strong>${studentName} (${studentEmail})</strong></div>
    <div class="row"><em>Class</em><strong>${className || '—'}</strong></div>
    <div class="row"><em>Details</em><strong>${(message || '—').slice(0, 240)}</strong></div>
  `);
  return dispatch(ADMIN_NOTIFY_EMAIL, `[AttendX] New query ${trackingId} from ${studentName}`, html, `New attendance query ${trackingId} from ${studentName}: ${message}`);
}

/** Welcome/onboarding mail for brand-new accounts. */
export async function sendOnboardingEmail(to: string, name: string, role: string): Promise<boolean> {
  const html = emailShell('Welcome to AttendX', `
    <h1>Welcome to AttendX, ${name}!</h1>
    <p>Your <strong>${role}</strong> account has been created successfully. AttendX is your institution's attendance infrastructure — mark sessions with QR codes, track your record live, and raise queries with full request-number tracking.</p>
    <div class="row"><em>Account</em><strong>${to}</strong></div>
    <div class="row"><em>Role</em><strong>${role}</strong></div>
    <p style="margin-top:18px;">If you did not create this account, contact your institution's administrator immediately.</p>
  `);
  return dispatch(to, '[AttendX] Welcome to AttendX — your account is ready', html, `Welcome to AttendX, ${name}! Your ${role} account is ready.`);
}

/** Account activated by an administrator. */
export async function sendAccountActivatedEmail(to: string, name: string): Promise<boolean> {
  const html = emailShell('Account activated', `
    <h1>Your account has been activated</h1>
    <p>Dear <strong>${name}</strong>,</p>
    <p>Good news — your AttendX account has been <strong style="color:#34d399;">activated</strong> by the administration. You can now sign in and use every feature available to your role.</p>
    <div class="row"><em>Account</em><strong>${to}</strong></div>
    <p style="margin-top:18px;">Welcome aboard!</p>
  `);
  return dispatch(to, '[AttendX] Your account has been activated', html, `Dear ${name}, your AttendX account has been activated. You can sign in now.`);
}

/** Account deactivated by an administrator. */
export async function sendAccountDeactivatedEmail(to: string, name: string, reason: string): Promise<boolean> {
  const html = emailShell('Account deactivated', `
    <h1>Your account has been deactivated</h1>
    <p>Dear <strong>${name}</strong>,</p>
    <p>Your AttendX account has been <strong style="color:#f87171;">deactivated</strong> by the administration. Sign-in is disabled until an administrator reactivates it.</p>
    <div class="row"><em>Account</em><strong>${to}</strong></div>
    ${reason ? `<div class="row"><em>Reason</em><strong>${reason}</strong></div>` : ''}
    <p style="margin-top:18px;">If you believe this is a mistake, contact your institution's administrator.</p>
  `);
  return dispatch(to, '[AttendX] Your account has been deactivated', html, `Dear ${name}, your AttendX account has been deactivated. ${reason}`);
}

/** Temporary password issued by an administrator. */
export async function sendAdminPasswordResetEmail(to: string, name: string, tempPassword: string): Promise<boolean> {
  const html = emailShell('Password reset by administration', `
    <h1>Your password has been reset</h1>
    <p>Dear <strong>${name}</strong>,</p>
    <p>An administrator reset your AttendX password. Use the temporary password below to sign in — you will be asked to choose a new private password immediately after.</p>
    <div class="highlight">
      <p style="margin:0 0 6px;font-size:12px;color:#64748b;">TEMPORARY PASSWORD</p>
      <div class="code" style="letter-spacing:1px;font-size:20px;">${tempPassword}</div>
    </div>
    <p style="font-size:13px;">Never share this password. If you did not expect this reset, contact your administrator.</p>
  `);
  return dispatch(to, '[AttendX] Your password was reset — temporary password inside', html, `Your AttendX password was reset. Temporary password: ${tempPassword}`);
}
