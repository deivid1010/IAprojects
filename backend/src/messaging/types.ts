import type { ObjectId } from 'mongodb';
import { z } from 'zod';

/** Estados del mensaje entrante a lo largo de su procesamiento. */
export type InboundStatus =
  | 'recibido' //         guardado, aún no encolado
  | 'encolado' //         en la cola, esperando al worker
  | 'procesando' //       el worker lo tomó
  | 'respondido' //       el asistente respondió
  | 'fallido' //          agotó los reintentos; se envió el mensaje de respaldo
  | 'pendiente_humano'; // la conversación está escalada: no responde la IA

export type OutboundStatus = 'pendiente_envio' | 'enviado';

/** Estado de la conversación que ve el coordinador en la bandeja. */
export type ConversationStatus = 'en_curso' | 'resuelta_por_ia' | 'cita_agendada' | 'escalada';

export interface ConversationDoc {
  _id: string; // `${clinic_id}:${phone}`: una conversación por paciente y clínica
  clinic_id: string;
  phone: string;
  status: ConversationStatus;
  escalation_reason: string | null;
  last_message_at: Date;
  last_message_preview: string;
  created_at: Date;
  updated_at: Date;
  // Totales acumulados de los turnos (para la bandeja sin recorrer las trazas).
  turns_count?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cost_usd?: number;
  released_at?: Date | null;
}

export interface MessageDoc {
  _id: string; // entrante: message_id de WhatsApp; saliente: `${message_id}:reply`
  clinic_id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  timestamp: Date;
  created_at: Date;
  status: InboundStatus | OutboundStatus;
  attempts: number;
  last_error: string | null;
  reply_to?: string; // saliente: mensaje al que responde
  kind?: 'respuesta' | 'respaldo';
  provider_message_id?: string | null;
  // Saliente: resultado del turno, para no perderlo si el envío se reintenta.
  result_status?: ConversationStatus;
  escalation_reason?: string | null;
}

export interface ToolCallTrace {
  name: string;
  arguments: unknown;
  result: unknown;
  error: string | null;
  duration_ms: number;
}

/** Traza de un turno del asistente: lo necesario para auditar y medir. */
export interface TurnDoc {
  _id?: ObjectId;
  clinic_id: string;
  conversation_id: string;
  inbound_message_id: string;
  attempt: number;
  engine: string;
  model: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  iterations: number;
  /** Costo estimado del turno en USD (null si el modelo no tiene precio conocido). */
  cost_usd: number | null;
  latency_ms: number;
  tool_calls: ToolCallTrace[];
  /** Regla de guardrail que bloqueó la respuesta original del modelo. */
  guardrail?: string | null;
  final_status: ConversationStatus | null;
  error: string | null;
  created_at: Date;
}

/** Lo que viaja por la cola: solo referencias, el contenido vive en Mongo. */
export const incomingJobSchema = z.object({
  message_id: z.string().min(1),
  clinic_id: z.string().min(1),
  conversation_id: z.string().min(1),
});
export type IncomingJob = z.infer<typeof incomingJobSchema>;

export const conversationId = (clinicId: string, phone: string) => `${clinicId}:${phone}`;
export const replyId = (inboundMessageId: string) => `${inboundMessageId}:reply`;
