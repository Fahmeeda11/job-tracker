/**
 * Mongo connection lifecycle.
 *
 * `strictQuery` is on so a typo in a filter key throws instead of silently
 * matching every document - the difference between an error and
 * `deleteMany({ userid: x })` wiping the collection.
 */

import mongoose from 'mongoose';
import { env } from './env.js';
import { childLogger } from './logger.js';

const log = childLogger('db');

mongoose.set('strictQuery', true);

export async function connectDb(uri: string = env.MONGO_URI): Promise<typeof mongoose> {
  mongoose.connection.on('error', (err) => log.error({ err }, 'mongo connection error'));
  mongoose.connection.on('disconnected', () => log.warn('mongo disconnected'));
  mongoose.connection.on('reconnected', () => log.info('mongo reconnected'));

  await mongoose.connect(uri, {
    // Fail fast rather than queueing commands for 30s behind a dead server.
    serverSelectionTimeoutMS: 5_000,
  });

  log.info({ db: mongoose.connection.name }, 'mongo connected');
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.connection.close();
  log.info('mongo connection closed');
}

/**
 * Build indexes declared on the models.
 *
 * Mongoose autoIndex is left ON in development (convenient) and this is called
 * explicitly at boot in production, where autoIndex is off - building an index
 * implicitly on a large collection at startup is how you take an API down.
 * Calling it here makes the cost visible and log-able instead.
 */
export async function syncIndexes(): Promise<void> {
  const names = Object.keys(mongoose.models);
  for (const name of names) {
    const model = mongoose.models[name];
    if (!model) continue;
    const started = Date.now();
    await model.syncIndexes();
    log.info({ model: name, ms: Date.now() - started }, 'indexes synced');
  }
}
