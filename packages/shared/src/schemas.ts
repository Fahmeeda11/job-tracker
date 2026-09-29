/**
 * The contract between client and server.
 *
 * Every one of these schemas is used TWICE: once by an Express route to validate
 * an incoming request body, and once by a React form via
 * @hookform/resolvers/zod. That is the whole reason this package exists - it is
 * structurally impossible for the form and the endpoint to disagree about what a
 * valid application looks like, because there is only one definition.
 *
 * Types are inferred from the schemas rather than declared alongside them, so
 * they cannot drift either.
 */

import { z } from 'zod';
import { STAGES } from './domain.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Mongo ObjectId as it appears over the wire. */
export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex id');

export const stageSchema = z.enum(STAGES);

/**
 * Accepts either an ISO string or a Date and always produces a Date.
 * JSON has no date type, so the client sends strings; this is the one place that
 * conversion happens.
 */
export const dateSchema = z.union([z.string().datetime(), z.date()]).pipe(z.coerce.date());

const trimmedString = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Password rules kept deliberately simple: length is what actually matters.
 * Composition rules (one uppercase, one symbol...) push people toward
 * "Password1!" and measurably do not help, so they are not imposed here.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'That is suspiciously long');

export const signupSchema = z.object({
  name: trimmedString(120),
  email: z.string().trim().toLowerCase().email(),
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, 'Password is required'),
});

export const publicUserSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  email: z.string().email(),
  createdAt: dateSchema,
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;

/** What POST /auth/login and POST /auth/refresh return. The refresh token itself
 *  is NOT in the body - it is set as an httpOnly cookie and never touches JS. */
export const authResponseSchema = z.object({
  user: publicUserSchema,
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
});

export type AuthResponse = z.infer<typeof authResponseSchema>;

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

const salaryShape = {
  salaryMin: z.number().int().nonnegative().max(100_000_000).optional(),
  salaryMax: z.number().int().nonnegative().max(100_000_000).optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, 'Use a 3-letter currency code')
    .optional(),
};

export const createApplicationSchema = z
  .object({
    company: trimmedString(200),
    role: trimmedString(200),
    url: z.string().trim().url().max(2000).optional().or(z.literal('')),
    location: z.string().trim().max(200).optional(),
    source: z.string().trim().max(120).optional(),
    stage: stageSchema.default('wishlist'),
    appliedAt: dateSchema.optional(),
    ...salaryShape,
  })
  .refine((v) => v.salaryMin === undefined || v.salaryMax === undefined || v.salaryMin <= v.salaryMax, {
    message: 'Minimum salary cannot exceed maximum',
    path: ['salaryMin'],
  });

/** Partial update. `stage` is deliberately absent - moving between stages goes
 *  through the move endpoint so ordering stays consistent. */
export const updateApplicationSchema = z
  .object({
    company: trimmedString(200).optional(),
    role: trimmedString(200).optional(),
    url: z.string().trim().url().max(2000).optional().or(z.literal('')),
    location: z.string().trim().max(200).optional(),
    source: z.string().trim().max(120).optional(),
    appliedAt: dateSchema.nullable().optional(),
    archived: z.boolean().optional(),
    ...salaryShape,
  })
  .refine((v) => v.salaryMin === undefined || v.salaryMax === undefined || v.salaryMin <= v.salaryMax, {
    message: 'Minimum salary cannot exceed maximum',
    path: ['salaryMin'],
  });

/**
 * Moving a card.
 *
 * The client sends the *neighbours* it dropped between, not a computed order key.
 * The server then reads those neighbours and generates the key itself. That
 * matters under concurrency: if someone else moved a card into the same gap a
 * moment ago, the server sees the real current neighbours and still produces a
 * key that sorts correctly, whereas a key the client computed from a stale board
 * could collide or land in the wrong place.
 *
 * `beforeId` is the card immediately above the drop point, `afterId` the one
 * immediately below. Both null means the column was empty.
 */
export const moveApplicationSchema = z.object({
  stage: stageSchema,
  beforeId: objectIdSchema.nullable(),
  afterId: objectIdSchema.nullable(),
});

export const applicationSchema = z.object({
  id: objectIdSchema,
  company: z.string(),
  role: z.string(),
  url: z.string().optional(),
  location: z.string().optional(),
  source: z.string().optional(),
  stage: stageSchema,
  order: z.string(),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
  currency: z.string().optional(),
  appliedAt: dateSchema.nullable().optional(),
  archivedAt: dateSchema.nullable().optional(),
  noteCount: z.number().int().nonnegative().default(0),
  nextReminderAt: dateSchema.nullable().optional(),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type UpdateApplicationInput = z.infer<typeof updateApplicationSchema>;
export type MoveApplicationInput = z.infer<typeof moveApplicationSchema>;
export type Application = z.infer<typeof applicationSchema>;

/** Query string for listing. Coerced because query params arrive as strings. */
export const listApplicationsQuerySchema = z.object({
  includeArchived: z.coerce.boolean().default(false),
  search: z.string().trim().max(200).optional(),
});

export type ListApplicationsQuery = z.infer<typeof listApplicationsQuerySchema>;

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const createNoteSchema = z.object({
  body: trimmedString(5000),
});

export const noteSchema = z.object({
  id: objectIdSchema,
  applicationId: objectIdSchema,
  body: z.string(),
  /** Set when the entry was generated by a stage change rather than typed. */
  kind: z.enum(['note', 'stage_change', 'reminder_sent']).default('note'),
  createdAt: dateSchema,
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type Note = z.infer<typeof noteSchema>;

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export const createReminderSchema = z.object({
  dueAt: dateSchema.refine((d) => d.getTime() > Date.now(), {
    message: 'Reminder must be in the future',
  }),
  message: z.string().trim().max(500).optional(),
});

export const reminderSchema = z.object({
  id: objectIdSchema,
  applicationId: objectIdSchema,
  dueAt: dateSchema,
  message: z.string().optional(),
  status: z.enum(['scheduled', 'sent', 'cancelled', 'failed']),
  sentAt: dateSchema.nullable().optional(),
  createdAt: dateSchema,
});

export type CreateReminderInput = z.infer<typeof createReminderSchema>;
export type Reminder = z.infer<typeof reminderSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every non-2xx response from the API has this shape. The web client's error
 * handler relies on it, so the Express error middleware must never emit
 * anything else - including for unexpected 500s.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.string(),
    /** Field-level messages, keyed by form field name, for 422 validation failures. */
    fields: z.record(z.string(), z.string()).optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
