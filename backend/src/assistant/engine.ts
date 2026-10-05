import type { Clinic } from '../catalog/schemas.js';
import type { ConversationDoc, ConversationStatus, MessageDoc, ToolCallTrace } from '../messaging/types.js';

export interface AssistantInput {
  clinic: Clinic;
  conversation: ConversationDoc;
  /** Historial reciente en orden cronológico, incluido el mensaje actual. */
  history: MessageDoc[];
  message: MessageDoc;
  /** Hora de referencia del mensaje: base para interpretar "mañana" o "esta tarde". */
  now: Date;
}

export interface AssistantReply {
  text: string;
  conversationStatus: ConversationStatus;
  escalationReason?: string;
  trace: {
    /** Quién produjo la respuesta si no fue el motor (p. ej. 'sin_llm'). */
    engine?: string;
    model: string | null;
    inputTokens: number;
    /** Parte de inputTokens servida desde el caché del proveedor (más barata). */
    cachedInputTokens?: number;
    outputTokens: number;
    toolCalls: ToolCallTrace[];
    /** Rondas de llamadas al modelo en el turno. */
    iterations?: number;
    /** Regla de guardrail que reemplazó la respuesta del modelo, si alguna. */
    guardrail?: string | null;
  };
}

/**
 * Motor del asistente. El worker solo conoce esta interfaz: el motor con LLM
 * real (fase 6), el falso de los tests y el de prueba son intercambiables.
 */
export interface AssistantEngine {
  readonly name: string;
  reply(input: AssistantInput, opts: { signal: AbortSignal }): Promise<AssistantReply>;
}
