/**
 * Idempotency tests for the reminder handler.
 *
 * The property under test: however many times this handler runs for one
 * reminder - retries, stalled-job reclaims, two workers racing - the user
 * receives exactly one email.
 *
 * These run against a real in-memory MongoDB, because the guarantee being tested
 * IS the atomicity of a conditional update. Mocking the model would test nothing
 * except that the mock returns what the mock was told to return.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';
import { Application, Note, Reminder, User, buildDedupeKey } from '@job-tracker/db';
import { setMailSender, type MailMessage } from '../mailer.js';
import { handleSendReminder, markReminderFailed, buildReminderBody } from './sendReminder.js';

let memoryServer: MongoMemoryServer;

/** Every message the handler tried to send during a test. */
let sent: MailMessage[] = [];

beforeAll(async () => {
  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
});

afterAll(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  sent = [];
  setMailSender(async (message) => {
    sent.push(message);
    return { messageId: `test-${sent.length}` };
  });
});

afterEach(() => {
  setMailSender(null);
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */

interface Fixture {
  userId: Types.ObjectId;
  applicationId: Types.ObjectId;
  reminderId: string;
  dedupeKey: string;
  payload: { reminderId: string; applicationId: string; userId: string; dedupeKey: string };
}

async function seed(
  overrides: {
    stage?: string;
    dueAt?: Date;
    status?: string;
    claimedAt?: Date | null;
    archivedAt?: Date | null;
  } = {},
): Promise<Fixture> {
  const user = await User.create({
    name: 'Ada Lovelace',
    email: `ada.${Date.now()}.${Math.random()}@example.test`,
    passwordHash: 'not-used-here',
  });

  const application = await Application.create({
    userId: user._id,
    company: 'Analytical Engines Ltd',
    role: 'Staff Engineer',
    stage: overrides.stage ?? 'applied',
    order: 'a0',
    archivedAt: overrides.archivedAt ?? null,
  });

  // Due one second ago by default, so the handler considers it ready.
  const dueAt = overrides.dueAt ?? new Date(Date.now() - 1000);
  const dedupeKey = buildDedupeKey(String(application._id), dueAt, 'Chase the recruiter');

  const reminder = await Reminder.create({
    applicationId: application._id,
    userId: user._id,
    dueAt,
    message: 'Chase the recruiter',
    dedupeKey,
    status: overrides.status ?? 'scheduled',
    claimedAt: overrides.claimedAt ?? null,
  });

  return {
    userId: user._id,
    applicationId: application._id,
    reminderId: String(reminder._id),
    dedupeKey,
    payload: {
      reminderId: String(reminder._id),
      applicationId: String(application._id),
      userId: String(user._id),
      dedupeKey,
    },
  };
}

/* -------------------------------------------------------------------------- */

describe('happy path', () => {
  it('sends one email and marks the reminder sent', async () => {
    const fx = await seed();

    const result = await handleSendReminder(fx.payload);

    expect(result.outcome).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('Staff Engineer');
    expect(sent[0]?.subject).toContain('Analytical Engines Ltd');

    const reminder = await Reminder.findById(fx.reminderId);
    expect(reminder?.status).toBe('sent');
    expect(reminder?.sentAt).toBeTruthy();
    expect(reminder?.claimedAt).toBeNull();
  });

  it('records the send on the application timeline', async () => {
    const fx = await seed();
    await handleSendReminder(fx.payload);

    const notes = await Note.find({ applicationId: fx.applicationId });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe('reminder_sent');

    const application = await Application.findById(fx.applicationId);
    expect(application?.noteCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('idempotency', () => {
  /**
   * The headline guarantee. A BullMQ retry after a send that actually succeeded
   * must not produce a second email.
   */
  it('sends exactly once when the job runs twice in sequence', async () => {
    const fx = await seed();

    const first = await handleSendReminder(fx.payload);
    const second = await handleSendReminder(fx.payload);

    expect(first.outcome).toBe('sent');
    expect(second.outcome).toBe('skipped_not_scheduled');
    expect(sent).toHaveLength(1);
  });

  it('sends exactly once when the job runs five times', async () => {
    const fx = await seed();

    for (let i = 0; i < 5; i++) {
      await handleSendReminder(fx.payload);
    }

    expect(sent).toHaveLength(1);
  });

  /**
   * Two workers picking up the same job at the same instant. This is what the
   * conditional update actually defends against - only one attempt can match a
   * document whose status is still 'scheduled'.
   */
  it('sends exactly once when ten attempts run concurrently', async () => {
    const fx = await seed();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => handleSendReminder(fx.payload)),
    );

    const sentCount = results.filter((r) => r.outcome === 'sent').length;
    expect(sentCount).toBe(1);
    expect(sent).toHaveLength(1);

    const reminder = await Reminder.findById(fx.reminderId);
    expect(reminder?.status).toBe('sent');
  });

  it('does not double-count the timeline note across retries', async () => {
    const fx = await seed();

    await handleSendReminder(fx.payload);
    await handleSendReminder(fx.payload);
    await handleSendReminder(fx.payload);

    const notes = await Note.find({ applicationId: fx.applicationId });
    expect(notes).toHaveLength(1);

    const application = await Application.findById(fx.applicationId);
    expect(application?.noteCount).toBe(1);
  });

  it('skips a reminder another worker is actively sending', async () => {
    // A fresh claim held by a live worker.
    const fx = await seed({ status: 'sending', claimedAt: new Date() });

    const result = await handleSendReminder(fx.payload);

    expect(result.outcome).toBe('skipped_not_scheduled');
    expect(sent).toHaveLength(0);
  });

  /**
   * The flip side: a claim from a worker that died must not wedge the reminder
   * forever. After the stale window it becomes claimable again.
   */
  it('reclaims a stale claim left by a dead worker', async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    const fx = await seed({ status: 'sending', claimedAt: tenMinutesAgo });

    const result = await handleSendReminder(fx.payload);

    expect(result.outcome).toBe('sent');
    expect(sent).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('skip conditions', () => {
  it('skips a cancelled reminder', async () => {
    const fx = await seed({ status: 'cancelled' });

    const result = await handleSendReminder(fx.payload);

    expect(result.outcome).toBe('skipped_cancelled');
    expect(sent).toHaveLength(0);
  });

  it('skips and does not retry when the reminder was deleted', async () => {
    const fx = await seed();
    await Reminder.deleteOne({ _id: fx.reminderId });

    // Returns rather than throwing: throwing would make BullMQ retry a job that
    // can never succeed.
    const result = await handleSendReminder(fx.payload);

    expect(result.outcome).toBe('skipped_missing');
    expect(sent).toHaveLength(0);
  });

  it('cancels itself when the application was deleted', async () => {
    const fx = await seed();
    await Application.deleteOne({ _id: fx.applicationId });

    const result = await handleSendReminder(fx.payload);

    expect(result.outcome).toBe('skipped_missing');
    expect(sent).toHaveLength(0);
    expect((await Reminder.findById(fx.reminderId))?.status).toBe('cancelled');
  });

  /**
   * Nudging someone to chase a job they were already rejected from is the kind
   * of detail that makes a tool feel careless.
   */
  it.each(['offer', 'rejected'])('does not nudge about a %s application', async (stage) => {
    const fx = await seed({ stage });

    const result = await handleSendReminder(fx.payload);

    expect(result.outcome).toBe('skipped_terminal_stage');
    expect(sent).toHaveLength(0);
    expect((await Reminder.findById(fx.reminderId))?.status).toBe('cancelled');
  });

  it('does not nudge about an archived application', async () => {
    const fx = await seed({ archivedAt: new Date() });

    const result = await handleSendReminder(fx.payload);

    expect(result.outcome).toBe('skipped_terminal_stage');
    expect(sent).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('early wake-up and re-arming', () => {
  /**
   * BullMQ caps delays at ~24.8 days, so the API clamps anything longer. The job
   * therefore wakes early and must re-arm rather than send a reminder weeks
   * before it is due.
   */
  it('re-arms instead of sending when it wakes before the due time', async () => {
    const inThirtyDays = new Date(Date.now() + 30 * 86_400_000);
    const fx = await seed({ dueAt: inThirtyDays });

    const result = await handleSendReminder(fx.payload);

    expect(result.outcome).toBe('re_armed');
    expect(result.reArmAt?.getTime()).toBe(inThirtyDays.getTime());
    expect(sent).toHaveLength(0);
    expect((await Reminder.findById(fx.reminderId))?.status).toBe('scheduled');
  });

  it('sends when it wakes marginally early, within tolerance', async () => {
    // Five seconds out is BullMQ imprecision, not a clamped long delay.
    const fx = await seed({ dueAt: new Date(Date.now() + 5_000) });

    const result = await handleSendReminder(fx.payload);

    expect(result.outcome).toBe('sent');
    expect(sent).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('failure handling', () => {
  it('releases the claim and rethrows when sending fails, so BullMQ can retry', async () => {
    const fx = await seed();
    setMailSender(async () => {
      throw new Error('SMTP connection refused');
    });

    await expect(handleSendReminder(fx.payload)).rejects.toThrow('SMTP connection refused');

    const reminder = await Reminder.findById(fx.reminderId);
    // Back to scheduled, not stuck in 'sending' - otherwise every retry would be
    // blocked until the stale-claim window expired.
    expect(reminder?.status).toBe('scheduled');
    expect(reminder?.claimedAt).toBeNull();
    expect(reminder?.failureReason).toContain('SMTP connection refused');
    expect(reminder?.attempts).toBe(1);
  });

  it('succeeds on a retry after a transient failure', async () => {
    const fx = await seed();

    let attempt = 0;
    setMailSender(async (message) => {
      attempt += 1;
      if (attempt === 1) throw new Error('temporary DNS failure');
      sent.push(message);
      return { messageId: 'ok' };
    });

    await expect(handleSendReminder(fx.payload)).rejects.toThrow('temporary DNS failure');
    const second = await handleSendReminder(fx.payload);

    expect(second.outcome).toBe('sent');
    expect(sent).toHaveLength(1);
    expect((await Reminder.findById(fx.reminderId))?.attempts).toBe(2);
  });

  it('marks a reminder failed once retries are exhausted', async () => {
    const fx = await seed();
    await markReminderFailed(fx.reminderId, 'giving up after 3 attempts');

    const reminder = await Reminder.findById(fx.reminderId);
    expect(reminder?.status).toBe('failed');
    expect(reminder?.failureReason).toContain('giving up');
  });

  it('does not overwrite a sent reminder when marking failed', async () => {
    const fx = await seed();
    await handleSendReminder(fx.payload);

    // A late failure callback must not undo a successful send.
    await markReminderFailed(fx.reminderId, 'late failure callback');

    expect((await Reminder.findById(fx.reminderId))?.status).toBe('sent');
  });
});

/* -------------------------------------------------------------------------- */

describe('buildReminderBody', () => {
  it('includes the role, company and a link to the application', () => {
    const body = buildReminderBody({
      userName: 'Ada',
      company: 'Acme',
      role: 'Engineer',
      stage: 'applied',
      message: 'Ask about the team size',
      appUrl: 'https://tracker.example',
      applicationId: '507f1f77bcf86cd799439011',
    });

    expect(body.text).toContain('Engineer');
    expect(body.text).toContain('Acme');
    expect(body.text).toContain('https://tracker.example/board?application=507f1f77bcf86cd799439011');
    expect(body.text).toContain('Ask about the team size');
  });

  it('escapes user-supplied text in the HTML body', () => {
    // Company names and notes are user input and land in an HTML email.
    const body = buildReminderBody({
      userName: '<script>alert(1)</script>',
      company: 'Evil & Co "quoted"',
      role: 'Dev',
      stage: 'applied',
      message: '<img src=x onerror=alert(1)>',
      appUrl: 'https://tracker.example',
      applicationId: '507f1f77bcf86cd799439011',
    });

    expect(body.html).not.toContain('<script>');
    expect(body.html).not.toContain('<img src=x');
    expect(body.html).toContain('&lt;script&gt;');
    expect(body.html).toContain('Evil &amp; Co');
  });
});
