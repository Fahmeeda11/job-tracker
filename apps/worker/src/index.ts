/**
 * Worker entry point.
 *
 * A separate process from the API, deliberately. Sending email is slow and can
 * hang; if it shared the API's event loop, one wedged SMTP connection would add
 * latency to every request on the box. Separating them also means the two can be
 * scaled and restarted independently - you can deploy a worker fix without
 * dropping a single HTTP request.
 */

import { Queue, Worker, type Job } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  REMINDER_JOB_OPTIONS,
  MAX_JOB_DELAY_MS,
  type SendReminderJob,
} from '@job-tracker/shared';
import { connectDb, disconnectDb } from '@job-tracker/db';
import { env } from './env.js';
import { logger } from './logger.js';
import { handleSendReminder, markReminderFailed } from './handlers/sendReminder.js';
import { startSweeper } from './sweeper.js';
import { closeMailer } from './mailer.js';

function createConnection(): Redis {
  // maxRetriesPerRequest: null is required by BullMQ - with the default, a Redis
  // blip makes blocking commands throw and the worker stops consuming.
  const client = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  client.on('error', (err) => logger.error({ err }, 'redis error'));
  return client;
}

async function main(): Promise<void> {
  await connectDb(env.MONGO_URI, {
    onEvent: (event, detail) => {
      if (event === 'error') logger.error({ err: detail }, 'mongo connection error');
      else logger.warn({ event }, `mongo ${event}`);
    },
  });
  logger.info('mongo connected');

  const connection = createConnection();

  // The worker needs its own Queue handle to re-arm jobs that woke early.
  const queue = new Queue<SendReminderJob>(QUEUE_NAMES.reminders, { connection });

  const worker = new Worker<SendReminderJob>(
    QUEUE_NAMES.reminders,
    async (job: Job<SendReminderJob>) => {
      const result = await handleSendReminder(job.data);

      if (result.outcome === 're_armed' && result.reArmAt) {
        // The job woke before its due time, because the original delay exceeded
        // BullMQ's 24.8-day ceiling and was clamped. Schedule the next hop.
        const delay = Math.min(Math.max(result.reArmAt.getTime() - Date.now(), 0), MAX_JOB_DELAY_MS);
        await queue.add(JOB_NAMES.sendReminder, job.data, {
          ...REMINDER_JOB_OPTIONS,
          delay,
          // A distinct job id: the original is still occupying the dedupeKey
          // until it completes, and BullMQ refuses a duplicate id.
          jobId: `${job.data.dedupeKey}:rearm:${result.reArmAt.getTime()}`,
        });
      }

      return result;
    },
    {
      connection,
      concurrency: env.WORKER_CONCURRENCY,
      // A send should never take this long; if it does, the job is stalled and
      // should be reclaimed. The handler's stale-claim logic covers the case
      // where the original attempt is still somehow alive.
      lockDuration: 60_000,
    },
  );

  worker.on('completed', (job, result) => {
    logger.debug({ jobId: job.id, outcome: result?.outcome }, 'job completed');
  });

  worker.on('failed', (job, err) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = REMINDER_JOB_OPTIONS.attempts;

    logger.error({ jobId: job?.id, attemptsMade, err }, 'job failed');

    // Out of retries: record it so the reminder does not sit in 'scheduled'
    // forever, being picked up by the sweeper on every pass.
    if (job && attemptsMade >= maxAttempts) {
      void markReminderFailed(job.data.reminderId, err.message).catch((e) =>
        logger.error({ err: e }, 'could not mark reminder failed'),
      );
    }
  });

  worker.on('error', (err) => logger.error({ err }, 'worker error'));

  const stopSweeper = startSweeper(queue, env.SWEEP_INTERVAL_MS);

  logger.info(
    { concurrency: env.WORKER_CONCURRENCY, sweepIntervalMs: env.SWEEP_INTERVAL_MS },
    'worker started',
  );

  /* ---------------------------------------------------------------------- */

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const timeout = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 30_000);
    timeout.unref();

    try {
      stopSweeper();
      // close() waits for in-flight jobs to finish rather than abandoning them
      // mid-send, which would leave reminders stuck in 'sending'.
      await worker.close();
      await queue.close();
      await closeMailer();
      connection.disconnect();
      await disconnectDb();
      clearTimeout(timeout);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
