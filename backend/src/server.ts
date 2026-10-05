import { pino } from 'pino';
import { createAgendaSync } from './agenda/setup.js';
import { CatalogRepository } from './catalog/catalogRepository.js';
import { loadEnv } from './config/env.js';
import { ensureMongoIndexes } from './db/collections.js';
import { runMigrations } from './db/migrate.js';
import { connectMongo, pingMongo } from './db/mongo.js';
import { createPgPool, pingPostgres } from './db/postgres.js';
import { buildApp } from './http/app.js';
import { KnowledgeService } from './knowledge/knowledgeService.js';
import { createKnowledge } from './knowledge/setup.js';
import { createAiCredentials } from './settings/setup.js';
import { ConversationsRepository } from './messaging/conversationsRepository.js';
import { IngestService } from './messaging/ingestService.js';
import { createSqsClient, SqsMessageQueue } from './messaging/queue/sqsQueue.js';
import { TenantResolver } from './messaging/tenantResolver.js';

async function main() {
  const env = loadEnv();

  const pg = createPgPool(env.DATABASE_URL);
  const mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
  await runMigrations(pg);
  await ensureMongoIndexes(mongo.db);

  const sqs = createSqsClient(env.AWS_REGION, env.SQS_ENDPOINT);
  const queue = new SqsMessageQueue(sqs, env.INCOMING_QUEUE_NAME);
  const conversations = new ConversationsRepository(mongo.db);
  const catalog = new CatalogRepository(mongo.db);
  const tenants = new TenantResolver(catalog, env.DEFAULT_CLINIC_ID);

  // Credenciales de IA por clínica (panel o .env). Sin key, la API arranca igual:
  // subir o buscar documentos responde 503 hasta que se configure.
  const aiSettings = createAiCredentials(env, mongo.db);
  const rag = createKnowledge(env, pg, aiSettings);
  // Agenda dinámica: se regenera desde los documentos cada vez que cambian.
  const agendaSync = createAgendaSync(env, mongo.db, aiSettings, pino({ level: env.LOG_LEVEL, base: { proc: 'agenda' } }));
  const knowledge = new KnowledgeService(
    mongo.db,
    rag.chunks,
    rag.embedderFor,
    env.OPENAI_EMBEDDING_MODEL,
    { topK: env.RAG_TOP_K, minSimilarity: env.RAG_MIN_SIMILARITY },
    (clinicId) => agendaSync.schedule(clinicId),
  );

  const app = buildApp(
    {
      health: {
        postgres: () => pingPostgres(pg),
        mongo: () => pingMongo(mongo.db),
      },
      ingest: new IngestService(tenants, conversations, queue),
      conversations,
      knowledge,
      aiSettings,
      agenda: { sync: agendaSync, catalog },
      defaultClinicId: env.DEFAULT_CLINIC_ID,
      corsOrigins: env.CORS_ORIGINS,
    },
    { logger: { level: env.LOG_LEVEL } },
  );

  // Cierre ordenado: dejamos de aceptar peticiones y luego cerramos las bases.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'cerrando servidor');
    await app.close();
    sqs.destroy();
    await Promise.allSettled([pg.end(), mongo.client.close()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: '0.0.0.0', port: env.PORT });
}

main().catch((err) => {
  console.error('no se pudo arrancar el servidor:', err);
  process.exit(1);
});
