import type { Clinic } from '../../catalog/schemas.js';
import type { ConversationDoc, MessageDoc } from '../../messaging/types.js';

/** Contexto de ejecución que pone el código, nunca el modelo (clínica, paciente, hora). */
export interface ToolContext {
  clinic: Clinic;
  conversation: ConversationDoc;
  message: MessageDoc;
  now: Date;
}

/** Efectos de una tool sobre el estado de la conversación. */
export interface ToolEffects {
  conversationStatus?: 'cita_agendada' | 'escalada';
  escalationReason?: string;
}

export interface ToolError {
  code: string;
  message: string;
  [detail: string]: unknown;
}

/**
 * Resultado que vuelve al modelo como function_call_output. Los errores son
 * datos, no excepciones: el modelo los lee y corrige los argumentos o le
 * pregunta al paciente.
 */
export type ToolOutcome = { ok: true; data: Record<string, unknown>; effects?: ToolEffects } | { ok: false; error: ToolError };

/** JSON Schema de los parámetros, compatible con el modo strict de OpenAI. */
export type JsonSchema = Record<string, unknown>;

/**
 * Una tool del LLM: se declara al modelo con nombre, descripción y JSON Schema;
 * el modelo decide cuándo llamarla y con qué argumentos; el código valida y
 * ejecuta.
 */
export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

export const fail = (code: string, message: string, details: Record<string, unknown> = {}): ToolOutcome => ({
  ok: false,
  error: { code, message, ...details },
});
