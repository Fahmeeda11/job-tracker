/**
 * The safety net.
 *
 * The queue is not the source of truth - Mongo is. Reminders can end up due but
 * unqueued for several honest reasons:
 *
 *   - the API wrote the reminder row and then crashed before enqueueing
 *   - Redis lost the job (it is a cache with persistence, not a database)
 *   - the delay exceeded BullMQ's ~24.8-day ceiling and was clamped, so the job
 *     woke early, re-armed itself, and that re-arm was itself lost
 *   - a worker died holding a 'sending' claim
 *
 * So once a minute the sweeper asks the database a simple question - what is due
 * and still waiting? - and re-enqueues anything it finds. Because enqueueing
 * uses the reminder's dedupeKey as the job id, re-adding something already
 * queued is a no-op rather than a duplicate.
 *
 * This is the pattern worth internalising: a queue makes work timely, but only
 * a durable store makes it reliable. Reconcile from the store, use the queue for
 * scheduling.
 */

import type { Queue } from 'bullmq';
import { JOB_NAMES, REMINDER_JOB_OPTIONS, MAX_JOB_DELAY_MS, type SendReminderJob } from '@job-tracker/shared';
import { Reminder } from '@job-tracker/db';
import { childLogger } from './logger.js';
import { CLAIM_STALE_AFTER_MS } from './handlers/sendReminder.js';

const log = childLogger('sweeper');

/** Look this far ahead, so a reminder is queued slightly before it is due. */
const LOOKAHEAD_MS = 120_000;

const BATCH_LIMIT = 500;

export async function sweepOnce(queue: Queue<SendReminderJob>): Promise<number> {
  const now = Date.now();
  const horizon = new Date(now + LOOKAHEAD_MS);
  const staleBefore = new Date(now - CLAIM_STALE_AFTER_MS);

  const due = await Reminder.find({
    dueAt: { $lte: horizon },
    $or: [
      { status: 'scheduled' },
      // Reclaim reminders whose worker died mid-send.
      { status: 'sending', claimedAt: { $lt: staleBefore } },
    ],
  })
    .limit(BATCH_LIMIT)
    .select('_id applicationId userId dedupeKey dueAt status')
    .lean();

  if (due.length === 0) return 0;

  let requeued = 0;

  for (const reminder of due) {
    const delay = Math.min(Math.max(reminder.dueAt.getTime() - now, 0), MAX_JOB_DELAY_MS);

    try {
      // jobId is the dedupeKey, so if this job is already queued BullMQ ignores
      // the add. That is what makes running the sweeper every minute safe.
      await queue.add(
        JOB_NAMES.sendReminder,
        {
          reminderId: String(reminder._id),
          applicationId: String(reminder.applicationId),
          userId: String(reminder.userId),
          dedupeKey: reminder.dedupeKey,
        },
        { ...REMINDER_JOB_OPTIONS, delay, jobId: reminder.dedupeKey },
      );
      requeued += 1;
    } catch (err) {
      log.warn({ err, reminderId: String(reminder._id) }, 'could not requeue reminder');
    }
  }

  if (requeued > 0) {
    log.info({ requeued, found: due.length }, 'sweeper requeued due reminders');
  }

  return requeued;
}

/** Run sweepOnce on an interval. Returns a stop function. */
export function startSweeper(queue: Queue<SendReminderJob>, intervalMs: number): () => void {
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await sweepOnce(queue);
    } catch (err) {
      // A failing sweep must never kill the worker - it is the safety net, and a
      // safety net that crashes the thing it protects is worse than none.
      log.error({ err }, 'sweep failed');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Do not hold the event loop open on shutdown.
  timer.unref();

  // Run one immediately so a restart picks up anything missed while down.
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
