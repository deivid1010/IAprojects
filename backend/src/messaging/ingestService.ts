import { z } from 'zod';
import type { ConversationsRepository } from './conversationsRepository.js';
import type { MessageQueue } from './queue/MessageQueue.js';
import type { TenantResolver } from './tenantResolver.js';
import { conversationId } from './types.js';

// Payload del webhook (simula WhatsApp). waba_id es opcional: en la prueba hay
// una sola clínica; en producción viene siempre del webhook de Meta.
export const incomingMessageSchema = z.object({
  message_id: z.string().trim().min(1).max(256),
  from: z.string().regex(/^\+\d{8,15}$/, 'debe ser un teléfono en formato E.164, p. ej. +573001112233'),
  text: z.string().trim().min(1, 'no puede estar vacío').max(4096),
  timestamp: z.string().datetime({ offset: true, message: 'debe ser una fecha ISO 8601, p. ej. 2026-10-06T03:40:00Z' }),
  waba_id: z.string().regex(/^\d+$/).optional(),
});
export type IncomingMessage = z.infer<typeof incomingMessageSchema>;

export type IngestResult =
  | { status: 'accepted'; messageId: string; conversationId: string } // nuevo, encolado
  | { status: 'requeued'; messageId: string; conversationId: string } // duplicado que nunca llegó a la cola
  | { status: 'duplicate'; messageId: string; conversationId: string }; // ya se estaba procesando o se procesó

export class QueueUnavailableError extends Error {
  constructor(cause: unknown) {
    super('No se pudo encolar el mensaje', { cause });
    this.name = 'QueueUnavailableError';
  }
}

/**
 * Recibe un mensaje: lo guarda una sola vez, lo encola y responde rápido.
 * El asistente se ejecuta después, en el worker.
 */
export class IngestService {
  constructor(
    private readonly tenants: TenantResolver,
    private readonly conversations: ConversationsRepository,
    private readonly queue: MessageQueue,
  ) {}

  async ingest(msg: IncomingMessage): Promise<IngestResult> {
    const clinic = await this.tenants.resolve(msg.waba_id);
    const convId = conversationId(clinic._id, msg.from);
    const timestamp = new Date(msg.timestamp);

    const inserted = await this.conversations.insertInbound({
      _id: msg.message_id,
      clinic_id: clinic._id,
      conversation_id: convId,
      text: msg.text,
      timestamp,
      created_at: new Date(),
    });

    if (inserted.outcome === 'duplicate') {
      // Guardado en un intento anterior pero la cola falló: se encola ahora. Si
      // no, este reintento de WhatsApp se descartaría y el mensaje se perdería.
      if (inserted.existing.status !== 'recibido') {
        return { status: 'duplicate', messageId: msg.message_id, conversationId: inserted.existing.conversation_id };
      }
      await this.enqueue(msg.message_id, clinic._id, inserted.existing.conversation_id);
      return { status: 'requeued', messageId: msg.message_id, conversationId: inserted.existing.conversation_id };
    }

    // La bandeja se ordena por la hora del servidor, no por la de WhatsApp: si los
    // relojes no coinciden, mezclar las dos desordenaría las conversaciones.
    await this.conversations.touchConversation({ id: convId, clinicId: clinic._id, phone: msg.from, at: new Date(), preview: msg.text });
    await this.enqueue(msg.message_id, clinic._id, convId);
    return { status: 'accepted', messageId: msg.message_id, conversationId: convId };
  }

  private async enqueue(messageId: string, clinicId: string, convId: string) {
    try {
      // groupId = conversación: los mensajes de un paciente se procesan en orden y de a uno.
      // dedupId = message_id: segunda barrera contra duplicados (ventana de SQS).
      await this.queue.enqueue({ message_id: messageId, clinic_id: clinicId, conversation_id: convId }, { groupId: convId, dedupId: messageId });
    } catch (err) {
      throw new QueueUnavailableError(err);
    }
    await this.conversations.markEnqueued(messageId);
  }
}
