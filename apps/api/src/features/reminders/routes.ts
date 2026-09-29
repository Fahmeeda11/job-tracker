import { Router } from 'express';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { createReminderSchema, objectIdSchema, type Reminder as ReminderDTO } from '@job-tracker/shared';
import { validateBody } from '../../middleware/validate.js';
import { requireAuth, currentUserId } from '../../middleware/auth.js';
import { notFound } from '../../lib/errors.js';
import { cancelScheduledReminder, scheduleReminder } from '../../lib/queue.js';
import { childLogger } from '../../lib/logger.js';
import { Application, buildDedupeKey, Reminder, type ReminderDoc } from '@job-tracker/db';

const log = childLogger('reminders');

export const remindersRouter = Router({ mergeParams: true });

remindersRouter.use(requireAuth);

const appIdParam = z.object({ applicationId: objectIdSchema });
const reminderIdParam = z.object({ applicationId: objectIdSchema, id: objectIdSchema });

function toDTO(doc: ReminderDoc): ReminderDTO {
  return {
    id: String(doc._id),
    applicationId: String(doc.applicationId),
    dueAt: doc.dueAt,
    message: doc.message ?? undefined,
    status: doc.status as ReminderDTO['status'],
    sentAt: doc.sentAt ?? null,
    createdAt: doc.createdAt as Date,
  };
}

async function assertOwnsApplication(userId: string, applicationId: string): Promise<void> {
  const exists = await Application.exists({
    _id: applicationId,
    userId: new Types.ObjectId(userId),
  });
  if (!exists) throw notFound('Application not found');
}

/* -------------------------------------------------------------------------- */

remindersRouter.get('/', async (req, res) => {
  const { applicationId } = appIdParam.parse(req.params);
  await assertOwnsApplication(currentUserId(req), applicationId);

  const reminders = await Reminder.find({ applicationId }).sort({ dueAt: 1 }).limit(100);
  res.json({ reminders: reminders.map(toDTO) });
});

/* -------------------------------------------------------------------------- */

/**
 * Schedule a follow-up.
 *
 * Order of operations matters here. The reminder row is written FIRST, then the
 * job is enqueued. If it were the other way round, a crash between the two would
 * leave a job in the queue pointing at a reminder that does not exist, and the
 * worker would have to treat "reminder missing" as a possibly-transient error.
 *
 * With this ordering the failure mode is a row with no job - which the worker's
 * periodic sweeper picks up. A missed email that arrives late beats a job that
 * can never succeed.
 */
remindersRouter.post('/', validateBody(createReminderSchema), async (req, res) => {
  const { applicationId } = appIdParam.parse(req.params);
  const userId = currentUserId(req);
  await assertOwnsApplication(userId, applicationId);

  const { dueAt, message } = req.body as typeof createReminderSchema._output;
  const dedupeKey = buildDedupeKey(applicationId, dueAt, message);

  let reminder: ReminderDoc;

  try {
    reminder = await Reminder.create({
      applicationId,
      userId: new Types.ObjectId(userId),
      dueAt,
      message,
      dedupeKey,
      status: 'scheduled',
    });
  } catch (err) {
    // Duplicate dedupeKey: this exact reminder already exists. Return it with a
    // 200 rather than a 409 - the caller asked for a reminder and a reminder
    // exists, so from their side the request succeeded. That is what makes the
    // endpoint safely retryable.
    if (err instanceof mongoose.mongo.MongoServerError && err.code === 11000) {
      const existing = await Reminder.findOne({ dedupeKey });
      if (existing) {
        log.info({ dedupeKey }, 'duplicate reminder request absorbed');
        res.status(200).json({ reminder: toDTO(existing), deduplicated: true });
        return;
      }
    }
    throw err;
  }

  await scheduleReminder(
    {
      reminderId: String(reminder._id),
      applicationId,
      userId,
      dedupeKey,
    },
    dueAt,
  );

  res.status(201).json({ reminder: toDTO(reminder) });
});

/* -------------------------------------------------------------------------- */

remindersRouter.delete('/:id', async (req, res) => {
  const { applicationId, id } = reminderIdParam.parse(req.params);
  const userId = currentUserId(req);

  const reminder = await Reminder.findOne({
    _id: id,
    applicationId,
    userId: new Types.ObjectId(userId),
  });
  if (!reminder) throw notFound('Reminder not found');

  // Mark cancelled first. Even if removing the queued job fails, the worker
  // re-reads this row before sending and will skip it - the database is the
  // authority, not the queue.
  if (reminder.status === 'scheduled') {
    reminder.status = 'cancelled';
    await reminder.save();
  }

  await cancelScheduledReminder(reminder.dedupeKey);

  res.status(204).end();
});
