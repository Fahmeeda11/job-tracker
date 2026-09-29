import crypto from 'node:crypto';
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const reminderSchema = new Schema(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    dueAt: { type: Date, required: true },
    message: { type: String, trim: true, maxlength: 500 },

    status: {
      type: String,
      enum: ['scheduled', 'sent', 'cancelled', 'failed'],
      default: 'scheduled',
      required: true,
    },

    sentAt: { type: Date, default: null },
    failureReason: { type: String, maxlength: 500 },
    attempts: { type: Number, default: 0 },

    /**
     * Idempotency key, derived deterministically from the reminder's content
     * (see buildDedupeKey). Two identical "remind me about this application at
     * this time" requests produce the same key, and the unique index below makes
     * the second one a no-op instead of a second email.
     *
     * It is also used verbatim as the BullMQ job id, so the queue refuses a
     * duplicate enqueue for the same reason.
     *
     * This is the FIRST of two layers. It stops duplicate *requests*. It does
     * nothing about a worker retry after a send that already succeeded - that is
     * handled by the atomic status transition in the worker.
     */
    dedupeKey: { type: String, required: true },
  },
  { timestamps: true },
);

reminderSchema.index({ dedupeKey: 1 }, { unique: true });

/** The worker's sweeper query: what is due and still waiting to go out. */
reminderSchema.index({ status: 1, dueAt: 1 });

/** Show upcoming reminders on an application. */
reminderSchema.index({ applicationId: 1, status: 1, dueAt: 1 });

/**
 * Deterministic dedupe key.
 *
 * Truncated to the minute: two clicks a few hundred milliseconds apart would
 * otherwise produce different ISO strings and therefore different keys, which is
 * precisely the double-submit this is meant to absorb. Minute granularity means
 * a user genuinely wanting two reminders 30 seconds apart cannot have them -
 * an acceptable trade for making the common accident impossible.
 */
export function buildDedupeKey(
  applicationId: string,
  dueAt: Date,
  message: string | undefined,
): string {
  const minute = new Date(dueAt);
  minute.setSeconds(0, 0);
  return crypto
    .createHash('sha256')
    .update(`${applicationId}:${minute.toISOString()}:${message ?? ''}`)
    .digest('hex');
}

export type ReminderDoc = HydratedDocument<InferSchemaType<typeof reminderSchema>>;
export const Reminder = model('Reminder', reminderSchema);
