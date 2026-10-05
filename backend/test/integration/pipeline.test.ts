import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantEngine, AssistantInput, AssistantReply } from '../../src/assistant/engine.js';
import { CatalogRepository } from '../../src/catalog/catalogRepository.js';
import { loadEnv } from '../../src/config/env.js';
import { COLLECTIONS, clinicsCollection, ensureMongoIndexes } from '../../src/db/collections.js';
import { connectMongo, type Mongo } from '../../src/db/mongo.js';
import { ConversationsRepository } from '../../src/messaging/conversationsRepository.js';
import { IngestService, QueueUnavailableError, type IncomingMessage } from '../../src/messaging/ingestService.js';
import type { OutboundChannel, OutboundMessage } from '../../src/messaging/outbound/OutboundChannel.js';
import { InMemoryMessageQueue } from '../../src/messaging/queue/inMemoryQueue.js';
import type { EnqueueOptions } from '../../src/messaging/queue/MessageQueue.js';
import { TenantResolver, UnknownClinicError } from '../../src/messaging/tenantResolver.js';
import type { IncomingJob } from '../../src/messaging/types.js';
import { FALLBACK_TEXT, processIncoming, type ProcessorDeps } from '../../src/worker/processor.js';
import { KnowledgeGateEngine, NO_KNOWLEDGE_TEXT } from '../../src/assistant/knowledgeGate.js';
import { Worker } from '../../src/worker/worker.js';
import { clinic as seedClinic } from '../../src/seed/data.js';

// Flujo completo webhook → cola → worker → respuesta, con MongoDB real, la cola
// en memoria (semántica FIFO) y motor y canal falsos. Sin LLM.

const silent = { info() {}, warn() {}, error() {} };

class FakeEngine implements AssistantEngine {
  readonly name = 'fake';
  calls: AssistantInput[] = [];
  constructor(private behavior: (input: AssistantInput, signal: AbortSignal) => Promise<AssistantReply>) {}
  setBehavior(b: typeof this.behavior) {
    this.behavior = b;
  }
  reply(input: AssistantInput, { signal }: { signal: AbortSignal }) {
    this.calls.push(input);
    return this.behavior(input, signal);
  }
}

const okReply = (text: string): AssistantReply => ({
  text,
  conversationStatus: 'resuelta_por_ia',
  trace: { model: 'fake-model', inputTokens: 100, outputTokens: 20, toolCalls: [] },
});

class FakeChannel implements OutboundChannel {
  sent: OutboundMessage[] = [];
  failuresLeft = 0;
  async send(msg: OutboundMessage) {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('whatsapp no disponible');
    }
    this.sent.push(msg);
    return { providerMessageId: `wa-${this.sent.length}` };
  }
}

/** Cola que falla al encolar las primeras N veces (simula SQS caído). */
class FlakyQueue extends InMemoryMessageQueue {
  failuresLeft = 0;
  override async enqueue(job: IncomingJob, opts: EnqueueOptions) {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('ECONNREFUSED');
    }
    return super.enqueue(job, opts);
  }
}

let mongo: Mongo;
let conversations: ConversationsRepository;
let catalog: CatalogRepository;
const clinicId = `test-${randomUUID().slice(0, 8)}`;
const wabaId = `9${Date.now()}`;

let now: number;
let queue: FlakyQueue;
let engine: FakeEngine;
let channel: FakeChannel;
let deps: ProcessorDeps;
let ingest: IngestService;
let worker: Worker;

let seq = 0;
const msg = (text: string, from = '+573001112233', overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  message_id: `wamid.${clinicId}.${++seq}`,
  from,
  text,
  timestamp: new Date(Date.UTC(2026, 9, 6, 3, 40, seq)).toISOString(),
  ...overrides,
});

/** Corre el worker hasta vaciar la cola, adelantando el reloj para los reintentos. */
async function drain(maxRounds = 20) {
  for (let i = 0; i < maxRounds && queue.size > 0; i++) {
    await worker.runOnce(0);
    now += 60_000;
  }
}

beforeAll(async () => {
  const env = loadEnv();
  mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
  await ensureMongoIndexes(mongo.db);
  conversations = new ConversationsRepository(mongo.db);
  catalog = new CatalogRepository(mongo.db);
  await clinicsCollection(mongo.db).insertOne({
    ...seedClinic,
    _id: clinicId,
    whatsapp_number: `+5798${Date.now() % 1e8}`,
    whatsapp_business_account_id: wabaId,
  });
});

