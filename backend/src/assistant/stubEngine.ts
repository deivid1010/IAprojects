import type { AssistantEngine, AssistantInput, AssistantReply } from './engine.js';

/**
 * Motor provisional mientras no existe el motor con LLM (fase 6). Permite
 * probar el flujo completo webhook → cola → worker → respuesta.
 *
 * Para probar fallas a mano:
 *   "#falla" → el motor lanza un error (prueba reintentos y respaldo)
 *   "#lento" → el motor no responde a tiempo (prueba el timeout)
 */
export class StubEngine implements AssistantEngine {
  readonly name = 'stub';

  async reply(input: AssistantInput, { signal }: { signal: AbortSignal }): Promise<AssistantReply> {
    const text = input.message.text;
    if (text.includes('#falla')) throw new Error('falla simulada del proveedor del LLM');
    if (text.includes('#lento')) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));

    return {
      text: `Hola, soy el asistente de ${input.clinic.name}. Recibí tu mensaje: «${text}». (Asistente en construcción.)`,
      conversationStatus: 'resuelta_por_ia',
      trace: { model: null, inputTokens: 0, outputTokens: 0, toolCalls: [] },
    };
  }
}
