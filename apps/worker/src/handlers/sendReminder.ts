/**
 * Send one follow-up reminder.
 *
 * IDEMPOTENCY
 * ===========
 * This is the part worth reading carefully, because "the job ran twice and the
 * user got two emails" is the single most common bug in queue-backed systems,
 * and it is not fixed by being careful - it has to be designed against.
 *
 * BullMQ, like essentially every queue, gives *at-least-once* delivery. A job
 * can run more than once for reasons that have nothing to do with your code:
 *
 *   - the handler succeeded but the worker died before acking
 *   - the job exceeded its lock duration and was reclaimed as stalled
 *   - a retry fired after a transient failure that had, in fact, already sent
 *   - two workers are running (which is the entire point of having workers)
 *
 * So the handler must be safe to run twice. There are two layers:
 *
 *   1. The API side gives each reminder a deterministic dedupeKey and uses it as
 *      the BullMQ job id, so a double-submitted form cannot enqueue twice.
 *      That stops duplicate *requests*. It does nothing about the list above.
 *
 *   2. This handler CLAIMS the reminder with an atomic, conditional update
 *      before it touches SMTP:
 *
 *          findOneAndUpdate({ _id, status: 'scheduled' }, { status: 'sending' })
 *
 *      The filter is the lock. Mongo applies a single-document update
 *      atomically, so of N concurrent attempts exactly one matches a document
 *      whose status is still 'scheduled'; the rest get null back and return
 *      without sending. No distributed lock, no Redis mutex - just a conditional
 *      write against the state we already had to store.
 *
 * The residual risk is honest and worth naming: if the process dies *between*
 * SMTP accepting the message and the status write landing, the reminder is stuck
 * in 'sending' and the sweeper will eventually retry it, producing a duplicate.
 * Closing that window entirely needs a transactional outbox. For a follow-up
 * nudge, a rare duplicate is a far better trade than the complexity - but it is
 * a deliberate trade, not an oversight.
 */

import { Types } from 'mongoose';
import {
  sendReminderJobSchema,
  isTerminalStage,
  type SendReminderJob,
  type Stage,
} from '@job-tracker/shared';
import { Application, Note, Reminder, User } from '@job-tracker/db';
import { childLogger } from '../logger.js';
import { sendMail } from '../mailer.js';
import { env } from '../env.js';

const log = childLogger('send-reminder');

/**
 * How early a job may run before we treat it as premature.
 *
 * BullMQ delays are not exact, and long reminders get clamped to the 24.8-day
 * ceiling on the API side, so a job can legitimately wake early. Anything more
 * than this far ahead of its due time is re-armed rather than sent.
 */
const EARLY_TOLERANCE_MS = 30_000;

/** A 'sending' claim older than this is assumed to belong to a dead worker. */
export const CLAIM_STALE_AFTER_MS = 5 * 60_000;

export type ReminderOutcome =
  | 'sent'
  | 'skipped_not_scheduled'
  | 'skipped_cancelled'
  | 'skipped_terminal_stage'
  | 'skipped_missing'
  | 're_armed';

export interface HandlerResult {
  outcome: ReminderOutcome;
  /** Set when the job woke early and needs re-arming at this time. */
  reArmAt?: Date;
}

