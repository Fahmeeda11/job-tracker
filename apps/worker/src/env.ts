/**
 * Worker configuration.
 *
 * Separate from the API's env even though the two overlap, because the worker is
 * a separately deployable process with a genuinely different surface: it needs
 * mail credentials and concurrency settings, and it has no use for JWT secrets
 * or a web origin. Sharing one giant schema would force the worker to carry
 * secrets it never uses - and anything a process does not need, it should not
 * have.
 */

import { z } from 'zod';
import { loadEnvFile } from './loadEnvFile.js';

// Must run BEFORE the schema below reads process.env.
const loadedFrom = loadEnvFile();

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    MONGO_URI: z.string().min(1, 'is required'),
    REDIS_URL: z.string().min(1, 'is required'),

    /** How many reminders may be in flight at once. */
    WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(5),

    /** How often the sweeper looks for reminders the queue may have lost. */
    SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

    MAIL_TRANSPORT: z.enum(['ethereal', 'smtp', 'resend']).default('ethereal'),
    MAIL_FROM: z.string().default('Job Tracker <noreply@job-tracker.local>'),
    APP_URL: z.string().url().default('http://localhost:5173'),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),

    RESEND_API_KEY: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.MAIL_TRANSPORT === 'smtp' && (!cfg.SMTP_HOST || !cfg.SMTP_USER || !cfg.SMTP_PASS)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MAIL_TRANSPORT=smtp requires SMTP_HOST, SMTP_USER and SMTP_PASS',
        path: ['MAIL_TRANSPORT'],
      });
    }
    if (cfg.MAIL_TRANSPORT === 'resend' && !cfg.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MAIL_TRANSPORT=resend requires RESEND_API_KEY',
        path: ['MAIL_TRANSPORT'],
      });
    }
    if (cfg.NODE_ENV === 'production' && cfg.MAIL_TRANSPORT === 'ethereal') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'MAIL_TRANSPORT=ethereal in production would silently swallow every reminder - ' +
          'mail goes to a throwaway test inbox nobody reads',
        path: ['MAIL_TRANSPORT'],
      });
    }
  });

export type WorkerEnv = z.infer<typeof envSchema>;

function loadEnv(): WorkerEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    console.error(
      [
        '',
        'Invalid worker configuration:',
        ...lines,
        '',
        loadedFrom
          ? `Loaded from: ${loadedFrom}`
          : 'No .env file found - relying on the real environment.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
