import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { LocalAgendaProvider } from '../src/agenda/localAgendaProvider.js';
import { AppointmentsRepository } from '../src/appointments/appointmentsRepository.js';
import { KnowledgeGateEngine } from '../src/assistant/knowledgeGate.js';
import { OpenAIEngine, openAIResponsesClient } from '../src/assistant/openaiEngine.js';
import { buildToolRegistry } from '../src/assistant/tools/index.js';
import { CatalogRepository } from '../src/catalog/catalogRepository.js';
import { loadEnv } from '../src/config/env.js';
import { connectMongo } from '../src/db/mongo.js';
import { createKnowledge } from '../src/knowledge/setup.js';
import { createAiCredentials, openAIClientFor } from '../src/settings/setup.js';
import { createPgPool } from '../src/db/postgres.js';
import type { ConversationDoc, MessageDoc } from '../src/messaging/types.js';

// Conversación de prueba con el motor real (OpenAI + agenda local), sin cola ni
// worker. Cada línea de entrada es un mensaje del paciente.
//
//   npm run chat                                   # interactivo
//   npm run chat -- --at 2026-10-06T03:40:00Z      # fija la hora del mensaje
//   printf 'hola\n¿tienen dermatología mañana?\n' | npm run chat
//
// Las citas que se creen quedan en la base (source_message_id "chat-…"); con
// --cleanup se cancelan al terminar.

const args = process.argv.slice(2);
const at = args.includes('--at') ? new Date(args[args.indexOf('--at') + 1]!) : null;
const cleanup = args.includes('--cleanup');

const env = loadEnv();

const pg = createPgPool(env.DATABASE_URL);
const mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
const catalog = new CatalogRepository(mongo.db);
const clinic = await catalog.findClinicById(env.DEFAULT_CLINIC_ID);
if (!clinic) throw new Error(`No existe la clínica ${env.DEFAULT_CLINIC_ID}: corre npm run seed`);

const agenda = new LocalAgendaProvider(catalog, new AppointmentsRepository(pg));
const credentials = createAiCredentials(env, mongo.db);
const { retriever, chunks } = createKnowledge(env, pg, credentials);
const engine = new KnowledgeGateEngine(new OpenAIEngine(
  async (clinicId) => {
    const key = await credentials.resolveKey(clinicId);
    return key ? openAIResponsesClient(openAIClientFor(key, { maxRetries: 1 })) : null;
  },
  (input) => buildToolRegistry(input.clinic, { agenda, knowledge: retriever }),
  {
    model: env.OPENAI_MODEL,
    reasoningEffort: env.OPENAI_REASONING_EFFORT,
    maxToolIterations: env.ASSISTANT_MAX_TOOL_ITERATIONS,
    maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
  },
), async (clinicId) => (await chunks.countForClinic(clinicId)) > 0, async (clinicId) => (await credentials.resolveKey(clinicId)) !== null);

const phone = '+573000000999';
const session = randomUUID().slice(0, 8);
const conversation = { _id: `${clinic._id}:${phone}`, clinic_id: clinic._id, phone, status: 'en_curso' } as ConversationDoc;
const history: MessageDoc[] = [];
const totals = { input: 0, cached: 0, output: 0 };

console.log(`Clínica: ${clinic.name} · modelo: ${env.OPENAI_MODEL}${at ? ` · hora fija: ${at.toISOString()}` : ''}\n`);

const rl = createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
if (process.stdin.isTTY) process.stdout.write('paciente> ');

for await (const line of rl) {
  const text = line.trim();
  if (!text) continue;
  if (!process.stdin.isTTY) console.log(`paciente> ${text}`);

  const message = {
    _id: `chat-${session}-${history.length}`,
    direction: 'inbound',
    text,
    timestamp: at ?? new Date(),
    clinic_id: clinic._id,
    conversation_id: conversation._id,
  } as MessageDoc;
  history.push(message);

  const started = Date.now();
  const reply = await engine.reply(
    { clinic, conversation, history, message, now: message.timestamp },
    { signal: AbortSignal.timeout(env.ENGINE_TIMEOUT_MS) },
  );

  for (const t of reply.trace.toolCalls) {
    console.log(`  ⚙ ${t.name}(${JSON.stringify(t.arguments)})`);
    console.log(`    → ${t.error ? `ERROR ${t.error}` : JSON.stringify(t.result).slice(0, 400)}`);
  }
  if (reply.trace.engine === 'sin_llm') console.log(`  ⚠ respuesta automática sin LLM (${reply.trace.guardrail})`);
  else if (reply.trace.guardrail) console.log(`  ⛔ guardrail: ${reply.trace.guardrail} (se reemplazó la respuesta del modelo)`);
  console.log(`asistente> ${reply.text}`);
  console.log(
    `  [${reply.conversationStatus}${reply.escalationReason ? `: ${reply.escalationReason}` : ''} · ` +
      `${reply.trace.iterations} rondas · tokens in ${reply.trace.inputTokens} (caché ${reply.trace.cachedInputTokens}) / out ${reply.trace.outputTokens} · ${Date.now() - started} ms]\n`,
  );

  totals.input += reply.trace.inputTokens;
  totals.cached += reply.trace.cachedInputTokens ?? 0;
  totals.output += reply.trace.outputTokens;
  history.push({ ...message, _id: `${message._id}:reply`, direction: 'outbound', text: reply.text } as MessageDoc);
  if (process.stdin.isTTY) process.stdout.write('paciente> ');
}

console.log(`Total tokens: entrada ${totals.input} (caché ${totals.cached}) · salida ${totals.output}`);
if (cleanup) {
  const { rowCount } = await pg.query(
    `UPDATE appointments SET status = 'cancelada', cancelled_at = now() WHERE source_message_id LIKE $1 AND status = 'confirmada'`,
    [`chat-${session}-%`],
  );
  console.log(`--cleanup: ${rowCount} cita(s) de esta sesión canceladas`);
}
await Promise.allSettled([pg.end(), mongo.client.close()]);
