import { MongoServerError, type Collection, type Db, type Filter } from 'mongodb';
import { COLLECTIONS } from '../db/collections.js';
import {
  replyId,
  type ConversationDoc,
  type ConversationStatus,
  type InboundStatus,
  type MessageDoc,
  type TurnDoc,
} from './types.js';

const DUPLICATE_KEY = 11000;
const PREVIEW_LENGTH = 120;

// Estados que ya no se reprocesan si la cola entrega el mensaje otra vez.
const TERMINAL_INBOUND: InboundStatus[] = ['respondido', 'fallido', 'pendiente_humano'];

// Si un turno da un resultado "menor" que el que ya tenía la conversación, se
// conserva el mayor: una conversación con cita agendada no vuelve a
// "resuelta_por_ia" porque el paciente después diga "gracias".
const STATUS_RANK: Record<ConversationStatus, number> = { en_curso: 0, resuelta_por_ia: 1, cita_agendada: 2, escalada: 3 };

export function mergeConversationStatus(current: ConversationStatus, next: ConversationStatus): ConversationStatus {
  return STATUS_RANK[next] >= STATUS_RANK[current] ? next : current;
}

export type InsertInboundResult = { outcome: 'inserted' } | { outcome: 'duplicate'; existing: MessageDoc };

export class ConversationsRepository {
  private readonly conversations: Collection<ConversationDoc>;
  private readonly messages: Collection<MessageDoc>;
  private readonly turns: Collection<TurnDoc>;

  constructor(db: Db) {
    this.conversations = db.collection<ConversationDoc>(COLLECTIONS.conversations);
    this.messages = db.collection<MessageDoc>(COLLECTIONS.messages);
    this.turns = db.collection<TurnDoc>(COLLECTIONS.turns);
  }

  // --- Ingesta -------------------------------------------------------------

