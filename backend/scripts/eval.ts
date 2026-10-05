import { randomUUID } from 'node:crypto';
import { CASES, type EvalCase } from '../eval/cases.js';
import { LocalAgendaProvider } from '../src/agenda/localAgendaProvider.js';
import { AppointmentsRepository } from '../src/appointments/appointmentsRepository.js';
import type { AssistantReply } from '../src/assistant/engine.js';
import { KnowledgeGateEngine } from '../src/assistant/knowledgeGate.js';
import { OpenAIEngine, openAIResponsesClient } from '../src/assistant/openaiEngine.js';
import { estimateCostUsd } from '../src/assistant/pricing.js';
import { buildToolRegistry } from '../src/assistant/tools/index.js';
import { CatalogRepository } from '../src/catalog/catalogRepository.js';
import { loadEnv } from '../src/config/env.js';
import { connectMongo } from '../src/db/mongo.js';
import { createPgPool } from '../src/db/postgres.js';
import { createKnowledge } from '../src/knowledge/setup.js';
import { createAiCredentials, openAIClientFor } from '../src/settings/setup.js';
import type { ConversationDoc, ConversationStatus, MessageDoc } from '../src/messaging/types.js';

// Evaluación del asistente con el modelo real: `npm run eval` (o `npm run eval -- alcance`
// para filtrar por id). Las citas que se crean se cancelan al terminar.

const filter = process.argv[2];
const env = loadEnv();

const pg = createPgPool(env.DATABASE_URL);
const mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
const catalog = new CatalogRepository(mongo.db);
const clinic = await catalog.findClinicById(env.DEFAULT_CLINIC_ID);
if (!clinic) throw new Error('No existe la clínica por defecto: corre npm run seed');

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

const RANK: Record<ConversationStatus, number> = { en_curso: 0, resuelta_por_ia: 1, cita_agendada: 2, escalada: 3 };
const session = `eval-${randomUUID().slice(0, 8)}`;
let totalCost = 0;

async function runCase(c: EvalCase): Promise<string[]> {
  const phone = `+57399${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const conversation = { _id: `${clinic!._id}:${phone}`, clinic_id: clinic!._id, phone, status: 'en_curso' } as ConversationDoc;
  const history: MessageDoc[] = [];
  let reply: AssistantReply | undefined;
  let status: ConversationStatus = 'en_curso';

  for (const [i, text] of c.messages.entries()) {
    const message = {
      _id: `${session}-${c.id}-${i}`,
      direction: 'inbound',
      text,
      timestamp: c.at ? new Date(c.at) : new Date(),
      clinic_id: clinic!._id,
      conversation_id: conversation._id,
    } as MessageDoc;
    history.push(message);
    reply = await engine.reply({ clinic: clinic!, conversation, history, message, now: message.timestamp }, { signal: AbortSignal.timeout(60_000) });
    if (RANK[reply.conversationStatus] >= RANK[status]) status = reply.conversationStatus;
    history.push({ ...message, _id: `${message._id}:reply`, direction: 'outbound', text: reply.text } as MessageDoc);
    totalCost += estimateCostUsd(reply.trace.model, { input: reply.trace.inputTokens, cachedInput: reply.trace.cachedInputTokens ?? 0, output: reply.trace.outputTokens }) ?? 0;
  }

  const last = reply!;
  const called = last.trace.toolCalls.map((t) => t.name);
  const failures: string[] = [];
  const e = c.expect;
  for (const t of e.toolsCalled ?? []) if (!called.includes(t)) failures.push(`no llamó a ${t} (llamó: ${called.join(', ') || 'ninguna'})`);
  for (const t of e.toolsNotCalled ?? []) if (called.includes(t)) failures.push(`llamó a ${t}`);
  for (const r of e.textMatches ?? []) if (!r.test(last.text)) failures.push(`la respuesta no contiene ${r}`);
  for (const r of e.textNotMatches ?? []) if (r.test(last.text)) failures.push(`la respuesta contiene ${r}`);
  if (e.status && status !== e.status) failures.push(`estado ${status}, se esperaba ${e.status}`);
  if (e.toolArgs) {
    const call = last.trace.toolCalls.find((t) => t.name === e.toolArgs!.tool);
    const args = (call?.arguments ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(e.toolArgs.args)) if (args[k] !== v) failures.push(`${e.toolArgs.tool}.${k} = ${JSON.stringify(args[k])}, se esperaba ${JSON.stringify(v)}`);
  }
  console.log(`${failures.length ? '✗' : '✓'} ${c.id} — ${c.description}`);
  console.log(`    respuesta: ${last.text.replace(/\n/g, ' ').slice(0, 180)}`);
  if (last.trace.guardrail) console.log(`    ⛔ guardrail: ${last.trace.guardrail}`);
  for (const f of failures) console.log(`    → ${f}`);
  return failures;
}

const selected = CASES.filter((c) => !filter || c.id.includes(filter));
if ((await chunks.countForClinic(clinic._id)) === 0) {
  console.error(`La clínica ${clinic._id} no tiene base de conocimiento: el asistente solo respondería el mensaje por defecto. Sube documentos o corre npm run seed.`);
  process.exit(1);
}
let failed = 0;
try {
  for (const c of selected) if ((await runCase(c)).length) failed++;
} finally {
  await pg.query(`UPDATE appointments SET status = 'cancelada', cancelled_at = now() WHERE source_message_id LIKE $1 AND status = 'confirmada'`, [`${session}-%`]);
  await Promise.allSettled([pg.end(), mongo.client.close()]);
}
console.log(`\n${selected.length - failed}/${selected.length} casos OK · modelo ${env.OPENAI_MODEL} · costo ≈ US$${totalCost.toFixed(5)}`);
process.exitCode = failed ? 1 : 0;
