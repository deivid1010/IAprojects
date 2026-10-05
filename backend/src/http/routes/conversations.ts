import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InvalidCursorError, type ConversationsRepository } from '../../messaging/conversationsRepository.js';
import { summarizeConversation } from '../../messaging/conversationSummary.js';
import type { ConversationDoc, MessageDoc, TurnDoc } from '../../messaging/types.js';
import { coordinatorClinic } from '../clinicContext.js';

type Repo = Pick<ConversationsRepository, 'listConversations' | 'countByStatus' | 'getConversationDetail' | 'releaseConversation'>;

const STATUSES = ['en_curso', 'resuelta_por_ia', 'cita_agendada', 'escalada'] as const;

const listQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  phone: z
    .string()
    .transform((p) => (p.trim().startsWith('+') ? p.trim() : `+${p.trim()}`))
    .pipe(z.string().regex(/^\+\d{8,15}$/, 'teléfono en formato E.164'))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

const idParamsSchema = z.object({ id: z.string().min(1).max(200) });

// Estados del mensaje entrante que significan "el asistente todavía no respondió".
const PENDING: MessageDoc['status'][] = ['recibido', 'encolado', 'procesando'];

const badRequest = (issues: z.ZodIssue[]) => ({
  error: 'invalid_request',
  message: issues.map((i) => `${i.path.join('.') || 'parámetro'}: ${i.message}`).join('; '),
});

export function conversationRoutes(repo: Repo, defaultClinicId: string) {
  return async (app: FastifyInstance) => {
    // Bandeja con filtro por estado (y opcionalmente por teléfono).
    app.get('/conversations', async (req, reply) => {
      const query = listQuerySchema.safeParse(req.query);
      if (!query.success) return reply.code(400).send(badRequest(query.error.issues));
      try {
        const { items, nextCursor } = await repo.listConversations({ clinicId: coordinatorClinic(req, defaultClinicId), ...query.data });
        return { items: items.map(toListItem), next_cursor: nextCursor };
      } catch (err) {
        if (err instanceof InvalidCursorError) return reply.code(400).send({ error: 'invalid_cursor', message: err.message });
        throw err;
      }
    });

    // Contadores por estado para los filtros de la bandeja.
    app.get('/conversations/summary', async (req) => {
      const counts = await repo.countByStatus(coordinatorClinic(req, defaultClinicId));
      return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
    });

    // Detalle: mensajes y, por cada respuesta del asistente, qué tools usó y cuánto costó.
    app.get('/conversations/:id', async (req, reply) => {
      const params = idParamsSchema.safeParse(req.params);
      if (!params.success) return reply.code(400).send(badRequest(params.error.issues));

      const found = await repo.getConversationDetail(coordinatorClinic(req, defaultClinicId), params.data.id);
      if (!found) return reply.code(404).send({ error: 'not_found', message: 'Conversación no encontrada' });
      return toDetail(found.conversation, found.messages, found.turns);
    });

    // Devuelve a la IA una conversación escalada.
    app.post('/conversations/:id/release', async (req, reply) => {
      const params = idParamsSchema.safeParse(req.params);
      if (!params.success) return reply.code(400).send(badRequest(params.error.issues));

      const clinicId = coordinatorClinic(req, defaultClinicId);
      const result = await repo.releaseConversation(clinicId, params.data.id);
      if (result === 'not_found') return reply.code(404).send({ error: 'not_found', message: 'Conversación no encontrada' });
      if (result === 'not_escalated') {
        return reply.code(409).send({ error: 'not_escalated', message: 'Solo se puede devolver a la IA una conversación escalada' });
      }
      const found = await repo.getConversationDetail(clinicId, params.data.id);
      return toDetail(found!.conversation, found!.messages, found!.turns);
    });
  };
}

