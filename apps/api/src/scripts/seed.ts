/**
 * Seed a demo account with a realistic board.
 *
 *   npm run seed
 *
 * Idempotent: running it twice wipes the demo user's data and rebuilds it,
 * rather than producing a board with everything on it twice. Only ever touches
 * the demo account - your own data is never in scope.
 */

import { generateNKeysBetween, STAGES, type Stage } from '@job-tracker/shared';
import { Application, Note, Reminder, User, connectDb, disconnectDb } from '@job-tracker/db';
import { env } from '../lib/env.js';
import { hashPassword } from '../features/auth/service.js';

const DEMO_EMAIL = 'demo@job-tracker.local';
const DEMO_PASSWORD = 'demo-password-1234';

interface SeedRow {
  company: string;
  role: string;
  stage: Stage;
  location?: string;
  source?: string;
  salaryMin?: number;
  salaryMax?: number;
  daysAgo?: number;
  notes?: string[];
}

const ROWS: SeedRow[] = [
  { company: 'Vercel', role: 'Senior Full Stack Engineer', stage: 'wishlist', location: 'Remote', source: 'Company site', salaryMin: 160000, salaryMax: 200000 },
  { company: 'Linear', role: 'Product Engineer', stage: 'wishlist', location: 'Remote (EU)', source: 'Referral' },
  { company: 'Supabase', role: 'Backend Engineer', stage: 'wishlist', location: 'Remote', source: 'LinkedIn' },

  { company: 'Stripe', role: 'Infrastructure Engineer', stage: 'applied', location: 'Dublin', source: 'LinkedIn', salaryMin: 140000, salaryMax: 180000, daysAgo: 12, notes: ['Applied through the careers page. Referred by someone on the payments team.'] },
  { company: 'Figma', role: 'Frontend Engineer', stage: 'applied', location: 'London', source: 'Job board', daysAgo: 8 },
  { company: 'Cloudflare', role: 'Systems Engineer', stage: 'applied', location: 'Remote', source: 'Recruiter', daysAgo: 5 },

  { company: 'MongoDB', role: 'Developer Advocate', stage: 'screen', location: 'Remote', source: 'Referral', salaryMin: 130000, salaryMax: 155000, daysAgo: 18, notes: ['30 min call with the hiring manager on Tuesday.', 'They asked a lot about aggregation pipelines - worth revising $facet.'] },
  { company: 'Railway', role: 'Platform Engineer', stage: 'screen', location: 'Remote', source: 'Cold outreach', daysAgo: 14 },

  { company: 'Shopify', role: 'Staff Engineer', stage: 'onsite', location: 'Remote', source: 'Recruiter', salaryMin: 190000, salaryMax: 230000, daysAgo: 30, notes: ['Four rounds: system design, coding, past projects, values.', 'System design round is about a multi-tenant inventory service.'] },

  { company: 'Datadog', role: 'Senior Engineer', stage: 'offer', location: 'Paris', source: 'LinkedIn', salaryMin: 170000, salaryMax: 170000, daysAgo: 45, notes: ['Offer received. Need to respond by the end of next week.'] },

  { company: 'Airbnb', role: 'Full Stack Engineer', stage: 'rejected', location: 'Remote', source: 'Job board', daysAgo: 60, notes: ['Rejected after the final round. Feedback: wanted deeper mobile experience.'] },
  { company: 'Notion', role: 'Product Engineer', stage: 'rejected', location: 'Remote', source: 'LinkedIn', daysAgo: 52 },
];

async function main(): Promise<void> {
  await connectDb(env.MONGO_URI);
  console.info(`connected to ${env.MONGO_URI}`);

  let user = await User.findOne({ email: DEMO_EMAIL });

  if (user) {
    // Rebuild from scratch so repeated runs converge on the same board.
    await Promise.all([
      Application.deleteMany({ userId: user._id }),
      Note.deleteMany({ userId: user._id }),
      Reminder.deleteMany({ userId: user._id }),
    ]);
    console.info('cleared existing demo data');
  } else {
    user = await User.create({
      name: 'Demo User',
      email: DEMO_EMAIL,
      passwordHash: await hashPassword(DEMO_PASSWORD),
    });
    console.info('created demo user');
  }

  // Order keys are generated per column, evenly spaced. generateNKeysBetween
  // bisects rather than chaining, so the keys stay short.
  let created = 0;

  for (const stage of STAGES) {
    const rows = ROWS.filter((r) => r.stage === stage);
    if (rows.length === 0) continue;

    const keys = generateNKeysBetween(null, null, rows.length);

    for (const [index, row] of rows.entries()) {
      const application = await Application.create({
        userId: user._id,
        company: row.company,
        role: row.role,
        stage: row.stage,
        order: keys[index] as string,
        location: row.location,
        source: row.source,
        salaryMin: row.salaryMin,
        salaryMax: row.salaryMax,
        currency: row.salaryMin ? 'USD' : undefined,
        appliedAt: row.daysAgo ? new Date(Date.now() - row.daysAgo * 86_400_000) : null,
        noteCount: row.notes?.length ?? 0,
      });

      for (const body of row.notes ?? []) {
        await Note.create({ applicationId: application._id, userId: user._id, body, kind: 'note' });
      }

      created += 1;
    }
  }

  console.info(`seeded ${created} applications`);
  console.info('');
  console.info('  Sign in with:');
  console.info(`    email:    ${DEMO_EMAIL}`);
  console.info(`    password: ${DEMO_PASSWORD}`);
  console.info('');

  await disconnectDb();
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
