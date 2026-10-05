import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { COLLECTIONS, ensureMongoIndexes } from '../../src/db/collections.js';
import { connectMongo, type Mongo } from '../../src/db/mongo.js';
import { ConversationsRepository, InvalidCursorError } from '../../src/messaging/conversationsRepository.js';
import type { ConversationDoc, ConversationStatus } from '../../src/messaging/types.js';

let mongo: Mongo;
let repo: ConversationsRepository;
const run = randomUUID().slice(0, 8);
const clinicA = `test-a-${run}`;
const clinicB = `test-b-${run}`;

// 7 conversaciones en A (dos con la misma fecha, para probar el desempate) y 1 en B.
const STATUSES: ConversationStatus[] = ['resuelta_por_ia', 'escalada', 'cita_agendada', 'resuelta_por_ia', 'escalada', 'en_curso', 'resuelta_por_ia'];
const conv = (clinicId: string, i: number, status: ConversationStatus, at: Date): ConversationDoc => ({
  _id: `${clinicId}:+57300000000${i}`,
  clinic_id: clinicId,
  phone: `+57300000000${i}`,
  status,
  escalation_reason: status === 'escalada' ? 'pide humano' : null,
  last_message_at: at,
  last_message_preview: `mensaje ${i}`,
  created_at: at,
  updated_at: at,
});

beforeAll(async () => {
  const env = loadEnv();
  mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
  await ensureMongoIndexes(mongo.db);
  repo = new ConversationsRepository(mongo.db);
  const docs = STATUSES.map((s, i) => conv(clinicA, i, s, new Date(Date.UTC(2026, 9, 6, 10, i === 6 ? 5 : i))));
  docs.push(conv(clinicB, 9, 'escalada', new Date(Date.UTC(2026, 9, 6, 12))));
  await mongo.db.collection<ConversationDoc>(COLLECTIONS.conversations).insertMany(docs);
});

afterAll(async () => {
  for (const c of [COLLECTIONS.conversations, COLLECTIONS.turns]) {
    await mongo.db.collection(c).deleteMany({ clinic_id: { $in: [clinicA, clinicB] } });
  }
  await mongo.client.close();
});

describe('bandeja del coordinador', () => {
  it('pagina con cursor sin repetir ni saltar conversaciones, aun con fechas empatadas', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repo.listConversations({ clinicId: clinicA, limit: 3, cursor });
      seen.push(...page.items.map((c) => c.phone));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    // Más recientes primero; las de 10:05 empatan y desempata el _id (descendente).
    expect(seen.slice(0, 2)).toEqual(['+573000000006', '+573000000005']);
  });

  it('filtra por estado y por teléfono', async () => {
    const escaladas = await repo.listConversations({ clinicId: clinicA, status: 'escalada', limit: 10 });
    expect(escaladas.items.map((c) => c.phone)).toEqual(['+573000000004', '+573000000001']);
    const one = await repo.listConversations({ clinicId: clinicA, phone: '+573000000002', limit: 10 });
    expect(one.items.map((c) => c.status)).toEqual(['cita_agendada']);
  });

  it('cuenta por estado solo dentro de la clínica', async () => {
    expect(await repo.countByStatus(clinicA)).toEqual({ en_curso: 1, resuelta_por_ia: 3, cita_agendada: 1, escalada: 2 });
    expect(await repo.countByStatus(clinicB)).toEqual({ en_curso: 0, resuelta_por_ia: 0, cita_agendada: 0, escalada: 1 });
  });

  it('una clínica no ve ni libera conversaciones de otra', async () => {
    const id = `${clinicB}:+573000000009`;
    expect(await repo.getConversationDetail(clinicA, id)).toBeNull();
    expect(await repo.releaseConversation(clinicA, id)).toBe('not_found');
    expect((await repo.listConversations({ clinicId: clinicA, limit: 50 })).items.every((c) => c.clinic_id === clinicA)).toBe(true);
  });

  it('libera una conversación escalada y rechaza liberar una que no lo está', async () => {
    const id = `${clinicA}:+573000000001`;
    expect(await repo.releaseConversation(clinicA, id)).toBe('released');
    const detail = await repo.getConversationDetail(clinicA, id);
    expect(detail?.conversation).toMatchObject({ status: 'en_curso', escalation_reason: null });
    expect(detail?.conversation.released_at).toBeInstanceOf(Date);
    expect(await repo.releaseConversation(clinicA, id)).toBe('not_escalated');
  });

  it('acumula tokens y costo de los turnos en la conversación', async () => {
    const id = `${clinicA}:+573000000002`;
    const base = {
      clinic_id: clinicA,
      conversation_id: id,
      inbound_message_id: 'm',
      attempt: 1,
      engine: 'openai',
      model: 'gpt-6-luna',
      cached_input_tokens: 0,
      iterations: 1,
      latency_ms: 1,
      tool_calls: [],
      final_status: null,
      error: null,
      created_at: new Date(),
    };
    await repo.insertTurn({ ...base, input_tokens: 1000, output_tokens: 100, cost_usd: 0.0002 });
    await repo.insertTurn({ ...base, input_tokens: 500, output_tokens: 50, cost_usd: null });
    const [item] = (await repo.listConversations({ clinicId: clinicA, phone: '+573000000002', limit: 1 })).items;
    expect(item).toMatchObject({ turns_count: 2, total_input_tokens: 1500, total_output_tokens: 150, total_cost_usd: 0.0002 });
  });

  it('rechaza un cursor manipulado', async () => {
    await expect(repo.listConversations({ clinicId: clinicA, limit: 3, cursor: 'no-es-un-cursor' })).rejects.toBeInstanceOf(InvalidCursorError);
  });
});
