/**
 * Application business logic, including the move/reorder path.
 *
 * Everything here scopes by userId. There is no query in this file that could
 * return another user's row, and that is deliberate: tenancy leaks happen when
 * one forgotten filter slips into an otherwise correct codebase, so the rule is
 * that userId is a required argument of every function, never an optional one.
 */

import { Types } from 'mongoose';
import {
  generateKeyBetween,
  type Application as ApplicationDTO,
  type CreateApplicationInput,
  type MoveApplicationInput,
  type Stage,
  type UpdateApplicationInput,
} from '@job-tracker/shared';
import { conflict, notFound } from '../../lib/errors.js';
import { Application, type ApplicationDoc } from '@job-tracker/db';

export function toDTO(doc: ApplicationDoc): ApplicationDTO {
  return {
    id: String(doc._id),
    company: doc.company,
    role: doc.role,
    url: doc.url ?? undefined,
    location: doc.location ?? undefined,
    source: doc.source ?? undefined,
    stage: doc.stage as Stage,
    order: doc.order,
    salaryMin: doc.salaryMin ?? undefined,
    salaryMax: doc.salaryMax ?? undefined,
    currency: doc.currency ?? undefined,
    appliedAt: doc.appliedAt ?? null,
    archivedAt: doc.archivedAt ?? null,
    noteCount: doc.noteCount ?? 0,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function listApplications(
  userId: string,
  options: { includeArchived?: boolean; search?: string } = {},
): Promise<ApplicationDTO[]> {
  const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };

  if (!options.includeArchived) {
    filter['archivedAt'] = null;
  }

  if (options.search) {
    // $text uses the weighted index declared on the model. Falls back to nothing
    // rather than a regex scan - an unanchored regex over a growing collection
    // is a performance cliff waiting to happen.
    filter['$text'] = { $search: options.search };
  }

  // Sorting by (stage, order) lets the compound index satisfy the sort. The
  // client groups into columns; the server does not need to.
  const docs = await Application.find(filter).sort({ stage: 1, order: 1 }).limit(1000);
  return docs.map(toDTO);
}

export async function getApplication(userId: string, id: string): Promise<ApplicationDoc> {
  const doc = await Application.findOne({ _id: id, userId: new Types.ObjectId(userId) });
  // Same 404 whether it does not exist or belongs to someone else. Distinguishing
  // them would let a caller probe for valid ids.
  if (!doc) throw notFound('Application not found');
  return doc;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Create, appending to the bottom of its stage column.
 *
 * Only the current last key in that column is read - one indexed lookup, not a
 * scan of the column - and the new key is generated after it.
 */
export async function createApplication(
  userId: string,
  input: CreateApplicationInput,
): Promise<ApplicationDTO> {
  const stage = input.stage;

  const last = await Application.findOne({ userId: new Types.ObjectId(userId), stage })
    .sort({ order: -1 })
    .select('order')
    .lean();

  const order = generateKeyBetween(last?.order ?? null, null);

  const doc = await Application.create({
    userId: new Types.ObjectId(userId),
    ...input,
    // zod lets '' through as a way of clearing the field; store undefined.
    url: input.url || undefined,
    stage,
    order,
  });

  return toDTO(doc);
}

export async function updateApplication(
  userId: string,
  id: string,
  input: UpdateApplicationInput,
): Promise<ApplicationDTO> {
  const doc = await getApplication(userId, id);

  const { archived, ...fields } = input;

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    // '' means "clear this optional field", which Mongoose stores as unset.
    (doc as unknown as Record<string, unknown>)[key] = value === '' ? undefined : value;
  }

  if (archived !== undefined) {
    doc.archivedAt = archived ? new Date() : null;
  }

  await doc.save();
  return toDTO(doc);
}

/**
 * Move a card: change its stage and/or its position within a column.
 *
 * The client sends the two cards it was dropped between; the server reads those
 * and generates a key strictly between them. Doing the generation here rather
 * than on the client means the key is always computed from the board as it
 * actually is right now, so two people dragging into the same gap concurrently
 * both get valid, distinct keys instead of colliding on a value one of them
 * computed from a stale snapshot.
 *
 * This writes exactly ONE document, whatever the board size. That is the whole
 * payoff of fractional indexing.
 */
export async function moveApplication(
  userId: string,
  id: string,
  input: MoveApplicationInput,
): Promise<ApplicationDTO> {
  const doc = await getApplication(userId, id);
  const { stage, beforeId, afterId } = input;

  // Load the neighbours, scoped to this user so a crafted request cannot use
  // someone else's card as an anchor.
  const neighbourIds = [beforeId, afterId].filter((v): v is string => Boolean(v));
  const neighbours = neighbourIds.length
    ? await Application.find({
        _id: { $in: neighbourIds },
        userId: new Types.ObjectId(userId),
        stage,
      })
        .select('order')
        .lean()
    : [];

  const orderById = new Map(neighbours.map((n) => [String(n._id), n.order]));

  const beforeKey = beforeId ? (orderById.get(beforeId) ?? null) : null;
  const afterKey = afterId ? (orderById.get(afterId) ?? null) : null;

  // A neighbour the client named is gone or moved out of this column, so the
  // board it computed the drop from no longer exists. Rather than guess at an
  // ordering the user did not ask for, tell the client to refetch.
  if ((beforeId && beforeKey === null) || (afterId && afterKey === null)) {
    throw conflict('The board changed while you were dragging. Refresh and try again.');
  }

  // Defensive: if the anchors somehow arrive inverted, generateKeyBetween would
  // throw an OrderKeyError that surfaces as a confusing 409. Catch it here with
  // a message that says what to do.
  if (beforeKey !== null && afterKey !== null && beforeKey >= afterKey) {
    throw conflict('The board changed while you were dragging. Refresh and try again.');
  }

  doc.stage = stage;
  doc.order = generateKeyBetween(beforeKey, afterKey);

  // Moving out of the wishlist is the moment an application becomes real, so
  // stamp appliedAt if it has not been set. Small touch, but it means the
  // "applied this week" count is right without the user maintaining a date.
  if (stage !== 'wishlist' && !doc.appliedAt) {
    doc.appliedAt = new Date();
  }

  await doc.save();
  return toDTO(doc);
}

export async function deleteApplication(userId: string, id: string): Promise<void> {
  const result = await Application.deleteOne({ _id: id, userId: new Types.ObjectId(userId) });
  if (result.deletedCount === 0) throw notFound('Application not found');
}

/**
 * Repair a column whose keys have become unusable.
 *
 * Fractional keys grow when people repeatedly insert into the same gap. They
 * never *break*, but after enough churn they get long, and long keys make the
 * index bigger and comparisons slower. This rewrites one column's keys to a
 * fresh evenly-spaced set.
 *
 * Nothing calls this on a schedule. It is here because "what happens when the
 * keys get long" is the first question anyone asks about fractional indexing,
 * and the answer should be a function you can point at rather than a shrug.
 */
export async function normaliseColumn(userId: string, stage: Stage): Promise<number> {
  const docs = await Application.find({ userId: new Types.ObjectId(userId), stage })
    .sort({ order: 1 })
    .select('_id');

  if (docs.length === 0) return 0;

  const { generateNKeysBetween } = await import('@job-tracker/shared');
  const keys = generateNKeysBetween(null, null, docs.length);

  await Application.bulkWrite(
    docs.map((doc, i) => ({
      updateOne: { filter: { _id: doc._id }, update: { $set: { order: keys[i] as string } } },
    })),
  );

  return docs.length;
}
