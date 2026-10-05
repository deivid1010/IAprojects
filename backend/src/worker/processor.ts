import type { AssistantEngine, AssistantReply } from '../assistant/engine.js';
import { estimateCostUsd } from '../assistant/pricing.js';
import type { CatalogRepository } from '../catalog/catalogRepository.js';
import type { ConversationsRepository } from '../messaging/conversationsRepository.js';
import type { OutboundChannel } from '../messaging/outbound/OutboundChannel.js';
import type { ConversationStatus, IncomingJob, MessageDoc } from '../messaging/types.js';

export const FALLBACK_TEXT =
  'Lo siento, en este momento no puedo responderte. Ya le avisé a un asesor de la clínica, que te contactará por este medio.';

const HISTORY_LIMIT = 20;

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ProcessorDeps {
  conversations: ConversationsRepository;
  catalog: CatalogRepository;
  engine: AssistantEngine;
  channel: OutboundChannel;
  log: Logger;
  maxAttempts: number;
  engineTimeoutMs: number;
}

export class EngineTimeoutError extends Error {
  constructor(ms: number) {
    super(`el asistente no respondió en ${ms} ms`);
    this.name = 'EngineTimeoutError';
  }
}

/** done: borrar de la cola. retry: volver a intentar más tarde. */
export type ProcessOutcome = 'done' | 'retry';

/**
 * Procesa un mensaje entrante. Es idempotente: si la cola lo entrega otra vez,
 * no se repite un turno terminado, no se vuelve a llamar al LLM si ya había
 * respuesta guardada y no se reenvía una respuesta ya enviada.
 */
export async function processIncoming(deps: ProcessorDeps, job: IncomingJob, receiveCount: number): Promise<ProcessOutcome> {
  const { conversations, log } = deps;

  const inbound = await conversations.claimInbound(job.message_id);
  if (!inbound) {
    log.info({ message_id: job.message_id }, 'mensaje ya procesado o inexistente: se descarta la reentrega');
    return 'done';
  }
  const attempt = Math.max(inbound.attempts, receiveCount);
  const isLastAttempt = attempt >= deps.maxAttempts;

  const conversation = await conversations.getConversation(job.conversation_id);
  if (conversation?.status === 'escalada') {
    // Un humano tiene la conversación: la IA no responde.
    await conversations.finishInbound(inbound._id, 'pendiente_humano');
    return 'done';
  }

  const started = Date.now();
  let reply: AssistantReply | null = null;
  try {
    if (!conversation) throw new Error(`no existe la conversación ${job.conversation_id}`);

    // Si un intento anterior ya generó la respuesta pero falló el envío, se reutiliza.
    let outbound = await conversations.findReply(inbound._id);
    if (!outbound) {
      const clinic = await deps.catalog.findClinicById(job.clinic_id);
      if (!clinic) throw new Error(`no existe la clínica ${job.clinic_id}`);
      const history = await conversations.recentMessages(conversation._id, HISTORY_LIMIT);

      reply = await withTimeout(
        (signal) => deps.engine.reply({ clinic, conversation, history, message: inbound, now: inbound.timestamp }, { signal }),
        deps.engineTimeoutMs,
      );
      outbound = await conversations.saveReply({
        inbound,
        text: reply.text,
        kind: 'respuesta',
        resultStatus: reply.conversationStatus,
        escalationReason: reply.escalationReason,
      });
    }

    await sendIfPending(deps, outbound, conversation.phone);

    const finalStatus: ConversationStatus = outbound.result_status ?? 'resuelta_por_ia';
    await conversations.finishInbound(inbound._id, 'respondido');
    await conversations.updateConversationAfterTurn({
      id: conversation._id,
      status: finalStatus,
      escalationReason: outbound.escalation_reason,
      preview: outbound.text,
    });
    await recordTurn(deps, inbound, attempt, started, reply, finalStatus, null);
    return 'done';
  } catch (err) {
    const error = errorMessage(err);
    await recordTurn(deps, inbound, attempt, started, reply, isLastAttempt ? 'escalada' : null, error);

    if (!isLastAttempt) {
      log.warn({ message_id: inbound._id, attempt, error }, 'falló el turno: se reintentará');
      await conversations.releaseInbound(inbound._id, error);
      return 'retry';
    }

    log.error({ message_id: inbound._id, attempt, error }, 'falló el último intento: respaldo y escalamiento');
    await fallback(deps, inbound, conversation?.phone, error);
    return 'done';
  }
}

/**
 * Último intento fallido: el paciente no se queda sin respuesta y la
 * conversación queda escalada para un humano, nunca a medias.
 */
async function fallback(deps: ProcessorDeps, inbound: MessageDoc, phone: string | undefined, error: string) {
  const reason = `falla_tecnica: ${error}`;
  try {
    const outbound = await deps.conversations.saveReply({
      inbound,
      text: FALLBACK_TEXT,
      kind: 'respaldo',
      resultStatus: 'escalada',
      escalationReason: reason,
    });
    if (phone) await sendIfPending(deps, outbound, phone);
  } catch (sendErr) {
    // Ni el respaldo se pudo enviar: igual queda escalada y visible en la bandeja.
    deps.log.error({ message_id: inbound._id, error: errorMessage(sendErr) }, 'no se pudo enviar el mensaje de respaldo');
  }
  await deps.conversations.finishInbound(inbound._id, 'fallido', error);
  await deps.conversations.updateConversationAfterTurn({
    id: inbound.conversation_id,
    status: 'escalada',
    escalationReason: reason,
    preview: FALLBACK_TEXT,
  });
}

async function sendIfPending(deps: ProcessorDeps, outbound: MessageDoc, phone: string) {
  if (outbound.status === 'enviado') return;
  try {
    const sent = await deps.channel.send({ clinicId: outbound.clinic_id, to: phone, text: outbound.text, idempotencyKey: outbound._id });
    await deps.conversations.markReplySent(outbound._id, sent.providerMessageId);
  } catch (err) {
    await deps.conversations.markReplyFailed(outbound._id, errorMessage(err));
    throw err;
  }
}

async function recordTurn(
  deps: ProcessorDeps,
  inbound: MessageDoc,
  attempt: number,
  started: number,
  reply: AssistantReply | null,
  finalStatus: ConversationStatus | null,
  error: string | null,
) {
  await deps.conversations.insertTurn({
    clinic_id: inbound.clinic_id,
    conversation_id: inbound.conversation_id,
    inbound_message_id: inbound._id,
    attempt,
    // Sin reply y sin error: se reutilizó la respuesta de un intento anterior.
    engine: reply ? (reply.trace.engine ?? deps.engine.name) : error ? deps.engine.name : 'reenvio',
    model: reply?.trace.model ?? null,
    input_tokens: reply?.trace.inputTokens ?? 0,
    cached_input_tokens: reply?.trace.cachedInputTokens ?? 0,
    output_tokens: reply?.trace.outputTokens ?? 0,
    iterations: reply?.trace.iterations ?? 0,
    cost_usd: reply
      ? estimateCostUsd(reply.trace.model, {
          input: reply.trace.inputTokens,
          cachedInput: reply.trace.cachedInputTokens ?? 0,
          output: reply.trace.outputTokens,
        })
      : null,
    latency_ms: Date.now() - started,
    tool_calls: reply?.trace.toolCalls ?? [],
    guardrail: reply?.trace.guardrail ?? null,
    final_status: finalStatus,
    error,
    created_at: new Date(),
  });
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new EngineTimeoutError(ms)), ms);
  try {
    const aborted = new Promise<never>((_, reject) => ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason)));
    return await Promise.race([fn(ctrl.signal), aborted]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
