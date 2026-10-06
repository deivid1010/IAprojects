import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InvalidPromptError, PROMPT_MAX_CHARS, type PromptSettings } from '../../settings/promptSettings.js';
import { coordinatorClinic } from '../clinicContext.js';

const saveSchema = z.object({ template: z.string().max(PROMPT_MAX_CHARS + 1) });

/** Prompt del asistente editable por la clínica: ver, guardar y restaurar el original. */
export function promptRoutes(prompts: Pick<PromptSettings, 'status' | 'save' | 'reset'>, defaultClinicId: string) {
  return async (app: FastifyInstance) => {
    app.get('/settings/prompt', async (req) => prompts.status(coordinatorClinic(req, defaultClinicId)));

    app.put('/settings/prompt', async (req, reply) => {
      const body = saveSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues.map((i) => i.message).join('; ') });
      try {
        return await prompts.save(coordinatorClinic(req, defaultClinicId), body.data.template);
      } catch (err) {
        if (err instanceof InvalidPromptError) return reply.code(400).send({ error: 'invalid_prompt', message: err.message });
        throw err;
      }
    });

    app.delete('/settings/prompt', async (req) => prompts.reset(coordinatorClinic(req, defaultClinicId)));
  };
}
