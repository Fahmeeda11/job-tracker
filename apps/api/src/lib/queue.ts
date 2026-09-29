/**
 * Redis connection and the reminders queue (producer side).
 *
 * The API only ever *enqueues*. Processing lives in apps/worker as a separate
 * process, which is the point of the exercise: a slow or crashing email send
 * must not be able to take down the request path, and the worker must be able to
 * scale (or be restarted) independently of the API.
 */

import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  REMINDER_JOB_OPTIONS,
  MAX_JOB_DELAY_MS,
  type SendReminderJob,
} from '@job-tracker/shared';
import { env } from './env.js';
import { childLogger } from './logger.js';

const log = childLogger('queue');

/**
 * BullMQ requires maxRetriesPerRequest: null on its connections - with the
 * default, a Redis blip makes blocking commands throw and the queue wedges.
 */
export function createRedis(url: string = env.REDIS_URL): Redis {
  const client = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  client.on('error', (err) => log.error({ err }, 'redis error'));
  return client;
}

let connection: Redis | null = null;
let remindersQueue: Queue<SendReminderJob> | null = null;

export function getRedis(): Redis {
  connection ??= createRedis();
  return connection;
}

export function getRemindersQueue(): Queue<SendReminderJob> {
  remindersQueue ??= new Queue<SendReminderJob>(QUEUE_NAMES.reminders, {
    connection: getRedis(),
  });
  return remindersQueue;
}

/**
 * Schedule a reminder email for a specific moment.
 *
 * Two things worth noticing:
 *
 * 1. `jobId` is set to the dedupe key. BullMQ refuses to add a second job with
 *    an id that already exists, so a double-submitted form or a retried request
 *    cannot produce two scheduled sends. This is the cheap half of idempotency;
 *    the expensive half (surviving a *worker* retry) is handled in the worker.
 *
 * 2. BullMQ's delay is a 32-bit millisecond value, so anything beyond ~24.8 days
 *    silently overflows. Rather than let a "remind me in 3 months" reminder fire
 *    immediately, we clamp: the job wakes early, sees it is not due, and re-arms
 *    itself. See the worker's handler.
 */
export async function scheduleReminder(payload: SendReminderJob, dueAt: Date): Promise<string> {
  const rawDelay = dueAt.getTime() - Date.now();
  const delay = Math.min(Math.max(rawDelay, 0), MAX_JOB_DELAY_MS);

  const job = await getRemindersQueue().add(JOB_NAMES.sendReminder, payload, {
    ...REMINDER_JOB_OPTIONS,
    delay,
    jobId: payload.dedupeKey,
  });

  log.info(
    { reminderId: payload.reminderId, dueAt, delay, clamped: delay !== rawDelay },
    'reminder scheduled',
  );

  return job.id ?? payload.dedupeKey;
}

/**
 * Remove a scheduled job. Called when a reminder is cancelled or its application
 * is deleted. Missing jobs are not an error - the job may have already run, and
 * "cancel something that already happened" should be a no-op, not a 500.
 */
export async function cancelScheduledReminder(dedupeKey: string): Promise<void> {
  const job = await getRemindersQueue().getJob(dedupeKey);
  if (!job) return;
  try {
    await job.remove();
    log.info({ dedupeKey }, 'scheduled reminder removed');
  } catch (err) {
    // Removing a job that is mid-execution throws; the worker's own guard will
    // notice the reminder is cancelled and skip the send.
    log.warn({ err, dedupeKey }, 'could not remove job, worker will skip it instead');
  }
}

export async function closeQueue(): Promise<void> {
  await remindersQueue?.close();
  remindersQueue = null;
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
