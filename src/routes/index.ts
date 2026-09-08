import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { downloadRoutes } from './download.ts';
import { healthRoutes } from './health.ts';
import { searchRoutes } from './search.ts';

export const routes: FastifyPluginAsyncZod = async (app) => {
  await app.register(healthRoutes);
  await app.register(searchRoutes);
  await app.register(downloadRoutes);
};
