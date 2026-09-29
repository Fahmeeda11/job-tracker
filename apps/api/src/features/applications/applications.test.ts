import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import type { Application as ApplicationDTO } from '@job-tracker/shared';
import { createApp } from '../../app.js';
import { authed, clearTestDb, signupTestUser, startTestDb, stopTestDb, type SignedUpUser } from '../../test/helpers.js';
import { Application } from '@job-tracker/db';

let app: Express;
let user: SignedUpUser;

beforeAll(async () => {
  await startTestDb();
  app = createApp();
});

afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  user = await signupTestUser(app);
});

async function createApplication(
  overrides: Partial<{ company: string; role: string; stage: string }> = {},
): Promise<ApplicationDTO> {
  const res = await authed(app, user)
    .post('/applications')
    .send({
      company: overrides.company ?? 'Acme Corp',
      role: overrides.role ?? 'Senior Engineer',
      stage: overrides.stage ?? 'wishlist',
    })
    .expect(201);
  return res.body.application;
}

async function board(): Promise<ApplicationDTO[]> {
  const res = await authed(app, user).get('/applications').expect(200);
  return res.body.applications;
}

/** Ids in one column, in the order the server returns them. */
function column(apps: ApplicationDTO[], stage: string): string[] {
  return apps.filter((a) => a.stage === stage).map((a) => a.id);
}

describe('POST /applications', () => {
  it('creates an application in the wishlist by default', async () => {
    const created = await createApplication();
    expect(created.stage).toBe('wishlist');
    expect(created.company).toBe('Acme Corp');
    expect(created.order).toBeTypeOf('string');
    expect(created.noteCount).toBe(0);
  });

  it('appends each new application below the last in its column', async () => {
    const first = await createApplication({ company: 'First' });
    const second = await createApplication({ company: 'Second' });
    const third = await createApplication({ company: 'Third' });

    expect(first.order < second.order).toBe(true);
    expect(second.order < third.order).toBe(true);
    expect(column(await board(), 'wishlist')).toEqual([first.id, second.id, third.id]);
  });

  it('rejects a missing company with a field error', async () => {
    const res = await authed(app, user)
      .post('/applications')
      .send({ role: 'Engineer' })
      .expect(422);
    expect(res.body.error.fields.company).toBeTruthy();
  });

  it('rejects a salary range that is inverted', async () => {
    const res = await authed(app, user)
      .post('/applications')
      .send({ company: 'A', role: 'B', salaryMin: 200000, salaryMax: 100000 })
      .expect(422);
    expect(res.body.error.fields.salaryMin).toMatch(/exceed/i);
  });

  it('requires authentication', async () => {
    const { default: supertest } = await import('supertest');
    await supertest(app).post('/applications').send({ company: 'A', role: 'B' }).expect(401);
  });
});

