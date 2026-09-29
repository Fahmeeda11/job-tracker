/**
 * The contract between the API (which enqueues) and the worker (which consumes).
 *
 * These are types and constants only - no BullMQ import, no Redis connection.
 * Each process builds its own client; what they share is the agreement about
 * what a job is called and what shape its payload has. Without this the two
 * processes drift, and the failure mode is a job that sits in the queue forever
 * because the worker is listening on a slightly different name.
 */

import { z } from 'zod';

export const QUEUE_NAMES = {
  reminders: 'reminders',
} as const;

export const JOB_NAMES = {
  sendReminder: 'send-reminder',
} as const;

/**
 * Payload for a scheduled follow-up email.
 *
 * `reminderId` is the authority - the worker re-reads the reminder from Mongo
 * before sending rather than trusting the denormalised fields here, because a
 * job scheduled two weeks ago may describe an application whose stage, or whose
 * very existence, has changed since.
 *
 * `dedupeKey` is what makes the send idempotent. See the worker's handler.
 */
export const sendReminderJobSchema = z.object({
  reminderId: z.string(),
  applicationId: z.string(),
  userId: z.string(),
  dedupeKey: z.string(),
});

export type SendReminderJob = z.infer<typeof sendReminderJobSchema>;

/**
 * Retry policy, shared so the API's enqueue and any manual re-enqueue agree.
 *
 * Exponential backoff from 5s. Three attempts is the sweet spot for email: it
 * rides out a transient SMTP blip without spending ten minutes retrying a
 * genuinely rejected address. Because the handler is idempotent, a retry after a
 * send that actually succeeded is harmless.
 */
export const REMINDER_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800 },
} as const;

/** BullMQ caps delays at ~24.8 days (2^31 ms). Longer reminders are re-armed by a sweeper. */
export const MAX_JOB_DELAY_MS = 2_147_483_647;
