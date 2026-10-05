import { ObjectId, type WithId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { InvalidCursorError, type ListConversationsQuery } from '../src/messaging/conversationsRepository.js';
import type { ConversationDoc, MessageDoc, TurnDoc } from '../src/messaging/types.js';
import { fakeAppDeps } from './helpers.js';

const at = (iso: string) => new Date(iso);
const conversation: ConversationDoc = {
  _id: 'clinica-test:+573001112233',
  clinic_id: 'clinica-test',
  phone: '+573001112233',
  status: 'cita_agendada',
  escalation_reason: null,
  last_message_at: at('2026-10-06T03:42:00Z'),
  last_message_preview: '¡Cita confirmada!',
  created_at: at('2026-10-06T03:40:00Z'),
  updated_at: at('2026-10-06T03:42:00Z'),
  turns_count: 2,
  total_cost_usd: 0.0003,
};

const msg = (m: Partial<MessageDoc>): MessageDoc =>
  ({ clinic_id: 'clinica-test', conversation_id: conversation._id, attempts: 0, last_error: null, created_at: at('2026-10-06T03:40:00Z'), timestamp: at('2026-10-06T03:40:00Z'), ...m }) as MessageDoc;

const turn = (t: Partial<TurnDoc>): WithId<TurnDoc> => ({
  _id: new ObjectId(),
  clinic_id: 'clinica-test',
  conversation_id: conversation._id,
  inbound_message_id: 'wamid.1',
  attempt: 1,
  engine: 'openai',
  model: 'gpt-6-luna',
  input_tokens: 3000,
  cached_input_tokens: 1300,
  output_tokens: 120,
  iterations: 2,
  cost_usd: 0.00024,
  latency_ms: 4000,
  tool_calls: [],
  final_status: 'resuelta_por_ia',
  error: null,
  created_at: at('2026-10-06T03:40:05Z'),
  ...t,
});

const messages: MessageDoc[] = [
  msg({ _id: 'wamid.1', direction: 'inbound', text: '¿Dermatología mañana en la tarde?', status: 'respondido' }),
  msg({ _id: 'wamid.1:reply', direction: 'outbound', text: 'Hay horarios desde las 2:00 p. m.', status: 'enviado', reply_to: 'wamid.1', kind: 'respuesta' }),
  msg({ _id: 'wamid.2', direction: 'inbound', text: 'A las 3', status: 'procesando' }),
];
const turns: WithId<TurnDoc>[] = [
  turn({
    tool_calls: [{ name: 'consultar_disponibilidad', arguments: { fecha: 'manana' }, result: { total_horarios: 8 }, error: null, duration_ms: 30 }],
  }),
  turn({ inbound_message_id: 'wamid.2', error: 'proveedor caído', final_status: null, cost_usd: null, tool_calls: [] }),
];

function appWith(overrides: Partial<ReturnType<typeof fakeAppDeps>['conversations']> = {}) {
  const calls: { list: ListConversationsQuery[]; detail: [string, string][] } = { list: [], detail: [] };
  const deps = fakeAppDeps();
  const app = buildApp({
    ...deps,
    conversations: {
      ...deps.conversations,
      listConversations: async (q) => {
        calls.list.push(q);
        return { items: [conversation], nextCursor: 'abc' };
      },
      getConversationDetail: async (clinicId, id) => {
        calls.detail.push([clinicId, id]);
        // Como el repositorio real: solo encuentra la conversación dentro de su clínica.
        return clinicId === conversation.clinic_id && id === conversation._id ? { conversation, messages, turns } : null;
      },
      ...overrides,
    },
  });
  return { app, calls };
}

describe('GET /conversations (bandeja)', () => {
  it('lista con filtro por estado y devuelve el cursor de la siguiente página', async () => {
    const { app, calls } = appWith();
    const res = await app.inject({ method: 'GET', url: '/conversations?status=escalada&limit=10' });
    expect(res.statusCode).toBe(200);
    expect(calls.list[0]).toEqual({ clinicId: 'clinica-test', status: 'escalada', limit: 10 });
    expect(res.json()).toMatchObject({
      next_cursor: 'abc',
      items: [{ id: conversation._id, phone: '+573001112233', status: 'cita_agendada', turns: 2, cost_usd: 0.0003 }],
    });
  });

  it('la clínica sale del header X-Clinic-Id, no de la URL', async () => {
    const { app, calls } = appWith();
    await app.inject({ method: 'GET', url: '/conversations?clinic_id=otra', headers: { 'x-clinic-id': 'clinica-b' } });
    expect(calls.list[0]!.clinicId).toBe('clinica-b');
  });

  it('normaliza el filtro por teléfono', async () => {
    const { app, calls } = appWith();
    await app.inject({ method: 'GET', url: '/conversations?phone=573001112233' });
    expect(calls.list[0]!.phone).toBe('+573001112233');
  });

  it.each([
    ['estado inexistente', '/conversations?status=perdida'],
    ['límite fuera de rango', '/conversations?limit=500'],
    ['teléfono inválido', '/conversations?phone=abc'],
  ])('400 con %s', async (_n, url) => {
    expect((await appWith().app.inject({ method: 'GET', url })).statusCode).toBe(400);
  });

  it('400 con un cursor inválido', async () => {
    const { app } = appWith({
      listConversations: async () => {
        throw new InvalidCursorError();
      },
    });
    const res = await app.inject({ method: 'GET', url: '/conversations?cursor=basura' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_cursor');
  });
});

describe('GET /conversations/summary', () => {
  it('devuelve los contadores por estado y el total', async () => {
    const { app } = appWith({ countByStatus: async () => ({ en_curso: 1, resuelta_por_ia: 5, cita_agendada: 3, escalada: 2 }) });
    const res = await app.inject({ method: 'GET', url: '/conversations/summary' });
    expect(res.json()).toEqual({ counts: { en_curso: 1, resuelta_por_ia: 5, cita_agendada: 3, escalada: 2 }, total: 11 });
  });
});

describe('GET /conversations/:id (detalle)', () => {
  it('cada respuesta del asistente trae sus turnos con tools, tokens y costo', async () => {
    const { app } = appWith();
    const res = await app.inject({ method: 'GET', url: `/conversations/${encodeURIComponent(conversation._id)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const reply = body.messages.find((m: { id: string }) => m.id === 'wamid.1:reply');
    expect(reply.turns).toHaveLength(1);
    expect(reply.turns[0]).toMatchObject({
      model: 'gpt-6-luna',
      tokens: { input: 3000, cached_input: 1300, output: 120 },
      cost_usd: 0.00024,
      tool_calls: [{ name: 'consultar_disponibilidad', result: { total_horarios: 8 } }],
    });
  });

  it('un mensaje aún en proceso muestra sus intentos fallidos y activa "asistente respondiendo"', async () => {
    const body = (await appWith().app.inject({ method: 'GET', url: `/conversations/${encodeURIComponent(conversation._id)}` })).json();
    expect(body.assistant_pending).toBe(true);
    const pending = body.messages.find((m: { id: string }) => m.id === 'wamid.2');
    expect(pending.turns[0]).toMatchObject({ error: 'proveedor caído' });
  });

  it('suma los totales de la conversación', async () => {
    const body = (await appWith().app.inject({ method: 'GET', url: `/conversations/${encodeURIComponent(conversation._id)}` })).json();
    expect(body.totals).toEqual({
      turns: 2,
      tool_calls: 1,
      input_tokens: 6000,
      cached_input_tokens: 2600,
      output_tokens: 240,
      cost_usd: 0.00024,
      messages: 3,
      patient_messages: 2,
      duration_ms: 0,
      avg_latency_ms: 4000,
      models: ['gpt-6-luna'],
    });
  });

  it('incluye el resumen armado sin LLM a partir de las trazas', async () => {
    const body = (await appWith().app.inject({ method: 'GET', url: `/conversations/${encodeURIComponent(conversation._id)}` })).json();
    expect(body.summary.reason).toBe('¿Dermatología mañana en la tarde?');
    expect(body.summary.text).toMatch(/El paciente escribió/);
  });

  it('404 si no existe o es de otra clínica', async () => {
    const { app, calls } = appWith();
    const res = await app.inject({ method: 'GET', url: `/conversations/${encodeURIComponent(conversation._id)}`, headers: { 'x-clinic-id': 'otra' } });
    expect(calls.detail[0]).toEqual(['otra', conversation._id]);
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /conversations/:id/release', () => {
  const url = `/conversations/${encodeURIComponent(conversation._id)}/release`;

  it('devuelve la conversación actualizada', async () => {
    const { app } = appWith({ releaseConversation: async () => 'released' });
    const res = await app.inject({ method: 'POST', url });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.id).toBe(conversation._id);
  });

  it('409 si la conversación no estaba escalada', async () => {
    const { app } = appWith({ releaseConversation: async () => 'not_escalated' });
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(409);
  });

  it('404 si no existe', async () => {
    expect((await appWith().app.inject({ method: 'POST', url })).statusCode).toBe(404);
  });
});

describe('CORS', () => {
  it('permite el origen del frontend configurado', async () => {
    const app = buildApp({ ...fakeAppDeps(), corsOrigins: ['http://localhost:5173'] });
    const res = await app.inject({ method: 'OPTIONS', url: '/conversations', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