afterAll(async () => {
  await clinicsCollection(mongo.db).deleteOne({ _id: clinicId });
  for (const c of [COLLECTIONS.conversations, COLLECTIONS.messages, COLLECTIONS.turns]) {
    await mongo.db.collection(c).deleteMany({ clinic_id: clinicId });
  }
  await mongo.client.close();
});

beforeEach(() => {
  now = 0;
  queue = new FlakyQueue({ maxReceiveCount: 4 }, () => now);
  engine = new FakeEngine(async (input) => okReply(`respuesta a: ${input.message.text}`));
  channel = new FakeChannel();
  deps = { conversations, catalog, engine, channel, log: silent, maxAttempts: 3, engineTimeoutMs: 200 };
  ingest = new IngestService(new TenantResolver(catalog, clinicId), conversations, queue);
  worker = new Worker(queue, deps, silent);
});

const phone = () => `+57310${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`;
const getConv = (p: string) => conversations.getConversationDetail(clinicId, `${clinicId}:${p}`);

describe('pipeline de mensajes', () => {
  it('camino feliz: guarda, encola, responde y deja traza', async () => {
    const p = phone();
    const m = msg('hola', p);
    expect(await ingest.ingest(m)).toMatchObject({ status: 'accepted' });

    await drain();

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({ to: p, text: 'respuesta a: hola' });
    const found = await getConv(p);
    expect(found?.conversation.status).toBe('resuelta_por_ia');
    expect(found?.messages.map((x) => [x.direction, x.status])).toEqual([
      ['inbound', 'respondido'],
      ['outbound', 'enviado'],
    ]);
    expect(found?.turns).toHaveLength(1);
    expect(found?.turns[0]).toMatchObject({ engine: 'fake', model: 'fake-model', input_tokens: 100, output_tokens: 20, error: null });
  });

  it('el mismo message_id dos veces se procesa una sola vez', async () => {
    const p = phone();
    const m = msg('hola', p);
    expect((await ingest.ingest(m)).status).toBe('accepted');
    expect((await ingest.ingest(m)).status).toBe('duplicate');

    await drain();
    expect(engine.calls).toHaveLength(1);
    expect(channel.sent).toHaveLength(1);
  });

  it('si la cola falla al encolar, el reintento de WhatsApp lo encola (no se pierde)', async () => {
    const p = phone();
    const m = msg('hola', p);
    queue.failuresLeft = 1;
    await expect(ingest.ingest(m)).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(queue.size).toBe(0);

    expect((await ingest.ingest(m)).status).toBe('requeued');
    await drain();
    expect(channel.sent).toHaveLength(1);
  });

  it('una reentrega de la cola no repite el turno', async () => {
    const p = phone();
    const m = msg('hola', p);
    const res = await ingest.ingest(m);
    const job = { message_id: m.message_id, clinic_id: clinicId, conversation_id: res.conversationId };

    expect(await processIncoming(deps, job, 1)).toBe('done');
    expect(await processIncoming(deps, job, 2)).toBe('done');
    expect(engine.calls).toHaveLength(1);
    expect(channel.sent).toHaveLength(1);
  });

  it('el motor falla 2 veces y al tercer intento responde', async () => {
    const p = phone();
    let failures = 2;
    engine.setBehavior(async () => {
      if (failures-- > 0) throw new Error('proveedor caído');
      return okReply('ahora sí');
    });
    await ingest.ingest(msg('hola', p));
    await drain();

    expect(channel.sent.map((s) => s.text)).toEqual(['ahora sí']);
    const found = await getConv(p);
    expect(found?.turns.map((t) => t.error)).toEqual(['proveedor caído', 'proveedor caído', null]);
    expect(found?.conversation.status).toBe('resuelta_por_ia');
  });

  it('si el motor falla siempre: mensaje de respaldo, conversación escalada y nada a medias', async () => {
    const p = phone();
    engine.setBehavior(async () => {
      throw new Error('proveedor caído');
    });
    await ingest.ingest(msg('hola', p));
    await drain();

    expect(engine.calls).toHaveLength(3);
    expect(channel.sent.map((s) => s.text)).toEqual([FALLBACK_TEXT]);
    expect(queue.deadLetters).toHaveLength(0); // se manejó en el worker, no llegó a la DLQ

    const found = await getConv(p);
    expect(found?.conversation.status).toBe('escalada');
    expect(found?.conversation.escalation_reason).toMatch(/falla_tecnica/);
    expect(found?.messages.map((x) => [x.direction, x.status, x.kind ?? null])).toEqual([
      ['inbound', 'fallido', null],
      ['outbound', 'enviado', 'respaldo'],
    ]);
  });

  it('si el motor no responde a tiempo, se trata como falla (timeout)', async () => {
    const p = phone();
    engine.setBehavior((_input, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    await ingest.ingest(msg('hola', p));
    await drain();

    const found = await getConv(p);
    expect(found?.turns[0]?.error).toMatch(/no respondió en 200 ms/);
    expect(found?.conversation.status).toBe('escalada');
  });

  it('si falla el envío, el reintento reenvía la misma respuesta sin volver a llamar al LLM', async () => {
    const p = phone();
    channel.failuresLeft = 1;
    await ingest.ingest(msg('hola', p));
    await drain();

    expect(engine.calls).toHaveLength(1);
    expect(channel.sent.map((s) => s.text)).toEqual(['respuesta a: hola']);
    const found = await getConv(p);
    expect(found?.turns.map((t) => t.engine)).toEqual(['fake', 'reenvio']);
  });

  it('con la conversación escalada, la IA no responde: queda pendiente para un humano', async () => {
    const p = phone();
    engine.setBehavior(async () => ({ ...okReply('te paso con un asesor'), conversationStatus: 'escalada', escalationReason: 'pide humano' }));
    await ingest.ingest(msg('quiero hablar con alguien', p));
    await drain();

    engine.setBehavior(async () => okReply('no debería responder'));
    await ingest.ingest(msg('¿hola?', p));
    await drain();

    expect(channel.sent.map((s) => s.text)).toEqual(['te paso con un asesor']);
    const found = await getConv(p);
    expect(found?.messages.at(-1)).toMatchObject({ text: '¿hola?', status: 'pendiente_humano' });
    expect(found?.conversation.escalation_reason).toBe('pide humano');
  });

  it('respeta el orden por paciente aunque el primer mensaje se reintente', async () => {
    const p = phone();
    let failFirst = true;
    engine.setBehavior(async (input) => {
      if (input.message.text === 'primero' && failFirst) {
        failFirst = false;
        throw new Error('falla temporal');
      }
      return okReply(`r-${input.message.text}`);
    });
    await ingest.ingest(msg('primero', p));
    await ingest.ingest(msg('segundo', p));
    await drain();

    expect(channel.sent.map((s) => s.text)).toEqual(['r-primero', 'r-segundo']);
  });

  it('el motor recibe el historial de la conversación', async () => {
    const p = phone();
    await ingest.ingest(msg('uno', p));
    await drain();
    await ingest.ingest(msg('dos', p));
    await drain();

    const last = engine.calls.at(-1)!;
    expect(last.history.map((h) => h.text)).toEqual(['uno', 'respuesta a: uno', 'dos']);
    expect(last.now.toISOString()).toBe(last.message.timestamp.toISOString());
  });

  it('resuelve la clínica por WABA y rechaza un WABA desconocido', async () => {
    const p = phone();
    await expect(ingest.ingest(msg('hola', p, { waba_id: wabaId }))).resolves.toMatchObject({ conversationId: `${clinicId}:${p}` });
    await expect(ingest.ingest(msg('hola', p, { waba_id: '1' }))).rejects.toBeInstanceOf(UnknownClinicError);
  });

  it('sin base de conocimiento: responde el mensaje por defecto sin LLM, escala la conversación y lo deja en la traza', async () => {
    const p = phone();
    worker = new Worker(queue, { ...deps, engine: new KnowledgeGateEngine(engine, async () => false) }, silent);
    await ingest.ingest(msg('¿Cuál es el horario?', p));
    await drain();

    expect(engine.calls).toHaveLength(0);
    expect(channel.sent.map((s) => s.text)).toEqual([NO_KNOWLEDGE_TEXT]);
    const found = await getConv(p);
    expect(found?.conversation.status).toBe('escalada');
    expect(found?.conversation.escalation_reason).toMatch(/sin_base_de_conocimiento/);
    expect(found?.turns[0]).toMatchObject({ engine: 'sin_llm', model: null, input_tokens: 0, cost_usd: null, guardrail: 'sin_base_de_conocimiento' });

    // Escalada de verdad: el siguiente mensaje queda para el asesor, sin respuesta automática.
    await ingest.ingest(msg('¿Hola?', p));
    await drain();
    expect(channel.sent).toHaveLength(1);
    expect((await getConv(p))?.messages.at(-1)).toMatchObject({ text: '¿Hola?', status: 'pendiente_humano' });
  });
});