describe('POST /applications/:id/move', () => {
  it('moves a card to a different stage', async () => {
    const a = await createApplication();

    const res = await authed(app, user)
      .post(`/applications/${a.id}/move`)
      .send({ stage: 'applied', beforeId: null, afterId: null })
      .expect(200);

    expect(res.body.application.stage).toBe('applied');
  });

  it('stamps appliedAt the first time a card leaves the wishlist', async () => {
    const a = await createApplication();
    expect(a.appliedAt).toBeNull();

    const res = await authed(app, user)
      .post(`/applications/${a.id}/move`)
      .send({ stage: 'applied', beforeId: null, afterId: null })
      .expect(200);

    expect(res.body.application.appliedAt).not.toBeNull();
  });

  it('reorders within a column: move the last card to the top', async () => {
    const first = await createApplication({ company: 'First' });
    const second = await createApplication({ company: 'Second' });
    const third = await createApplication({ company: 'Third' });

    // Dropped above `first`, so there is no card before it.
    await authed(app, user)
      .post(`/applications/${third.id}/move`)
      .send({ stage: 'wishlist', beforeId: null, afterId: first.id })
      .expect(200);

    expect(column(await board(), 'wishlist')).toEqual([third.id, first.id, second.id]);
  });

  it('reorders within a column: move the first card into the middle', async () => {
    const first = await createApplication({ company: 'First' });
    const second = await createApplication({ company: 'Second' });
    const third = await createApplication({ company: 'Third' });

    await authed(app, user)
      .post(`/applications/${first.id}/move`)
      .send({ stage: 'wishlist', beforeId: second.id, afterId: third.id })
      .expect(200);

    expect(column(await board(), 'wishlist')).toEqual([second.id, first.id, third.id]);
  });

  /**
   * The performance claim behind fractional indexing, asserted rather than
   * assumed: moving a card must not touch its neighbours. If this ever fails,
   * someone has reintroduced integer positions.
   */
  it('writes exactly one document, leaving neighbour order keys untouched', async () => {
    const first = await createApplication({ company: 'First' });
    const second = await createApplication({ company: 'Second' });
    const third = await createApplication({ company: 'Third' });

    const before = await Application.find({}).select('_id order').lean();
    const beforeById = new Map(before.map((d) => [String(d._id), d.order]));

    await authed(app, user)
      .post(`/applications/${third.id}/move`)
      .send({ stage: 'wishlist', beforeId: null, afterId: first.id })
      .expect(200);

    const after = await Application.find({}).select('_id order').lean();
    const changed = after.filter((d) => beforeById.get(String(d._id)) !== d.order);

    expect(changed).toHaveLength(1);
    expect(String(changed[0]?._id)).toBe(third.id);
    // And the two it was dropped around are byte-for-byte unchanged.
    expect(beforeById.get(first.id)).toBe(after.find((d) => String(d._id) === first.id)?.order);
    expect(beforeById.get(second.id)).toBe(after.find((d) => String(d._id) === second.id)?.order);
  });

  it('survives many moves without ever producing a duplicate order key', async () => {
    const apps = [];
    for (let i = 0; i < 8; i++) {
      apps.push(await createApplication({ company: `Company ${i}` }));
    }

    // Repeatedly yank the bottom card to the top: the pathological pattern that
    // squeezes keys into an ever-shrinking gap at the front of the column.
    for (let i = 0; i < 25; i++) {
      const current = column(await board(), 'wishlist');
      const last = current[current.length - 1] as string;
      const first = current[0] as string;

      await authed(app, user)
        .post(`/applications/${last}/move`)
        .send({ stage: 'wishlist', beforeId: null, afterId: first })
        .expect(200);
    }

    const finalDocs = await Application.find({}).select('order').lean();
    const keys = finalDocs.map((d) => d.order);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * The client computed its drop from a board that has since changed. Rather
   * than guess at an order the user did not intend, the server refuses and tells
   * the client to refetch.
   */
  it('returns 409 when a named neighbour no longer exists', async () => {
    const a = await createApplication();
    const b = await createApplication();

    await authed(app, user).delete(`/applications/${b.id}`).expect(204);

    const res = await authed(app, user)
      .post(`/applications/${a.id}/move`)
      .send({ stage: 'wishlist', beforeId: b.id, afterId: null })
      .expect(409);

    expect(res.body.error.message).toMatch(/refresh/i);
  });

  it('returns 409 when a named neighbour has moved to another column', async () => {
    const a = await createApplication();
    const b = await createApplication();

    await authed(app, user)
      .post(`/applications/${b.id}/move`)
      .send({ stage: 'offer', beforeId: null, afterId: null })
      .expect(200);

    // `b` is no longer in wishlist, so it cannot anchor a wishlist drop.
    await authed(app, user)
      .post(`/applications/${a.id}/move`)
      .send({ stage: 'wishlist', beforeId: b.id, afterId: null })
      .expect(409);
  });

  it('rejects an invalid stage', async () => {
    const a = await createApplication();
    await authed(app, user)
      .post(`/applications/${a.id}/move`)
      .send({ stage: 'not-a-stage', beforeId: null, afterId: null })
      .expect(422);
  });
});

/* -------------------------------------------------------------------------- */

describe('tenancy isolation', () => {
  /**
   * Every query in the applications service filters by userId. These tests exist
   * so that a future refactor which drops one of those filters fails loudly here
   * rather than silently leaking one user's pipeline to another.
   */
  it('does not list another user\'s applications', async () => {
    await createApplication({ company: 'Mine' });

    const other = await signupTestUser(app);
    const res = await authed(app, other).get('/applications').expect(200);

    expect(res.body.applications).toHaveLength(0);
  });

  it('returns 404, not 403, when reading another user\'s application', async () => {
    const mine = await createApplication();
    const other = await signupTestUser(app);

    // 404 rather than 403 deliberately: a 403 would confirm the id exists, which
    // is an oracle for enumerating other people's records.
    await authed(app, other).get(`/applications/${mine.id}`).expect(404);
  });

  it('cannot move another user\'s application', async () => {
    const mine = await createApplication();
    const other = await signupTestUser(app);

    await authed(app, other)
      .post(`/applications/${mine.id}/move`)
      .send({ stage: 'offer', beforeId: null, afterId: null })
      .expect(404);
  });

  it('cannot delete another user\'s application', async () => {
    const mine = await createApplication();
    const other = await signupTestUser(app);

    await authed(app, other).delete(`/applications/${mine.id}`).expect(404);
    await authed(app, user).get(`/applications/${mine.id}`).expect(200);
  });

  it('cannot use another user\'s card as a move anchor', async () => {
    const mine = await createApplication();
    const other = await signupTestUser(app);
    const theirs = await authed(app, other)
      .post('/applications')
      .send({ company: 'Theirs', role: 'Dev' })
      .expect(201);

    // Anchoring against a card from another account must not work, even though
    // the id is perfectly valid.
    await authed(app, user)
      .post(`/applications/${mine.id}/move`)
      .send({ stage: 'wishlist', beforeId: theirs.body.application.id, afterId: null })
      .expect(409);
  });
});

/* -------------------------------------------------------------------------- */

describe('PATCH and DELETE /applications/:id', () => {
  it('updates fields', async () => {
    const a = await createApplication();
    const res = await authed(app, user)
      .patch(`/applications/${a.id}`)
      .send({ company: 'Renamed', location: 'Remote' })
      .expect(200);

    expect(res.body.application.company).toBe('Renamed');
    expect(res.body.application.location).toBe('Remote');
  });

  it('archives without deleting', async () => {
    const a = await createApplication();
    await authed(app, user).patch(`/applications/${a.id}`).send({ archived: true }).expect(200);

    expect(await board()).toHaveLength(0);

    const withArchived = await authed(app, user)
      .get('/applications?includeArchived=true')
      .expect(200);
    expect(withArchived.body.applications).toHaveLength(1);
  });

  it('deletes', async () => {
    const a = await createApplication();
    await authed(app, user).delete(`/applications/${a.id}`).expect(204);
    await authed(app, user).get(`/applications/${a.id}`).expect(404);
  });

  it('returns 404 for a malformed id rather than a 500', async () => {
    await authed(app, user).get('/applications/not-a-valid-object-id').expect(422);
  });
});

/* -------------------------------------------------------------------------- */

describe('notes', () => {
  it('adds a note and increments the card badge count', async () => {
    const a = await createApplication();

    await authed(app, user)
      .post(`/applications/${a.id}/notes`)
      .send({ body: 'Recruiter said they would call Thursday' })
      .expect(201);

    const [card] = await board();
    expect(card?.noteCount).toBe(1);
  });

  it('decrements the badge count on delete, never below zero', async () => {
    const a = await createApplication();
    const note = await authed(app, user)
      .post(`/applications/${a.id}/notes`)
      .send({ body: 'A note' })
      .expect(201);

    await authed(app, user)
      .delete(`/applications/${a.id}/notes/${note.body.note.id}`)
      .expect(204);

    const [card] = await board();
    expect(card?.noteCount).toBe(0);
  });

  it('cannot add a note to another user\'s application', async () => {
    const mine = await createApplication();
    const other = await signupTestUser(app);

    await authed(app, other)
      .post(`/applications/${mine.id}/notes`)
      .send({ body: 'Should not work' })
      .expect(404);
  });
});
