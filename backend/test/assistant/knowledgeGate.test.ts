import { describe, expect, it } from 'vitest';
import type { AssistantEngine, AssistantInput } from '../../src/assistant/engine.js';
import { KnowledgeGateEngine, NO_KNOWLEDGE_REASON, NO_KNOWLEDGE_TEXT } from '../../src/assistant/knowledgeGate.js';
import { testClinic } from '../agenda/fakes.js';

const input = { clinic: testClinic, history: [], message: { text: 'hola' } } as unknown as AssistantInput;
const signal = new AbortController().signal;

function innerEngine() {
  const calls: AssistantInput[] = [];
  const engine: AssistantEngine = {
    name: 'openai',
    async reply(i) {
      calls.push(i);
      return { text: 'respuesta del LLM', conversationStatus: 'resuelta_por_ia', trace: { model: 'm', inputTokens: 10, outputTokens: 5, toolCalls: [] } };
    },
  };
  return { engine, calls };
}

describe('KnowledgeGateEngine', () => {
  it('sin base de conocimiento responde el mensaje por defecto, escala y NO llama al LLM', async () => {
    const { engine, calls } = innerEngine();
    const reply = await new KnowledgeGateEngine(engine, async () => false).reply(input, { signal });
    expect(calls).toHaveLength(0);
    expect(reply.text).toBe(NO_KNOWLEDGE_TEXT);
    expect(reply.conversationStatus).toBe('escalada');
    expect(reply.escalationReason).toBe(NO_KNOWLEDGE_REASON);
    expect(reply.trace).toMatchObject({ engine: 'sin_llm', model: null, inputTokens: 0, outputTokens: 0, guardrail: 'sin_base_de_conocimiento' });
  });

  it('con base de conocimiento delega en el motor', async () => {
    const { engine, calls } = innerEngine();
    const reply = await new KnowledgeGateEngine(engine, async () => true).reply(input, { signal });
    expect(calls).toHaveLength(1);
    expect(reply.text).toBe('respuesta del LLM');
  });

  it('consulta la base de la clínica del mensaje', async () => {
    const asked: string[] = [];
    await new KnowledgeGateEngine(innerEngine().engine, async (id) => (asked.push(id), true)).reply(input, { signal });
    expect(asked).toEqual([testClinic._id]);
  });
});
