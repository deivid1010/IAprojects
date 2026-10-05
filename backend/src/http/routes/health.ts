import type { FastifyInstance } from 'fastify';

export type HealthCheck = () => Promise<void>;

export interface HealthChecks {
  postgres: HealthCheck;
  mongo: HealthCheck;
}

type CheckStatus = 'up' | 'down';

async function run(check: HealthCheck): Promise<CheckStatus> {
  try {
    await check();
    return 'up';
  } catch {
    return 'down';
  }
}

export function healthRoutes(checks: HealthChecks) {
  return async (app: FastifyInstance) => {
    app.get('/health', async (_req, reply) => {
      const [postgres, mongo] = await Promise.all([run(checks.postgres), run(checks.mongo)]);
      const ok = postgres === 'up' && mongo === 'up';
      return reply.code(ok ? 200 : 503).send({
        status: ok ? 'ok' : 'degraded',
        checks: { postgres, mongo },
      });
    });
  };
}
