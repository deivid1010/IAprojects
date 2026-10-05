import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InvalidApiKeyError, type AiCredentials } from '../../settings/aiCredentials.js';
import { EncryptionUnavailableError } from '../../settings/crypto.js';
import { coordinatorClinic } from '../clinicContext.js';

type Credentials = Pick<AiCredentials, 'status' | 'save' | 'remove' | 'test'>;

const saveSchema = z.object({ api_key: z.string().trim().min(20, 'la API key es demasiado corta').max(300) });

/**
 * Configuración del modelo de IA de la clínica. La API key nunca sale de la API:
 * solo se devuelve enmascarada (sk-proj-…abcd).
 */
export function settingsRoutes(credentials: Credentials, defaultClinicId: string) {
  return async (app: FastifyInstance) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof EncryptionUnavailableError) return reply.code(503).send({ error: 'encryption_unavailable', message: err.message });
      if (err instanceof InvalidApiKeyError) return reply.code(400).send({ error: err.reason, message: err.message });
      req.log.error({ err: { name: (err as Error).name } }, 'error en la configuración de IA'); // sin detalles: podrían incluir la key
      return reply.code(500).send({ error: 'internal_error', message: 'Error interno' });
    });

    app.get('/settings/ai', async (req) => credentials.status(coordinatorClinic(req, defaultClinicId)));

    // Valida la key contra OpenAI y solo si sirve la guarda (cifrada).
    app.put('/settings/ai', async (req, reply) => {
      const body = saveSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues.map((i) => i.message).join('; ') });
      return credentials.save(coordinatorClinic(req, defaultClinicId), body.data.api_key);
    });

    app.delete('/settings/ai', async (req) => credentials.remove(coordinatorClinic(req, defaultClinicId)));

    app.post('/settings/ai/test', async (req) => credentials.test(coordinatorClinic(req, defaultClinicId)));
  };
}