export async function handleSendReminder(rawPayload: unknown): Promise<HandlerResult> {
  const payload: SendReminderJob = sendReminderJobSchema.parse(rawPayload);

  // Always re-read. The payload was written when the reminder was created, which
  // may have been weeks ago; the world has moved on since.
  const reminder = await Reminder.findById(payload.reminderId);

  if (!reminder) {
    // The reminder was hard-deleted. Nothing to do, and nothing to retry -
    // returning normally (rather than throwing) is what stops BullMQ retrying
    // a job that can never succeed.
    log.info({ reminderId: payload.reminderId }, 'reminder no longer exists, skipping');
    return { outcome: 'skipped_missing' };
  }

  if (reminder.status === 'cancelled') {
    log.info({ reminderId: payload.reminderId }, 'reminder cancelled, skipping');
    return { outcome: 'skipped_cancelled' };
  }

  if (reminder.status === 'sent') {
    // The idempotency guard doing its job: a retry after a successful send.
    log.info({ reminderId: payload.reminderId }, 'reminder already sent, skipping');
    return { outcome: 'skipped_not_scheduled' };
  }

  // Woke early - either BullMQ imprecision or a delay that was clamped at
  // enqueue time because it exceeded the 24.8-day ceiling.
  const msUntilDue = reminder.dueAt.getTime() - Date.now();
  if (msUntilDue > EARLY_TOLERANCE_MS) {
    log.info(
      { reminderId: payload.reminderId, msUntilDue },
      'woke before due time, re-arming',
    );
    return { outcome: 're_armed', reArmAt: reminder.dueAt };
  }

  const application = await Application.findById(reminder.applicationId);
  if (!application) {
    reminder.status = 'cancelled';
    await reminder.save();
    log.info({ reminderId: payload.reminderId }, 'application gone, cancelling reminder');
    return { outcome: 'skipped_missing' };
  }

  /**
   * Do not nudge someone to follow up on a role they already heard back about.
   * Small thing, but an "chase them up!" email about a rejection you already
   * processed is precisely the kind of wrong-feeling detail that makes people
   * stop trusting a tool.
   */
  if (isTerminalStage(application.stage as Stage) || application.archivedAt) {
    reminder.status = 'cancelled';
    await reminder.save();
    log.info(
      { reminderId: payload.reminderId, stage: application.stage },
      'application is closed, cancelling reminder',
    );
    return { outcome: 'skipped_terminal_stage' };
  }

  /* ---------------------------------------------------------------------- */
  /* The claim. Everything above is a read; this is where the race is won.   */
  /* ---------------------------------------------------------------------- */

  const staleBefore = new Date(Date.now() - CLAIM_STALE_AFTER_MS);

  const claimed = await Reminder.findOneAndUpdate(
    {
      _id: reminder._id,
      // Claimable if nobody holds it, OR if the holder's claim has gone stale
      // (their process died mid-send and will never finish).
      $or: [
        { status: 'scheduled' },
        { status: 'sending', claimedAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: { status: 'sending', claimedAt: new Date() },
      $inc: { attempts: 1 },
    },
    { new: true },
  );

  if (!claimed) {
    // Someone else holds a fresh claim. Not an error - this is the guard working.
    log.info({ reminderId: payload.reminderId }, 'reminder claimed by another attempt, skipping');
    return { outcome: 'skipped_not_scheduled' };
  }

  /* ---------------------------------------------------------------------- */

  const user = await User.findById(reminder.userId);
  if (!user) {
    claimed.status = 'cancelled';
    await claimed.save();
    return { outcome: 'skipped_missing' };
  }

  const subject = `Follow up: ${application.role} at ${application.company}`;
  const body = buildReminderBody({
    userName: user.name,
    company: application.company,
    role: application.role,
    stage: application.stage as Stage,
    message: claimed.message ?? undefined,
    appUrl: env.APP_URL,
    applicationId: String(application._id),
  });

  try {
    const result = await sendMail({
      to: user.email,
      subject,
      text: body.text,
      html: body.html,
    });

    claimed.status = 'sent';
    claimed.sentAt = new Date();
    claimed.claimedAt = null;
    await claimed.save();

    // Record it on the application timeline so the user can see, weeks later,
    // that they were nudged and when.
    await recordReminderNote(application._id, reminder.userId, subject);

    log.info(
      { reminderId: payload.reminderId, messageId: result.messageId, previewUrl: result.previewUrl },
      'reminder sent',
    );

    return { outcome: 'sent' };
  } catch (err) {
    // Release the claim so a retry can pick it up, then rethrow so BullMQ counts
    // the attempt and applies its backoff. Leaving it in 'sending' would block
    // every retry until the stale-claim window expired.
    claimed.status = 'scheduled';
    claimed.claimedAt = null;
    claimed.failureReason = err instanceof Error ? err.message.slice(0, 500) : 'unknown error';
    await claimed.save();

    log.error({ err, reminderId: payload.reminderId }, 'failed to send reminder');
    throw err;
  }
}

/** Mark a reminder permanently failed. Called once BullMQ exhausts its retries. */
export async function markReminderFailed(reminderId: string, reason: string): Promise<void> {
  await Reminder.updateOne(
    { _id: reminderId, status: { $in: ['scheduled', 'sending'] } },
    { $set: { status: 'failed', claimedAt: null, failureReason: reason.slice(0, 500) } },
  );
}

async function recordReminderNote(
  applicationId: Types.ObjectId,
  userId: Types.ObjectId,
  subject: string,
): Promise<void> {
  await Note.create({
    applicationId,
    userId,
    body: `Reminder sent: ${subject}`,
    kind: 'reminder_sent',
  });
  await Application.updateOne({ _id: applicationId }, { $inc: { noteCount: 1 } });
}

/* -------------------------------------------------------------------------- */

interface ReminderBodyInput {
  userName: string;
  company: string;
  role: string;
  stage: Stage;
  message: string | undefined;
  appUrl: string;
  applicationId: string;
}

export function buildReminderBody(input: ReminderBodyInput): { text: string; html: string } {
  const link = `${input.appUrl.replace(/\/$/, '')}/board?application=${input.applicationId}`;
  const note = input.message ? `\n\nYour note: ${input.message}` : '';

  const text = [
    `Hi ${input.userName},`,
    '',
    `Time to follow up on ${input.role} at ${input.company}.`,
    `It is currently sitting in your "${input.stage}" column.${note}`,
    '',
    `Open it: ${link}`,
  ].join('\n');

  const html = [
    `<p>Hi ${escapeHtml(input.userName)},</p>`,
    `<p>Time to follow up on <strong>${escapeHtml(input.role)}</strong> at `,
    `<strong>${escapeHtml(input.company)}</strong>.</p>`,
    `<p>It is currently sitting in your &ldquo;${escapeHtml(input.stage)}&rdquo; column.</p>`,
    input.message ? `<blockquote>${escapeHtml(input.message)}</blockquote>` : '',
    `<p><a href="${escapeHtml(link)}">Open the application</a></p>`,
  ].join('');

  return { text, html };
}

/** User-supplied text goes into an HTML email; escape it. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
