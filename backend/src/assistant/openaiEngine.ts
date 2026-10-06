import type OpenAI from 'openai';
import type { Response, ResponseCreateParamsNonStreaming, ResponseFunctionToolCall, ResponseInputItem } from 'openai/resources/responses/responses';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { ToolCallTrace } from '../messaging/types.js';
import type { AssistantEngine, AssistantInput, AssistantReply } from './engine.js';
import { applyOutputGuardrails } from './guardrails.js';
import { buildInstructions } from './prompt.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolContext, ToolEffects } from './tools/types.js';

export const ITERATION_LIMIT_TEXT =
  'Disculpa, no logré resolver tu solicitud en este momento. Ya le avisé a un asesor de la clínica, que continuará la conversación por este medio.';

/** Lo único que el motor necesita del SDK. En los tests se reemplaza por uno falso. */
export interface ResponsesClient {
  create(params: ResponseCreateParamsNonStreaming, opts: { signal: AbortSignal }): Promise<Response>;
}

export function openAIResponsesClient(client: OpenAI): ResponsesClient {
  return { create: (params, opts) => client.responses.create(params, opts) };
}

export interface OpenAIEngineConfig {
  model: string;
  reasoningEffort: ReasoningEffort;
  /** Máximo de rondas de herramientas por turno: corta ciclos sin fin y acota el costo. */
  maxToolIterations: number;
  maxOutputTokens: number;
}

/**
 * Motor con tool calling sobre la Responses API. El modelo decide qué tool
 * llamar y con qué argumentos; este código controla el ciclo: ejecuta y valida
 * cada llamada, devuelve el resultado o el error al modelo, limita las
 * iteraciones y registra la traza (tokens, tools, argumentos, resultados).
 */
export class OpenAIEngine implements AssistantEngine {
  readonly name = 'openai';

  constructor(
    /** Cliente de OpenAI con la API key de la clínica (panel o .env); null si no tiene. */
    private readonly clientFor: (clinicId: string) => Promise<ResponsesClient | null>,
    private readonly tools: (input: AssistantInput) => ToolRegistry,
    private readonly config: OpenAIEngineConfig,
    /** Plantilla del prompt de la clínica (editable en el panel); sin ella, la por defecto. */
    private readonly promptFor?: (clinicId: string) => Promise<string>,
  ) {}

  async reply(input: AssistantInput, { signal }: { signal: AbortSignal }): Promise<AssistantReply> {
    const client = await this.clientFor(input.clinic._id);
    if (!client) throw new Error('La clínica no tiene API key de IA configurada.');
    const registry = this.tools(input);
    const ctx: ToolContext = { clinic: input.clinic, conversation: input.conversation, message: input.message, now: input.now };
    const template = this.promptFor ? await this.promptFor(input.clinic._id) : undefined;
    const instructions = buildInstructions(input.clinic, input.now, template);

    // Historial como mensajes de texto. Los resultados de tools de turnos
    // anteriores no se reenvían (se guardan en las trazas): el texto del
    // asistente ya contiene lo que se le mostró al paciente.
    const items: ResponseInputItem[] = input.history.map((m) => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.text,
    }));

    const usage = { input: 0, cached: 0, output: 0 };
    const toolCalls: ToolCallTrace[] = [];
    const effects: ToolEffects = {};

    for (let iteration = 1; iteration <= this.config.maxToolIterations; iteration++) {
      const response = await client.create(
        {
          model: this.config.model,
          instructions,
          input: items,
          tools: registry.definitions(),
          tool_choice: 'auto',
          // Una tool a la vez: agendar depende de lo que devolvió consultar.
          parallel_tool_calls: false,
          reasoning: { effort: this.config.reasoningEffort },
          max_output_tokens: this.config.maxOutputTokens,
          // Sin almacenamiento en OpenAI (datos de salud). El razonamiento cifrado
          // se reenvía en cada ronda para no perder el contexto del modelo.
          store: false,
          include: ['reasoning.encrypted_content'],
        },
        { signal },
      );

      usage.input += response.usage?.input_tokens ?? 0;
      usage.cached += response.usage?.input_tokens_details?.cached_tokens ?? 0;
      usage.output += response.usage?.output_tokens ?? 0;

      const calls = response.output.filter((o): o is ResponseFunctionToolCall => o.type === 'function_call');
      if (calls.length === 0) {
        const text = response.output_text?.trim();
        if (!text) throw new Error(`el modelo no devolvió texto (estado: ${response.status ?? 'desconocido'})`);
        return this.buildReply(text, effects, usage, toolCalls, iteration);
      }

      items.push(...(response.output as ResponseInputItem[]));
      for (const call of calls) {
        const started = Date.now();
        const outcome = await registry.execute(call.name, call.arguments, ctx);
        toolCalls.push({
          name: call.name,
          arguments: safeParse(call.arguments),
          result: outcome.ok ? outcome.data : null,
          error: outcome.ok ? null : `${outcome.error.code}: ${outcome.error.message}`,
          duration_ms: Date.now() - started,
        });
        if (outcome.ok && outcome.effects) mergeEffects(effects, outcome.effects);
        items.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(outcome) });
      }
    }

    // Se agotaron las iteraciones sin respuesta final: se escala en vez de
    // dejar al paciente sin respuesta o seguir gastando tokens.
    mergeEffects(effects, { conversationStatus: 'escalada', escalationReason: 'limite_de_iteraciones_de_herramientas' });
    return this.buildReply(ITERATION_LIMIT_TEXT, effects, usage, toolCalls, this.config.maxToolIterations);
  }

  private buildReply(
    text: string,
    effects: ToolEffects,
    usage: { input: number; cached: number; output: number },
    toolCalls: ToolCallTrace[],
    iterations: number,
  ): AssistantReply {
    const guarded = applyOutputGuardrails(text);
    return {
      text: guarded.text,
      conversationStatus: effects.conversationStatus ?? 'resuelta_por_ia',
      escalationReason: effects.escalationReason,
      trace: {
        model: this.config.model,
        inputTokens: usage.input,
        cachedInputTokens: usage.cached,
        outputTokens: usage.output,
        toolCalls,
        iterations,
        guardrail: guarded.blockedBy,
      },
    };
  }
}

/** escalada pesa más que cita_agendada: si ocurrieron ambas, queda escalada. */
function mergeEffects(target: ToolEffects, next: ToolEffects) {
  if (next.conversationStatus === 'escalada') {
    target.conversationStatus = 'escalada';
    target.escalationReason = next.escalationReason;
  } else if (next.conversationStatus === 'cita_agendada' && target.conversationStatus !== 'escalada') {
    target.conversationStatus = 'cita_agendada';
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}
