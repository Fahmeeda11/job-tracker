import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { createNoteSchema, objectIdSchema, type Note as NoteDTO } from '@job-tracker/shared';
import { validateBody } from '../../middleware/validate.js';
import { requireAuth, currentUserId } from '../../middleware/auth.js';
import { notFound } from '../../lib/errors.js';
import { Application } from '../applications/model.js';
import { Note, type NoteDoc } from './model.js';

/** mergeParams so :applicationId from the parent mount is visible here. */
export const notesRouter = Router({ mergeParams: true });

notesRouter.use(requireAuth);

const appIdParam = z.object({ applicationId: objectIdSchema });
const noteIdParam = z.object({ applicationId: objectIdSchema, id: objectIdSchema });

function toDTO(doc: NoteDoc): NoteDTO {
  return {
    id: String(doc._id),
    applicationId: String(doc.applicationId),
    body: doc.body,
    kind: doc.kind as NoteDTO['kind'],
    createdAt: doc.createdAt as Date,
  };
}

/** Confirm the application exists AND belongs to this user before touching notes. */
async function assertOwnsApplication(userId: string, applicationId: string): Promise<void> {
  const exists = await Application.exists({
    _id: applicationId,
    userId: new Types.ObjectId(userId),
  });
  if (!exists) throw notFound('Application not found');
}

/* -------------------------------------------------------------------------- */

notesRouter.get('/', async (req, res) => {
  const { applicationId } = appIdParam.parse(req.params);
  const userId = currentUserId(req);
  await assertOwnsApplication(userId, applicationId);

  const notes = await Note.find({ applicationId }).sort({ createdAt: -1 }).limit(500);
  res.json({ notes: notes.map(toDTO) });
});

notesRouter.post('/', validateBody(createNoteSchema), async (req, res) => {
  const { applicationId } = appIdParam.parse(req.params);
  const userId = currentUserId(req);
  await assertOwnsApplication(userId, applicationId);

  const { body } = req.body as typeof createNoteSchema._output;

  const note = await Note.create({
    applicationId,
    userId: new Types.ObjectId(userId),
    body,
    kind: 'note',
  });

  // Keep the denormalised badge count on the card in step.
  await Application.updateOne({ _id: applicationId }, { $inc: { noteCount: 1 } });

  res.status(201).json({ note: toDTO(note) });
});

notesRouter.delete('/:id', async (req, res) => {
  const { applicationId, id } = noteIdParam.parse(req.params);
  const userId = currentUserId(req);

  const result = await Note.deleteOne({
    _id: id,
    applicationId,
    userId: new Types.ObjectId(userId),
  });
  if (result.deletedCount === 0) throw notFound('Note not found');

  // $inc with a guard so a double-delete cannot drive the counter negative.
  await Application.updateOne(
    { _id: applicationId, noteCount: { $gt: 0 } },
    { $inc: { noteCount: -1 } },
  );

  res.status(204).end();
});

/* -------------------------------------------------------------------------- */

/**
 * Record a system event on the timeline. Called by the applications service on a
 * stage change and by the worker after a reminder goes out.
 */
export async function recordSystemNote(
  applicationId: Types.ObjectId | string,
  userId: Types.ObjectId | string,
  body: string,
  kind: 'stage_change' | 'reminder_sent',
): Promise<void> {
  await Note.create({ applicationId, userId, body, kind });
  await Application.updateOne({ _id: applicationId }, { $inc: { noteCount: 1 } });
}
