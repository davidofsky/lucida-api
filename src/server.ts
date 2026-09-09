import Fastify from 'fastify';
import {
  type ZodTypeProvider,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import { registerErrorHandler } from './error-handler.ts';
import { hasManualClearance, useSession } from './lucida/client.ts';
import { LucidaSession } from './lucida/session.ts';
import { registerDocs } from './openapi.ts';
import { routes } from './routes/index.ts';

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

await registerDocs(app);
registerErrorHandler(app);
await app.register(routes);

const manualClearance = hasManualClearance();

if (manualClearance) {
  app.log.info('using CF_CLEARANCE and USER_AGENT from the environment');
} else {
  app.log.info('asking the solver to clear the lucida challenge');
  const session = await new LucidaSession().start();
  useSession(session);
  app.addHook('onClose', () => session.close());
  app.log.info('clearance cookie acquired');
}

const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '127.0.0.1';

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });
