# Job Tracker

A Kanban board for job applications, with follow-up reminders that actually email you.

Built as a MERN learning project, so the interesting parts are the ones tutorials usually skip:
**fractional indexing** for drag-and-drop ordering, **refresh-token rotation with reuse detection**
for auth, and **idempotent background jobs** for the reminder emails.

```
apps/api      Express 5 + Mongoose 8 - HTTP, auth, business logic
apps/worker   BullMQ consumer - reminder emails, runs as its own process
apps/web      React 19 + Vite + TanStack Query - the board
packages/shared  zod schemas + domain constants, used by client AND server
packages/db      Mongoose models, shared by the API and the worker
```

---

## Running it

Needs Node 20+ and Docker.

```bash
git clone https://github.com/Fahmeeda11/job-tracker.git
cd job-tracker
npm install

cp .env.example .env
# Generate the two JWT secrets:
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
# Paste both into .env

npm run db:up      # Mongo + Redis via docker compose
npm run seed       # optional: a demo account with a populated board
npm run dev        # api :4000, web :5173, worker, and shared-package watchers
```

Open http://localhost:5173. The seed script prints demo credentials.

Email in development goes to **Ethereal**, a throwaway inbox — no mail credentials needed, and
every send logs a preview URL you can open in a browser.

```bash
npm test           # 119 tests
npm run typecheck
npm run lint
npm run build
```

---

## The three ideas worth reading

### 1. Fractional indexing — `packages/shared/src/ordering.ts`

A Kanban column is an ordered list. The obvious model is an integer `position`, but then dragging a
card from position 7 to position 1 rewrites every card in between — an O(n) write for an O(1) user
action, and a guaranteed conflict when two people drag at once.

Instead each card holds an **order key**: a string chosen so plain lexicographic sort gives the right
order. Moving a card generates a new key strictly between its new neighbours and writes **one
document**. Neighbours are untouched.

```
['a0', 'a1', 'a2']          insert between a0 and a1
['a0', 'a0V', 'a1', 'a2']   one write, still sorts correctly
```

Floats look like they'd work — `(a + b) / 2` — right up until IEEE-754 runs out of precision after
~50 insertions into the same gap and two cards silently collide. Strings grow a character instead.
There's a test that squeezes 500 keys into one shrinking gap to prove it.

The server owns key generation. The client sends *which two cards* it dropped between, by id, and the
server reads those and computes the key — so two people dragging into the same gap both get valid,
distinct keys rather than colliding on values computed from stale snapshots.

### 2. Refresh-token rotation — `apps/api/src/features/auth/service.ts`

- **Access token**: signed JWT, 15 minutes, held **in memory**. Never in `localStorage`, so an XSS
  can't read it out of storage at rest.
- **Refresh token**: 256-bit opaque random value in an **httpOnly** cookie, stored **hashed**,
  **rotated on every use**. Not a JWT — it carries no claims, it's a lookup key, which means it can
  be revoked server-side. JWTs can't.

Tokens are grouped into **families**. Presenting an already-spent token means two parties hold tokens
descended from one login, and there's no way to tell which is the legitimate one — so the whole
family is revoked. The real user has to sign in again; the attacker is locked out.

Login also burns an equivalent argon2 budget on unknown emails, so "no such account" and "wrong
password" are indistinguishable in both content *and* timing — otherwise response time is a reliable
oracle for enumerating which addresses have accounts.

### 3. Idempotent jobs — `apps/worker/src/handlers/sendReminder.ts`

BullMQ, like every queue, is **at-least-once**. A job can run twice because the worker died before
acking, the lock expired and the job was reclaimed as stalled, or a retry fired after a failure that
had in fact already sent. Being careful doesn't fix this; the handler has to be *designed* to be
re-runnable.

Two layers:

1. Each reminder gets a **deterministic dedupe key** — `sha256(applicationId + due-minute + message)`
   — behind a unique index, doubling as the BullMQ job id. A double-submitted form is absorbed and
   returns the existing reminder with a `200`.

2. Before touching SMTP the handler **claims** the reminder with a conditional update:

   ```js
   findOneAndUpdate({ _id, status: 'scheduled' }, { $set: { status: 'sending' } })
   ```

   The filter *is* the lock. Mongo applies single-document updates atomically, so of N concurrent
   attempts exactly one matches a still-scheduled document and the rest return without sending. No
   Redis mutex required. There's a test firing ten concurrent attempts and asserting exactly one
   email.

A claim older than five minutes is treated as belonging to a dead worker and reclaimed, so a crash
can't wedge a reminder forever.

**The honest caveat:** if the process dies between SMTP accepting the message and the status write
landing, the sweeper will eventually retry and produce a duplicate. Closing that window needs a
transactional outbox. For a follow-up nudge, a rare duplicate beats the complexity — but it's a
deliberate trade, not an oversight.

And a **sweeper** reconciles from Mongo every minute, because the queue makes work *timely* but only
a durable store makes it *reliable*: it catches reminders written just before a crash, jobs Redis
lost, and delays clamped at BullMQ's ~24.8-day ceiling.

---

## Notable details

- **`apps/api/src/lib/env.ts`** validates all config with zod at boot. Delete a required variable and
  the app refuses to start and names it — rather than booting fine and throwing
  `secretOrPrivateKey must have a value` on the first login.
- **`validateBody`** *replaces* `req.body` with the parse result rather than just checking it. zod
  strips unknown keys, so a client can't smuggle `role: "admin"` through a `{...req.body}` spread.
- **Tenancy**: every applications query takes `userId` as a required argument. Reading another user's
  record returns **404, not 403** — a 403 confirms the id exists and is an enumeration oracle. Five
  tests cover this.
- **The 8px drag threshold** in `BoardPage.tsx`. Without it the click that opens a card registers as a
  1px drag and the detail drawer never opens.
- **Single-flight refresh** in `lib/api.ts`. The board fires several queries at once; if each got a
  401 and called `/auth/refresh` independently, the first would spend the rotating cookie and the
  rest would trip reuse detection — logging the user out at random whenever two requests expired
  together.

## Testing

119 tests. Integration tests run against a real MongoDB via `mongodb-memory-server`, not mocks —
unique indexes, TTL behaviour, `$inc` guards and cast errors are exactly what breaks in production
and exactly what a mock can't tell you about.

CI typechecks, lints, tests, builds, and **fails the build if a credential ever appears in git
history**.

## License

MIT
