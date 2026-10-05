import cors from '@fastify/cors';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import type { ConversationsRepository } from '../messaging/conversationsRepository.js';
import type { KnowledgeService } from '../knowledge/knowledgeService.js';
import type { IngestService } from '../messaging/ingestService.js';
import type { AiCredentials } from '../settings/aiCredentials.js';
import type { AgendaSync } from '../agenda/agendaSync.js';
import type { CatalogRepository } from '../catalog/catalogRepository.js';
import { agendaRoutes } from './routes/agenda.js';
import { conversationRoutes } from './routes/conversations.js';
import { healthRoutes, type HealthChecks } from './routes/health.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { settingsRoutes } from './routes/settings.js';
import { webhookRoutes } from './routes/webhooks.js';

// Las dependencias entran por parámetro: así los tests montan la app con
// implementaciones falsas sin levantar bases de datos.
export interface AppDeps {
  health: HealthChecks;
  ingest: Pick<IngestService, 'ingest'>;
  conversations: Pick<ConversationsRepository, 'listConversations' | 'countByStatus' | 'getConversationDetail' | 'releaseConversation'>;
  knowledge: Pick<KnowledgeService, 'list' | 'get' | 'upload' | 'remove' | 'reindex' | 'search'>;
  aiSettings: Pick<AiCredentials, 'status' | 'save' | 'remove' | 'test'>;
  agenda: { sync: Pick<AgendaSync, 'status' | 'schedule'>; catalog: Pick<CatalogRepository, 'findClinicById' | 'findResourcesByClinic'> };
  defaultClinicId: string;
  /** Orígenes permitidos para el frontend (CORS). */
  corsOrigins?: string[];
}

export function buildApp(deps: AppDeps, opts: FastifyServerOptions = {}) {
  const app = Fastify(opts);

  app.register(cors, { origin: deps.corsOrigins ?? false, allowedHeaders: ['content-type', 'x-clinic-id'], methods: ['GET', 'POST', 'PUT', 'DELETE'] });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'error no controlado');
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : (err.code ?? 'bad_request'),
      message: status >= 500 ? 'Error interno' : err.message,
    });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: 'Ruta no encontrada' }));

  app.register(healthRoutes(deps.health));
  app.register(webhookRoutes(deps.ingest));
  app.register(conversationRoutes(deps.conversations, deps.defaultClinicId));
  app.register(knowledgeRoutes(deps.knowledge, deps.defaultClinicId));
  app.register(settingsRoutes(deps.aiSettings, deps.defaultClinicId));
  app.register(agendaRoutes(deps.agenda.sync, deps.agenda.catalog, deps.defaultClinicId));

  return app;
}
