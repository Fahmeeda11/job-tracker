import { Router } from 'express';
import { z } from 'zod';
import {
  createApplicationSchema,
  listApplicationsQuerySchema,
  moveApplicationSchema,
  objectIdSchema,
  stageSchema,
  updateApplicationSchema,
  type ListApplicationsQuery,
} from '@job-tracker/shared';
import { validateBody, validateQuery, parsedQuery } from '../../middleware/validate.js';
import { requireAuth, currentUserId } from '../../middleware/auth.js';
import {
  createApplication,
  deleteApplication,
  getApplication,
  listApplications,
  moveApplication,
  normaliseColumn,
  toDTO,
  updateApplication,
} from './service.js';

export const applicationsRouter = Router();

// Everything below requires a signed-in user.
applicationsRouter.use(requireAuth);

const idParam = z.object({ id: objectIdSchema });

/* -------------------------------------------------------------------------- */

applicationsRouter.get('/', validateQuery(listApplicationsQuerySchema), async (req, res) => {
  const query = parsedQuery<ListApplicationsQuery>(res);
  const applications = await listApplications(currentUserId(req), query);
  res.json({ applications });
});

applicationsRouter.post('/', validateBody(createApplicationSchema), async (req, res) => {
  const application = await createApplication(
    currentUserId(req),
    req.body as typeof createApplicationSchema._output,
  );
  res.status(201).json({ application });
});

/* -------------------------------------------------------------------------- */

applicationsRouter.get('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const doc = await getApplication(currentUserId(req), id);
  res.json({ application: toDTO(doc) });
});

applicationsRouter.patch('/:id', validateBody(updateApplicationSchema), async (req, res) => {
  const { id } = idParam.parse(req.params);
  const application = await updateApplication(
    currentUserId(req),
    id,
    req.body as typeof updateApplicationSchema._output,
  );
  res.json({ application });
});

applicationsRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  await deleteApplication(currentUserId(req), id);
  res.status(204).end();
});

/* -------------------------------------------------------------------------- */

/**
 * Move a card. Separate from PATCH because it has different semantics: PATCH
 * edits fields, this one reorders, and conflating them would mean a PATCH that
 * happens to include `stage` silently leaves the card with a stale order key.
 */
applicationsRouter.post('/:id/move', validateBody(moveApplicationSchema), async (req, res) => {
  const { id } = idParam.parse(req.params);
  const application = await moveApplication(
    currentUserId(req),
    id,
    req.body as typeof moveApplicationSchema._output,
  );
  res.json({ application });
});

/* -------------------------------------------------------------------------- */

/** Maintenance: re-space one column's order keys. See service.normaliseColumn. */
applicationsRouter.post(
  '/maintenance/normalise',
  validateBody(z.object({ stage: stageSchema })),
  async (req, res) => {
    const { stage } = req.body as { stage: z.infer<typeof stageSchema> };
    const updated = await normaliseColumn(currentUserId(req), stage);
    res.json({ updated });
  },
);
