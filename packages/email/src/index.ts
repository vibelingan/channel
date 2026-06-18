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
    console.log('\n[email:mock] SMTP not configured — email not sent. Contents:');
    console.log(`  to:      ${input.to}`);
    console.log(`  subject: ${input.subject}`);
    console.log(`  text:    ${input.text}\n`);
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

export interface RecoveryEmailData {
  to: string;
  username: string;
  newPassword: string;
  loginUrl: string;
}

/** Send a password-recovery email containing the freshly generated password. */
export function sendRecoveryEmail(data: RecoveryEmailData): Promise<boolean> {
  const subject = 'Your Channel Portal password has been reset';
  const text = `Hi ${data.username},\n\nYour password has been reset. Use the temporary password below to sign in, then change it from your account page.\n\n  Temporary password: ${data.newPassword}\n\nSign in: ${data.loginUrl}\n\nIf you did not request this, please contact us immediately.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto"><h2 style="color:#1f2a73">Password reset</h2><p>Hi ${escapeHtml(data.username)},</p><p>Your password has been reset. Use the temporary password below to sign in, then change it from your account page.</p><p style="font-size:18px;font-weight:700;background:#f6f8fc;padding:12px 16px;border-radius:8px;letter-spacing:1px">${escapeHtml(data.newPassword)}</p><p><a href="${data.loginUrl}" style="color:#3f51c4">Sign in to Channel Portal</a></p><p style="color:#64748b;font-size:13px">If you did not request this, please contact us immediately.</p></div>`;
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
  const text = `Hi ${data.contact},\n\nThank you for submitting an OEM project enquiry to Channel. We have logged your request and our engineering team will review it and respond within one business day.\n\n  Reference: #${data.projectId}\n  Company: ${data.company}${categoryLine}\n\nPlease keep this reference number for any follow-up.\n\n— Channel Engineering Team`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto"><h2 style="color:#1f2a73">OEM request received</h2><p>Hi ${escapeHtml(data.contact)},</p><p>Thank you for submitting an OEM project enquiry to Channel. We have logged your request and our engineering team will review it and respond within one business day.</p><p style="background:#f6f8fc;padding:12px 16px;border-radius:8px"><strong>Reference:</strong> #${escapeHtml(data.projectId)}<br/><strong>Company:</strong> ${escapeHtml(data.company)}${data.category ? `<br/><strong>Category:</strong> ${escapeHtml(data.category)}` : ''}</p><p>Please keep this reference number for any follow-up.</p><p style="color:#64748b;font-size:13px">— Channel Engineering Team</p></div>`;
  return sendMail({ to: data.to, subject, html, text });
}
