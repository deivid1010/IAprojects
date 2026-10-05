import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';
import { ITERATION_LIMIT_TEXT, OpenAIEngine, type ResponsesClient } from '../../src/assistant/openaiEngine.js';
import { buildToolRegistry } from '../../src/assistant/tools/index.js';
import type { AssistantInput } from '../../src/assistant/engine.js';
import type { ConversationDoc, MessageDoc } from '../../src/messaging/types.js';
import { fakeAgenda, PDF_MESSAGE_AT, testClinic } from '../agenda/fakes.js';
import { fakeKnowledge } from '../knowledge/fakes.js';

// El motor se prueba con un cliente de OpenAI falso que devuelve respuestas
// guionadas: sin red, sin API key y sin costo.

type Step = { calls?: { name: string; args: unknown }[]; text?: string };

class ScriptedClient implements ResponsesClient {
  requests: ResponseCreateParamsNonStreaming[] = [];
  constructor(private steps: Step[]) {}

  async create(params: ResponseCreateParamsNonStreaming): Promise<Response> {
    this.requests.push(structuredClone(params));
    const step = this.steps.shift() ?? { text: 'fin' };
    const output = step.calls
      ? step.calls.map((c, i) => ({ type: 'function_call', call_id: `call_${this.requests.length}_${i}`, name: c.name, arguments: JSON.stringify(c.args) }))
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: step.text }] }];
    return {
      status: 'completed',
      output,
      output_text: step.text ?? '',
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 600 }, output_tokens: 50 },
    } as unknown as Response;
  }
}

const conversation = { _id: 'k:+573001112233', clinic_id: testClinic._id, phone: '+573001112233', status: 'en_curso' } as ConversationDoc;
const message = {
  _id: 'wamid.001',
  direction: 'inbound',
  text: 'Hola, ¿tienen cita con dermatología mañana en la tarde?',
  timestamp: PDF_MESSAGE_AT,
} as MessageDoc;
const input: AssistantInput = { clinic: testClinic, conversation, history: [message], message, now: PDF_MESSAGE_AT };

function engineWith(steps: Step[], maxToolIterations = 6) {
  const client = new ScriptedClient(steps);
  const { agenda, appointments } = fakeAgenda();
  const engine = new OpenAIEngine(async () => client, (i) => buildToolRegistry(i.clinic, { agenda, knowledge: fakeKnowledge() }), {
    model: 'gpt-test',
    reasoningEffort: 'low',
    maxToolIterations,
    maxOutputTokens: 500,
  });
  return { engine, client, appointments };
}

const run = (engine: OpenAIEngine) => engine.reply(input, { signal: new AbortController().signal });

const consultar = { name: 'consultar_disponibilidad', args: { especialidad: 'dermatologia', sede: null, fecha: 'manana', franja: 'tarde' } };
const agendar = {
  name: 'agendar_cita',
  args: {
    especialidad: 'dermatologia',
    sede: 'sede-norte',
    profesional: 'Dr. Felipe Martínez',
    fecha: 'manana',
    hora: '14:00',
    nombre_paciente: 'Ana Pérez',
    datos_adicionales: { documento: '123456', eps: null },
  },
};

