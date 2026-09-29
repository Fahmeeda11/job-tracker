/**
 * Domain constants shared by the API, the worker and the web app.
 *
 * These live here rather than in the Mongoose model so the React board can
 * render columns from the same source of truth the server validates against.
 * Adding a stage is a one-line change that both sides pick up.
 */

export const STAGES = ['wishlist', 'applied', 'screen', 'onsite', 'offer', 'rejected'] as const;

export type Stage = (typeof STAGES)[number];

/** Column headings for the board, in display order. */
export const STAGE_LABELS: Record<Stage, string> = {
  wishlist: 'Wishlist',
  applied: 'Applied',
  screen: 'Phone Screen',
  onsite: 'Onsite',
  offer: 'Offer',
  rejected: 'Rejected',
};

/**
 * Stages that mean the application is over. Used to grey out cards, to skip
 * follow-up reminders (see apps/worker - firing "nudge them again" for a role you
 * were already rejected from is the kind of small wrong thing that erodes trust
 * in the tool), and to exclude from active-pipeline counts.
 */
export const TERMINAL_STAGES: readonly Stage[] = ['offer', 'rejected'];

export function isTerminalStage(stage: Stage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/** Where an application came from. Free text is allowed; these are the suggestions. */
export const COMMON_SOURCES = [
  'LinkedIn',
  'Referral',
  'Company site',
  'Recruiter',
  'Job board',
  'Cold outreach',
] as const;

/** ISO-4217 codes the UI offers. The schema accepts any 3-letter code. */
export const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'PKR', 'CAD', 'AUD'] as const;

export const DEFAULT_CURRENCY = 'USD';

/** Reminder lead times offered as one-click options in the UI. */
export const REMINDER_PRESETS = [
  { label: 'In 3 days', days: 3 },
  { label: 'In 1 week', days: 7 },
  { label: 'In 2 weeks', days: 14 },
  { label: 'In 1 month', days: 30 },
] as const;
