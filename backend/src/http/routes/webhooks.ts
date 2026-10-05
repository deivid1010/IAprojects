import type { FastifyInstance } from 'fastify';
import { incomingMessageSchema, QueueUnavailableError, type IngestService } from '../../messaging/ingestService.js';
import { UnknownClinicError } from '../../messaging/tenantResolver.js';

export function webhookRoutes(ingest: Pick<IngestService, 'ingest'>) {
  return async (app: FastifyInstance) => {
    app.post('/webhooks/messages', async (req, reply) => {
      const parsed = incomingMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_payload',
          message: 'El mensaje no tiene el formato esperado',
          details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        });
      }

      try {
        const result = await ingest.ingest(parsed.data);
        // 202: aceptado, la respuesta del asistente llega después (asíncrona).
        // 200: duplicado, ya estaba recibido; no se procesa otra vez.
        const code = result.status === 'duplicate' ? 200 : 202;
        return reply.code(code).send({ status: result.status, message_id: result.messageId, conversation_id: result.conversationId });
      } catch (err) {
        if (err instanceof UnknownClinicError) {
          return reply.code(404).send({ error: 'unknown_clinic', message: err.message });
        }
        if (err instanceof QueueUnavailableError) {
          // 503: WhatsApp reintenta; el reintento encontrará el mensaje guardado y lo encolará.
          req.log.error({ err: err.cause }, 'cola no disponible');
          return reply.code(503).send({ error: 'queue_unavailable', message: 'Intenta de nuevo en unos segundos' });
        }
        throw err;
      }
    });
  };
}
