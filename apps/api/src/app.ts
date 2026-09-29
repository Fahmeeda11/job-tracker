/**
 * Express app factory.
 *
 * Exported separately from the server so tests can mount it with supertest
 * without binding a port. `createApp()` has no side effects - no database
 * connection, no queue - which is what lets the integration tests point it at an
 * in-memory Mongo instead.
 */

import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import mongoose from 'mongoose';
import { env, isTest } from './lib/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter } from './features/auth/routes.js';
import { applicationsRouter } from './features/applications/routes.js';
import { notesRouter } from './features/notes/routes.js';
import { remindersRouter } from './features/reminders/routes.js';

export function createApp(): Express {
  const app = express();

  // Behind a proxy (Render, Fly, nginx), trust the forwarding headers so req.ip
  // is the real client address and `secure` cookies are recognised as such.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());

  /**
   * CORS with credentials.
   *
   * `credentials: true` is what allows the browser to send the refresh cookie
   * cross-origin (the web app is on :5173, the API on :4000). It also means the
   * origin cannot be '*' - the spec forbids that combination - so the allowed
   * origin is pinned to WEB_ORIGIN. Getting this wrong is the single most common
   * reason auth works locally and breaks the moment it is deployed.
   */
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        // Health checks would otherwise dominate the log at one line per second.
        autoLogging: { ignore: (req) => req.url === '/health' },
      }),
    );
  }

  /**
   * Liveness + readiness in one. Returns 503 when Mongo is not connected, so a
   * platform health check pulls the instance out of rotation rather than routing
   * traffic to a process that will 500 on every database call.
   */
  app.get('/health', (_req, res) => {
    const dbState = mongoose.connection.readyState;
    const healthy = dbState === 1;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      db: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] ?? 'unknown',
      uptime: Math.floor(process.uptime()),
    });
  });

  app.use('/auth', authRouter);
  app.use('/applications', applicationsRouter);
  // Nested so the parent id is always present and always checked for ownership.
  app.use('/applications/:applicationId/notes', notesRouter);
  app.use('/applications/:applicationId/reminders', remindersRouter);

  // Order matters: 404 for unmatched routes, then the error handler last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
