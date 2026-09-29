/**
 * Email delivery.
 *
 * Development uses Ethereal: nodemailer creates a throwaway inbox on demand and
 * every send returns a preview URL you can open in a browser. No credentials to
 * configure, no risk of a test run mailing a real person, and the reminder
 * pipeline is still genuinely exercised end to end over real SMTP.
 *
 * Production swaps the transport for real SMTP or Resend. Nothing above this
 * module changes - the handler calls sendMail() and does not know or care.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { env, isTest } from './env.js';
import { childLogger } from './logger.js';

const log = childLogger('mailer');

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendResult {
  messageId: string;
  /** Ethereal only: a browser-viewable link to the message that was "sent". */
  previewUrl?: string;
}

let transporter: Transporter | null = null;

/** Replaceable for tests - see setMailSender. */
type Sender = (message: MailMessage) => Promise<SendResult>;
let overrideSender: Sender | null = null;

/**
 * Swap the sender out. Tests use this to assert on what would have been sent
 * without standing up SMTP, which keeps the idempotency tests fast and, more
 * importantly, lets them count sends exactly.
 */
export function setMailSender(sender: Sender | null): void {
  overrideSender = sender;
}

async function getTransporter(): Promise<Transporter> {
  if (transporter) return transporter;

  if (env.MAIL_TRANSPORT === 'ethereal') {
    const account = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass },
    });
    log.info(
      { user: account.user },
      'using Ethereal test inbox - every send prints a preview URL',
    );
    return transporter;
  }

  if (env.MAIL_TRANSPORT === 'resend') {
    // Resend speaks SMTP, so no extra SDK is needed. The username is literally
    // the string "resend"; the API key is the password.
    transporter = nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: { user: 'resend', pass: env.RESEND_API_KEY as string },
    });
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST as string,
    port: env.SMTP_PORT ?? 587,
    secure: (env.SMTP_PORT ?? 587) === 465,
    auth: { user: env.SMTP_USER as string, pass: env.SMTP_PASS as string },
  });
  return transporter;
}

export async function sendMail(message: MailMessage): Promise<SendResult> {
  if (overrideSender) return overrideSender(message);

  if (isTest) {
    // Belt and braces: even if a test forgets to install a sender, never open a
    // real SMTP connection from the suite.
    log.debug({ to: message.to, subject: message.subject }, 'mail suppressed in test');
    return { messageId: `test-${Date.now()}` };
  }

  const tx = await getTransporter();
  const info = await tx.sendMail({
    from: env.MAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  });

  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    log.info({ previewUrl }, 'reminder sent - open the preview URL to read it');
  }

  return {
    messageId: info.messageId,
    ...(previewUrl ? { previewUrl } : {}),
  };
}

export async function closeMailer(): Promise<void> {
  transporter?.close();
  transporter = null;
}