describe('OpenAIEngine: ciclo de tool calling', () => {
  it('envía las tools, ejecuta la que pide el modelo y le devuelve el resultado', async () => {
    const { engine, client } = engineWith([{ calls: [consultar] }, { text: 'Tengo horarios desde las 2:00 p. m. con el Dr. Felipe Martínez.' }]);
    const reply = await run(engine);

    expect(reply.text).toMatch(/Dr. Felipe/);
    expect(reply.conversationStatus).toBe('resuelta_por_ia');

    const first = client.requests[0]!;
    expect((first.tools as { name: string }[]).map((t) => t.name)).toEqual(['buscar_conocimiento', 'consultar_disponibilidad', 'agendar_cita', 'escalar_a_humano']);
    expect(first).toMatchObject({ model: 'gpt-test', store: false, parallel_tool_calls: false, tool_choice: 'auto' });
    expect(first.instructions).toMatch(/lunes 5 de octubre de 2026, 10:40/);

    // La segunda ronda lleva el function_call y su function_call_output con el mismo call_id.
    const second = client.requests[1]!.input as { type?: string; call_id?: string; output?: string }[];
    const call = second.find((i) => i.type === 'function_call')!;
    const output = second.find((i) => i.type === 'function_call_output')!;
    expect(output.call_id).toBe(call.call_id);
    expect(JSON.parse(output.output!)).toMatchObject({ ok: true, data: { fecha: '2026-10-06', total_horarios: 8 } });
  });

  it('registra la traza: tokens (incluido caché), iteraciones y cada tool con argumentos y resultado', async () => {
    const { engine } = engineWith([{ calls: [consultar] }, { text: 'listo' }]);
    const reply = await run(engine);
    expect(reply.trace).toMatchObject({ model: 'gpt-test', inputTokens: 2000, cachedInputTokens: 1200, outputTokens: 100, iterations: 2 });
    expect(reply.trace.toolCalls).toHaveLength(1);
    expect(reply.trace.toolCalls[0]).toMatchObject({ name: 'consultar_disponibilidad', arguments: consultar.args, error: null });
  });

  it('si agendar_cita funciona, el turno termina como cita_agendada', async () => {
    const { engine, appointments } = engineWith([{ calls: [consultar] }, { calls: [agendar] }, { text: 'Tu cita quedó agendada.' }]);
    const reply = await run(engine);
    expect(reply.conversationStatus).toBe('cita_agendada');
    expect(appointments.rows).toHaveLength(1);
  });

  it('un argumento inválido vuelve al modelo como error y el modelo corrige', async () => {
    const wrong = { ...agendar, args: { ...agendar.args, hora: '2pm' } };
    const { engine, client, appointments } = engineWith([{ calls: [wrong] }, { calls: [agendar] }, { text: 'Agendada.' }]);
    const reply = await run(engine);

    const errorOutput = (client.requests[1]!.input as { type?: string; output?: string }[]).find((i) => i.type === 'function_call_output')!;
    expect(JSON.parse(errorOutput.output!)).toMatchObject({ ok: false, error: { code: 'argumentos_invalidos' } });
    expect(reply.trace.toolCalls.map((t) => t.error?.split(':')[0] ?? null)).toEqual(['argumentos_invalidos', null]);
    expect(appointments.rows).toHaveLength(1);
  });

  it('escalar_a_humano deja la conversación escalada con el motivo', async () => {
    const { engine } = engineWith([{ calls: [{ name: 'escalar_a_humano', args: { motivo: 'pide un asesor' } }] }, { text: 'Te comunico con un asesor.' }]);
    const reply = await run(engine);
    expect(reply).toMatchObject({ conversationStatus: 'escalada', escalationReason: 'pide un asesor' });
  });

  it('límite de iteraciones: corta el ciclo, no se queda sin responder y escala', async () => {
    const loop = Array.from({ length: 10 }, () => ({ calls: [consultar] }));
    const { engine, client } = engineWith(loop, 3);
    const reply = await run(engine);
    expect(client.requests).toHaveLength(3);
    expect(reply.text).toBe(ITERATION_LIMIT_TEXT);
    expect(reply).toMatchObject({ conversationStatus: 'escalada', escalationReason: 'limite_de_iteraciones_de_herramientas' });
  });

  it('si el modelo no devuelve texto, el turno falla (y el worker lo reintenta)', async () => {
    const { engine } = engineWith([{ text: '   ' }]);
    await expect(run(engine)).rejects.toThrow(/no devolvió texto/);
  });

  it('envía el historial como mensajes de usuario y asistente', async () => {
    const { engine, client } = engineWith([{ text: 'ok' }]);
    const history = [
      { ...message, _id: 'a', direction: 'inbound', text: 'hola' },
      { ...message, _id: 'b', direction: 'outbound', text: '¡Hola! ¿En qué te ayudo?' },
      message,
    ] as MessageDoc[];
    await engine.reply({ ...input, history }, { signal: new AbortController().signal });
    expect(client.requests[0]!.input).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: '¡Hola! ¿En qué te ayudo?' },
      { role: 'user', content: message.text },
    ]);
  });
});

describe('OpenAIEngine: guardrails de salida', () => {
  it('si el modelo responde con código, se reemplaza y queda registrado en la traza', async () => {
    const { engine } = engineWith([{ text: '```python\nprint("Hola mundo")\n```' }]);
    const reply = await run(engine);
    expect(reply.text).not.toContain('print');
    expect(reply.trace.guardrail).toBe('bloque_de_codigo');
  });

  it('el prompt define el alcance: solo la clínica', async () => {
    const { engine, client } = engineWith([{ text: 'ok' }]);
    await run(engine);
    expect(client.requests[0]!.instructions).toMatch(/ALCANCE/);
    expect(client.requests[0]!.instructions).toMatch(/escribir código/);
  });
});

describe('prompt y tools: la base de conocimiento es la única fuente informativa', () => {
  it('el prompt no incluye datos de la clínica (nombre, sedes, direcciones, servicios)', async () => {
    const { engine, client } = engineWith([{ text: 'ok' }]);
    await run(engine);
    const instructions = client.requests[0]!.instructions as string;
    for (const dato of ['Clínica Vida Sana', 'Sede Norte', 'Avenida 6N', 'Dermatología', 'Pediatría']) expect(instructions).not.toContain(dato);
    expect(instructions).toMatch(/FUENTE ÚNICA DE INFORMACIÓN/);
  });

  it('las descripciones de las tools no listan servicios ni sedes de la clínica', async () => {
    const { engine, client } = engineWith([{ text: 'ok' }]);
    await run(engine);
    const tools = JSON.stringify(client.requests[0]!.tools);
    for (const dato of ['Sede Norte', 'sede-norte', 'Dermatología (', 'medicina-general']) expect(tools).not.toContain(dato);
  });
});

describe('prompt sin agenda', () => {
  it('indica que no hay agenda y que no debe ofrecer citas', async () => {
    const client = new ScriptedClient([{ text: 'ok' }]);
    const sinAgenda = { ...testClinic, services: [], locations: [] };
    const engine = new OpenAIEngine(async () => client, (i) => buildToolRegistry(i.clinic, { agenda: fakeAgenda().agenda, knowledge: fakeKnowledge() }), {
      model: 'gpt-test',
      reasoningEffort: 'low',
      maxToolIterations: 3,
      maxOutputTokens: 500,
    });
    await engine.reply({ ...input, clinic: sinAgenda }, { signal: new AbortController().signal });
    expect(client.requests[0]!.instructions).toMatch(/no tiene agenda disponible/);
    expect((client.requests[0]!.tools as { name: string }[]).map((t) => t.name)).toEqual(['buscar_conocimiento', 'escalar_a_humano']);
  });
});
