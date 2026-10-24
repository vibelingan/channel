/**
 * Email delivery — nodemailer in production, a console-logging mock when SMTP
 * is not configured (local development).
 *
 * Sending is always best-effort: a failure never throws into the caller, it
 * just returns `false` so flows like password recovery still complete.
 */
import nodemailer from 'nodemailer';

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/** Build a mail config from environment variables, or null when unconfigured. */
export function loadEmailConfig(): MailConfig | null {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASSWORD;
  if (!user || !pass) return null;
  return {
    host: process.env.EMAIL_HOST ?? 'smtp.exmail.qq.com',
    port: Number(process.env.EMAIL_PORT ?? '465'),
    secure: process.env.EMAIL_SECURE !== 'false',
    user,
    pass,
    from: process.env.EMAIL_FROM ?? `"Channel Portal" <${user}>`,
  };
}

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Send an email. When SMTP is configured, delivers via nodemailer; otherwise
 * logs the message to the console (local mock) and returns false.
 */
export async function sendMail(input: SendMailInput): Promise<boolean> {
  const config = loadEmailConfig();
  if (!config) {
    // NEVER log the body: recovery emails carry a freshly-minted live password,
    // and this branch runs in production whenever EMAIL_* is unset (the deploy
    // provisions them via optionalEnv, so an unset secret silently lands here).
    // Log only routing metadata so the misconfiguration is operator-visible.
    console.error(
      `[email] SMTP not configured — email NOT sent (to=${input.to}, subject=${input.subject}).`,
    );
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
    });
    const info = await transporter.sendMail({
      from: config.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    console.log('[email] sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('[email] send failed:', error);
    return false;
  }
}

export interface PasswordResetEmailData {
  to: string;
  username: string;
  /** Full reset link with the single-use token in the query string. */
  resetUrl: string;
}

/**
 * Send a password-reset email containing a time-limited, single-use LINK (never
 * a password). The link carries the raw reset token; consuming it at
 * `resetPassword` is what actually sets a new password — this endpoint never
 * mutates the account, so a lost email is a harmless retry, not a lockout.
 */
export function sendPasswordResetEmail(data: PasswordResetEmailData): Promise<boolean> {
  const subject = 'Reset your Channel Portal password';
  const text = `Hi ${data.username},\n\nWe received a request to reset your Channel Portal password. Open the link below to choose a new password. It expires soon and can be used once.\n\n  ${data.resetUrl}\n\nIf you did not request this, you can safely ignore this email — your password stays unchanged.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto"><h2 style="color:#1f2a73">Reset your password</h2><p>Hi ${escapeHtml(data.username)},</p><p>We received a request to reset your Channel Portal password. Choose a new password using the button below — the link expires soon and can be used once.</p><p style="margin:24px 0"><a href="${escapeHtml(data.resetUrl)}" style="background:#3f51c4;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Choose a new password</a></p><p style="color:#64748b;font-size:13px">If you did not request this, you can safely ignore this email — your password stays unchanged.</p></div>`;
  return sendMail({ to: data.to, subject, html, text });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface OemConfirmationData {
  to: string;
  contact: string;
  company: string;
  category: string;
  projectId: string;
}

/** Acknowledge a freshly submitted OEM project enquiry to the submitter. */
export function sendOemConfirmationEmail(data: OemConfirmationData): Promise<boolean> {
  const subject = `We received your OEM request (#${data.projectId})`;
  const categoryLine = data.category ? `\n  Category: ${data.category}` : '';
  const text = `Hi ${data.contact},\n\nThank you for submitting an OEM project enquiry to Channel. We have logged your request and our engineering team will review it and respond within 24 hours.\n\n  Reference: #${data.projectId}\n  Company: ${data.company}${categoryLine}\n\nPlease keep this reference number for any follow-up.\n\n— Channel Engineering Team`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto"><h2 style="color:#1f2a73">OEM request received</h2><p>Hi ${escapeHtml(data.contact)},</p><p>Thank you for submitting an OEM project enquiry to Channel. We have logged your request and our engineering team will review it and respond within 24 hours.</p><p style="background:#f6f8fc;padding:12px 16px;border-radius:8px"><strong>Reference:</strong> #${escapeHtml(data.projectId)}<br/><strong>Company:</strong> ${escapeHtml(data.company)}${data.category ? `<br/><strong>Category:</strong> ${escapeHtml(data.category)}` : ''}</p><p>Please keep this reference number for any follow-up.</p><p style="color:#64748b;font-size:13px">— Channel Engineering Team</p></div>`;
  return sendMail({ to: data.to, subject, html, text });
}
