import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Timeline entries on an application.
 *
 * `kind` distinguishes what the user typed from what the system recorded, so the
 * UI can render a stage change or a sent reminder differently from a note -
 * and so the timeline tells the whole story of an application in one list rather
 * than making the user correlate three separate views.
 */
const noteSchema = new Schema(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true },
    // Denormalised so a note can be authorised without loading its application.
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    body: { type: String, required: true, trim: true, maxlength: 5000 },
    kind: {
      type: String,
      enum: ['note', 'stage_change', 'reminder_sent'],
      default: 'note',
      required: true,
    },
  },
  { timestamps: true },
);

/** Timeline read: one application's entries, newest first. */
noteSchema.index({ applicationId: 1, createdAt: -1 });

export type NoteDoc = HydratedDocument<InferSchemaType<typeof noteSchema>>;
export const Note = model('Note', noteSchema);
