import { pino } from 'pino';
import { LocalAgendaProvider } from './agenda/localAgendaProvider.js';
import { AppointmentsRepository } from './appointments/appointmentsRepository.js';
import type { AssistantEngine } from './assistant/engine.js';
import { KnowledgeGateEngine } from './assistant/knowledgeGate.js';
import { OpenAIEngine, openAIResponsesClient } from './assistant/openaiEngine.js';
import { StubEngine } from './assistant/stubEngine.js';
import { buildToolRegistry } from './assistant/tools/index.js';
import { CatalogRepository } from './catalog/catalogRepository.js';
import { loadEnv, type Env } from './config/env.js';
import { ensureMongoIndexes } from './db/collections.js';
import { connectMongo } from './db/mongo.js';
import { createPgPool, type PgPool } from './db/postgres.js';
import { createKnowledge } from './knowledge/setup.js';
import { ConversationsRepository } from './messaging/conversationsRepository.js';
import { LogChannel } from './messaging/outbound/logChannel.js';
import { createSqsClient, SqsMessageQueue } from './messaging/queue/sqsQueue.js';
import type { AiCredentials } from './settings/aiCredentials.js';
import { createAiCredentials, openAIClientFor } from './settings/setup.js';
import { Worker } from './worker/worker.js';

// Proceso aparte de la API: consume la cola y ejecuta el asistente. Escala de
// forma independiente (en AWS sería una Lambda conectada a SQS).
async function main() {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL, base: { proc: 'worker' } });

  const pg = createPgPool(env.DATABASE_URL);
  const mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
  await ensureMongoIndexes(mongo.db);
  const sqs = createSqsClient(env.AWS_REGION, env.SQS_ENDPOINT);

  const catalog = new CatalogRepository(mongo.db);
  const agenda = new LocalAgendaProvider(catalog, new AppointmentsRepository(pg));
  // La API key se resuelve por clínica en cada turno (panel o .env): si se
  // cambia en el panel, aplica sin reiniciar el worker.
  const credentials = createAiCredentials(env, mongo.db);
  const engine = createEngine(env, agenda, pg, credentials);
  log.info({ engine: engine.name, model: env.ASSISTANT_ENGINE === 'openai' ? env.OPENAI_MODEL : null }, 'motor del asistente');

  const worker = new Worker(
    new SqsMessageQueue(sqs, env.INCOMING_QUEUE_NAME),
    {
      conversations: new ConversationsRepository(mongo.db),
      catalog,
      engine,
      channel: new LogChannel(log),
      log,
      maxAttempts: env.WORKER_MAX_ATTEMPTS,
      engineTimeoutMs: env.ENGINE_TIMEOUT_MS,
    },
    log,
  );

  const stop = new AbortController();
  const shutdown = (signal: string) => {
    log.info({ signal }, 'deteniendo worker: termina el lote en curso');
    stop.abort();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await worker.start(stop.signal);
  sqs.destroy();
  await Promise.allSettled([pg.end(), mongo.client.close()]);
}

/**
 * Motor del asistente. Sin API key o sin base de conocimiento para la clínica,
 * KnowledgeGateEngine responde el mensaje por defecto y escala, sin llamar al LLM.
 */
function createEngine(env: Env, agenda: LocalAgendaProvider, pg: PgPool, credentials: AiCredentials): AssistantEngine {
  const { chunks, retriever } = createKnowledge(env, pg, credentials);
  const hasKnowledge = async (clinicId: string) => (await chunks.countForClinic(clinicId)) > 0;
  if (env.ASSISTANT_ENGINE === 'stub') return new KnowledgeGateEngine(new StubEngine(), hasKnowledge);

  // Reintentos del SDK en 1: los reintentos de verdad los maneja la cola, con
  // espera exponencial y respaldo al paciente si se agotan.
  const llm = new OpenAIEngine(
    async (clinicId) => {
      const key = await credentials.resolveKey(clinicId);
      return key ? openAIResponsesClient(openAIClientFor(key, { maxRetries: 1, timeoutMs: env.ENGINE_TIMEOUT_MS })) : null;
    },
    (input) => buildToolRegistry(input.clinic, { agenda, knowledge: retriever }),
    {
      model: env.OPENAI_MODEL,
      reasoningEffort: env.OPENAI_REASONING_EFFORT,
      maxToolIterations: env.ASSISTANT_MAX_TOOL_ITERATIONS,
      maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
    },
  );
  return new KnowledgeGateEngine(llm, hasKnowledge, async (clinicId) => (await credentials.resolveKey(clinicId)) !== null);
}

main().catch((err) => {
  console.error('no se pudo arrancar el worker:', err);
  process.exit(1);
});
