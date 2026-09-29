import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { STAGES } from '@job-tracker/shared';

const applicationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    company: { type: String, required: true, trim: true, maxlength: 200 },
    role: { type: String, required: true, trim: true, maxlength: 200 },
    url: { type: String, trim: true, maxlength: 2000 },
    location: { type: String, trim: true, maxlength: 200 },
    source: { type: String, trim: true, maxlength: 120 },

    stage: { type: String, enum: STAGES, required: true, default: 'wishlist' },

    /**
     * Fractional index. A string, not a number - see packages/shared/ordering.ts
     * for why. Sorting by this string ascending gives the column order.
     */
    order: { type: String, required: true },

    salaryMin: { type: Number, min: 0 },
    salaryMax: { type: Number, min: 0 },
    currency: { type: String, trim: true, uppercase: true, minlength: 3, maxlength: 3 },

    appliedAt: { type: Date, default: null },

    /** Soft delete. Archived applications stay queryable for history. */
    archivedAt: { type: Date, default: null },

    /**
     * Denormalised counter, kept current by the notes service.
     *
     * The board renders a note-count badge on every card. Computing it properly
     * would mean a $lookup across the whole board on every load; storing it costs
     * one $inc per note write. Classic read-heavy tradeoff, and the board is read
     * far more often than notes are written.
     */
    noteCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

/**
 * The board query: every non-archived application for one user, sorted into
 * columns. This compound index serves the filter AND the sort, so Mongo walks
 * the index and never does an in-memory sort.
 *
 * Field order matters and is not arbitrary - equality fields first (userId),
 * then the sort fields (stage, order). Reordering these would make the index
 * useless for this query. That is the ESR rule: Equality, Sort, Range.
 */
applicationSchema.index({ userId: 1, stage: 1, order: 1 });

/** Serves the archived/unarchived split on the list endpoint. */
applicationSchema.index({ userId: 1, archivedAt: 1, updatedAt: -1 });

/**
 * Text index for the board's search box. Weighted so a company-name match ranks
 * above an incidental match in the location field.
 */
applicationSchema.index(
  { company: 'text', role: 'text', location: 'text', source: 'text' },
  { weights: { company: 10, role: 8, location: 2, source: 1 }, name: 'application_text' },
);

export type ApplicationDoc = HydratedDocument<InferSchemaType<typeof applicationSchema>>;
export const Application = model('Application', applicationSchema);