function toListItem(c: ConversationDoc) {
  return {
    id: c._id,
    phone: c.phone,
    status: c.status,
    escalation_reason: c.escalation_reason,
    last_message_at: c.last_message_at,
    last_message_preview: c.last_message_preview,
    created_at: c.created_at,
    turns: c.turns_count ?? 0,
    cost_usd: c.total_cost_usd ?? 0,
  };
}

function toTurn(t: TurnDoc) {
  return {
    attempt: t.attempt,
    engine: t.engine,
    model: t.model,
    latency_ms: t.latency_ms,
    iterations: t.iterations ?? 0,
    tokens: { input: t.input_tokens, cached_input: t.cached_input_tokens ?? 0, output: t.output_tokens },
    cost_usd: t.cost_usd ?? null,
    final_status: t.final_status,
    error: t.error,
    guardrail: t.guardrail ?? null,
    tool_calls: t.tool_calls,
    created_at: t.created_at,
  };
}

/**
 * Vista para el coordinador: cada respuesta del asistente lleva los intentos
 * (turnos) que la produjeron, con sus tools, tokens y costo. Un mensaje del
 * paciente que todavía se está procesando lleva los intentos fallidos hasta ahora.
 */
function toDetail(conversation: ConversationDoc, messages: MessageDoc[], turns: TurnDoc[]) {
  const turnsByInbound = new Map<string, TurnDoc[]>();
  for (const t of turns) turnsByInbound.set(t.inbound_message_id, [...(turnsByInbound.get(t.inbound_message_id) ?? []), t]);
  const replied = new Set(messages.filter((m) => m.reply_to).map((m) => m.reply_to!));

  const sum = (f: (t: TurnDoc) => number) => turns.reduce((acc, t) => acc + f(t), 0);

  return {
    conversation: {
      id: conversation._id,
      clinic_id: conversation.clinic_id,
      phone: conversation.phone,
      status: conversation.status,
      escalation_reason: conversation.escalation_reason,
      created_at: conversation.created_at,
      last_message_at: conversation.last_message_at,
      released_at: conversation.released_at ?? null,
    },
    // Para el indicador "el asistente está respondiendo".
    assistant_pending: messages.some((m) => m.direction === 'inbound' && PENDING.includes(m.status)),
    // Resumen armado con reglas a partir de las trazas: no consume tokens.
    summary: summarizeConversation(conversation, messages, turns),
    totals: {
      turns: turns.length,
      tool_calls: sum((t) => t.tool_calls.length),
      input_tokens: sum((t) => t.input_tokens),
      cached_input_tokens: sum((t) => t.cached_input_tokens ?? 0),
      output_tokens: sum((t) => t.output_tokens),
      cost_usd: Math.round(sum((t) => t.cost_usd ?? 0) * 1e8) / 1e8,
      messages: messages.length,
      patient_messages: messages.filter((m) => m.direction === 'inbound').length,
      duration_ms: messages.length > 1 ? messages.at(-1)!.created_at.getTime() - messages[0]!.created_at.getTime() : 0,
      avg_latency_ms: turns.length ? Math.round(sum((t) => t.latency_ms) / turns.length) : 0,
      models: [...new Set(turns.map((t) => t.model).filter((m): m is string => Boolean(m)))],
    },
    messages: messages.map((m) => {
      const base = {
        id: m._id,
        direction: m.direction,
        text: m.text,
        timestamp: m.timestamp,
        created_at: m.created_at,
        status: m.status,
        kind: m.kind ?? null,
        reply_to: m.reply_to ?? null,
        last_error: m.last_error,
      };
      if (m.direction === 'outbound' && m.reply_to) return { ...base, turns: (turnsByInbound.get(m.reply_to) ?? []).map(toTurn) };
      if (m.direction === 'inbound' && !replied.has(m._id) && turnsByInbound.has(m._id)) {
        return { ...base, turns: turnsByInbound.get(m._id)!.map(toTurn) };
      }
      return base;
    }),
  };
}