  /** La idempotencia la da el _id = message_id: un duplicado falla al insertar. */
  async insertInbound(msg: Omit<MessageDoc, 'direction' | 'status' | 'attempts' | 'last_error'>): Promise<InsertInboundResult> {
    try {
      await this.messages.insertOne({ ...msg, direction: 'inbound', status: 'recibido', attempts: 0, last_error: null });
      return { outcome: 'inserted' };
    } catch (err) {
      if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) {
        const existing = await this.messages.findOne({ _id: msg._id });
        if (existing) return { outcome: 'duplicate', existing };
      }
      throw err;
    }
  }

  /** Crea la conversación si no existe y actualiza su último mensaje. */
  async touchConversation(input: { id: string; clinicId: string; phone: string; at: Date; preview: string }): Promise<void> {
    const now = new Date();
    await this.conversations.updateOne(
      { _id: input.id },
      {
        $setOnInsert: { clinic_id: input.clinicId, phone: input.phone, status: 'en_curso', escalation_reason: null, created_at: now },
        $max: { last_message_at: input.at },
        $set: { last_message_preview: input.preview.slice(0, PREVIEW_LENGTH), updated_at: now },
      },
      { upsert: true },
    );
  }

  /**
   * recibido → encolado, solo si sigue en "recibido". Si el worker ya lo tomó
   * (carrera entre encolar y marcar), no se pisa su estado.
   */
  async markEnqueued(messageId: string): Promise<void> {
    await this.messages.updateOne({ _id: messageId, status: 'recibido' }, { $set: { status: 'encolado' } });
  }

  // --- Worker --------------------------------------------------------------

  /**
   * Toma el mensaje para procesarlo. Devuelve null si ya estaba terminado
   * (reentrega de la cola): ese turno no se repite.
   */
  async claimInbound(messageId: string): Promise<MessageDoc | null> {
    return this.messages.findOneAndUpdate(
      { _id: messageId, direction: 'inbound', status: { $nin: TERMINAL_INBOUND } },
      { $set: { status: 'procesando' }, $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
  }

  async finishInbound(messageId: string, status: Extract<InboundStatus, 'respondido' | 'fallido' | 'pendiente_humano'>, error: string | null = null) {
    await this.messages.updateOne({ _id: messageId }, { $set: { status, last_error: error } });
  }

  /** El intento falló pero habrá otro: vuelve a "encolado" con el error registrado. */
  async releaseInbound(messageId: string, error: string): Promise<void> {
    await this.messages.updateOne({ _id: messageId, status: 'procesando' }, { $set: { status: 'encolado', last_error: error } });
  }

  async getConversation(id: string): Promise<ConversationDoc | null> {
    return this.conversations.findOne({ _id: id });
  }

  /**
   * Últimos mensajes de la conversación en el orden en que los recibió el
   * servidor (created_at). No se ordena por `timestamp` (hora de WhatsApp): si
   * el reloj del remitente no coincide con el del servidor, la respuesta podría
   * quedar antes que la pregunta.
   */
  async recentMessages(conversationId: string, limit: number): Promise<MessageDoc[]> {
    const docs = await this.messages.find({ conversation_id: conversationId }).sort({ created_at: -1, _id: -1 }).limit(limit).toArray();
    return docs.reverse();
  }

  async findReply(inboundMessageId: string): Promise<MessageDoc | null> {
    return this.messages.findOne({ _id: replyId(inboundMessageId) });
  }

  /**
   * Guarda la respuesta antes de enviarla. Si el envío falla y hay reintento,
   * se reenvía esta misma respuesta sin volver a llamar al LLM.
   */
  async saveReply(input: {
    inbound: MessageDoc;
    text: string;
    kind: 'respuesta' | 'respaldo';
    resultStatus: ConversationStatus;
    escalationReason?: string | null;
  }): Promise<MessageDoc> {
    const now = new Date();
    const doc: MessageDoc = {
      _id: replyId(input.inbound._id),
      clinic_id: input.inbound.clinic_id,
      conversation_id: input.inbound.conversation_id,
      direction: 'outbound',
      text: input.text,
      timestamp: now,
      created_at: now,
      status: 'pendiente_envio',
      attempts: 0,
      last_error: null,
      reply_to: input.inbound._id,
      kind: input.kind,
      provider_message_id: null,
      result_status: input.resultStatus,
      escalation_reason: input.escalationReason ?? null,
    };
    // Upsert: si ya existía una respuesta no enviada (p. ej. la normal antes de
    // pasar a respaldo), se reemplaza.
    await this.messages.replaceOne({ _id: doc._id, status: { $ne: 'enviado' } }, doc, { upsert: true }).catch((err) => {
      if (!(err instanceof MongoServerError && err.code === DUPLICATE_KEY)) throw err;
    });
    return (await this.messages.findOne({ _id: doc._id }))!;
  }

  async markReplySent(replyMessageId: string, providerMessageId: string | null): Promise<void> {
    await this.messages.updateOne(
      { _id: replyMessageId },
      { $set: { status: 'enviado', provider_message_id: providerMessageId, timestamp: new Date() }, $inc: { attempts: 1 } },
    );
  }

  async markReplyFailed(replyMessageId: string, error: string): Promise<void> {
    await this.messages.updateOne({ _id: replyMessageId }, { $set: { last_error: error }, $inc: { attempts: 1 } });
  }

  async updateConversationAfterTurn(input: {
    id: string;
    status: ConversationStatus;
    escalationReason?: string | null;
    preview: string;
  }): Promise<void> {
    const current = await this.conversations.findOne({ _id: input.id });
    if (!current) return;
    const status = mergeConversationStatus(current.status, input.status);
    const now = new Date();
    await this.conversations.updateOne(
      { _id: input.id },
      {
        $set: {
          status,
          escalation_reason: status === 'escalada' ? (input.escalationReason ?? current.escalation_reason) : null,
          last_message_preview: input.preview.slice(0, PREVIEW_LENGTH),
          updated_at: now,
        },
        $max: { last_message_at: now },
      },
    );
  }

  /** Guarda la traza del turno y acumula sus totales en la conversación. */
  async insertTurn(turn: TurnDoc): Promise<void> {
    await this.turns.insertOne(turn);
    await this.conversations.updateOne(
      { _id: turn.conversation_id },
      {
        $inc: {
          turns_count: 1,
          total_input_tokens: turn.input_tokens,
          total_output_tokens: turn.output_tokens,
          total_cost_usd: turn.cost_usd ?? 0,
        },
      },
    );
  }

  // --- Lectura (API del coordinador) ---------------------------------------

  /**
   * Bandeja: conversaciones de una clínica, más recientes primero. Paginación
   * por cursor (keyset sobre last_message_at + _id): estable aunque lleguen
   * mensajes nuevos mientras el coordinador pagina, y usa el índice sin skip.
   */
  async listConversations(query: ListConversationsQuery): Promise<{ items: ConversationDoc[]; nextCursor: string | null }> {
    const filter: Filter<ConversationDoc> = { clinic_id: query.clinicId };
    if (query.status) filter.status = query.status;
    if (query.phone) filter.phone = query.phone;
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      filter.$or = [{ last_message_at: { $lt: c.at } }, { last_message_at: c.at, _id: { $lt: c.id } }];
    }

    const docs = await this.conversations
      .find(filter)
      .sort({ last_message_at: -1, _id: -1 })
      .limit(query.limit + 1)
      .toArray();
    const items = docs.slice(0, query.limit);
    const last = items.at(-1);
    return { items, nextCursor: docs.length > query.limit && last ? encodeCursor(last.last_message_at, last._id) : null };
  }

  /** Cuántas conversaciones hay en cada estado (contadores de la bandeja). */
  async countByStatus(clinicId: string): Promise<Record<ConversationStatus, number>> {
    const counts: Record<ConversationStatus, number> = { en_curso: 0, resuelta_por_ia: 0, cita_agendada: 0, escalada: 0 };
    const rows = await this.conversations
      .aggregate<{ _id: ConversationStatus; n: number }>([{ $match: { clinic_id: clinicId } }, { $group: { _id: '$status', n: { $sum: 1 } } }])
      .toArray();
    for (const r of rows) counts[r._id] = r.n;
    return counts;
  }

  /** Conversación con todos sus mensajes y trazas. null si no existe o es de otra clínica. */
  async getConversationDetail(clinicId: string, conversationId: string) {
    const conversation = await this.conversations.findOne({ _id: conversationId, clinic_id: clinicId });
    if (!conversation) return null;
    const [messages, turns] = await Promise.all([
      this.messages.find({ conversation_id: conversationId }).sort({ created_at: 1, _id: 1 }).toArray(),
      this.turns.find({ conversation_id: conversationId }).sort({ created_at: 1 }).toArray(),
    ]);
    return { conversation, messages, turns };
  }

  /**
   * Devuelve a la IA una conversación escalada. Es un cambio explícito del
   * coordinador, por eso salta la regla de "no bajar de estado".
   */
  async releaseConversation(clinicId: string, conversationId: string): Promise<'released' | 'not_found' | 'not_escalated'> {
    const now = new Date();
    const res = await this.conversations.updateOne(
      { _id: conversationId, clinic_id: clinicId, status: 'escalada' },
      { $set: { status: 'en_curso', escalation_reason: null, released_at: now, updated_at: now } },
    );
    if (res.matchedCount === 1) return 'released';
    const exists = await this.conversations.countDocuments({ _id: conversationId, clinic_id: clinicId });
    return exists ? 'not_escalated' : 'not_found';
  }
}

export interface ListConversationsQuery {
  clinicId: string;
  status?: ConversationStatus;
  phone?: string;
  limit: number;
  cursor?: string;
}

export class InvalidCursorError extends Error {
  constructor() {
    super('Cursor de paginación inválido');
    this.name = 'InvalidCursorError';
  }
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const { at, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const date = new Date(at);
    if (typeof id !== 'string' || Number.isNaN(date.getTime())) throw new Error();
    return { at: date, id };
  } catch {
    throw new InvalidCursorError();
  }
}
