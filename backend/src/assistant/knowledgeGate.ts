import type { AssistantEngine, AssistantInput, AssistantReply } from './engine.js';

export const NO_KNOWLEDGE_TEXT =
  'Lo siento, en este momento no tengo información para responder tu consulta. Ya la pasé a un asesor de la clínica, que te ayudará por este medio.';

export const NO_KNOWLEDGE_REASON = 'sin_base_de_conocimiento: la clínica no tiene documentos cargados';
export const NO_API_KEY_REASON = 'sin_api_key: la IA no está configurada para esta clínica';

/**
 * Sin API key o sin base de conocimiento el asistente no puede responder con
 * información confiable. Sin base de conocimiento no hay de dónde sacarla: se
 * responde un mensaje fijo sin llamar al LLM (sin costo y sin riesgo de que el
 * modelo improvise) y la conversación se escala a un asesor, para que aparezca
 * en la bandeja como "Escalada". Los mensajes siguientes quedan pendientes del
 * asesor hasta que la devuelva a la IA.
 */
export class KnowledgeGateEngine implements AssistantEngine {
  constructor(
    private readonly inner: AssistantEngine,
    private readonly hasKnowledge: (clinicId: string) => Promise<boolean>,
    /** Opcional: si se indica, sin API key tampoco se llama al LLM. */
    private readonly hasApiKey?: (clinicId: string) => Promise<boolean>,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  async reply(input: AssistantInput, opts: { signal: AbortSignal }): Promise<AssistantReply> {
    if (this.hasApiKey && !(await this.hasApiKey(input.clinic._id))) return automaticReply('sin_api_key', NO_API_KEY_REASON);
    if (!(await this.hasKnowledge(input.clinic._id))) return automaticReply('sin_base_de_conocimiento', NO_KNOWLEDGE_REASON);
    return this.inner.reply(input, opts);
  }
}

/** Respuesta fija sin LLM: el paciente recibe el mensaje por defecto y la conversación pasa a un asesor. */
function automaticReply(rule: string, reason: string): AssistantReply {
  return {
    text: NO_KNOWLEDGE_TEXT,
    conversationStatus: 'escalada',
    escalationReason: reason,
    trace: {
      engine: 'sin_llm',
      model: null,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
      iterations: 0,
      guardrail: rule,
    },
  };
}
