import type { ZodError } from 'zod';
import { fail, type Tool, type ToolContext, type ToolOutcome } from './types.js';

/** Formato de tool de la Responses API de OpenAI. */
export interface FunctionToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}

/**
 * Conjunto de tools disponibles para el modelo en un turno. Expone sus
 * definiciones (lo que ve el LLM) y ejecuta las llamadas que el LLM propone.
 */
export class ToolRegistry {
  private readonly byName: Map<string, Tool>;

  constructor(tools: Tool[]) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  definitions(): FunctionToolDefinition[] {
    return [...this.byName.values()].map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: true,
    }));
  }

  /**
   * Ejecuta una llamada del modelo. Nombres desconocidos y JSON inválido vuelven
   * al modelo como error. Las fallas de infraestructura (p. ej. base caída) se
   * propagan: el turno falla y el worker lo reintenta.
   */
  async execute(name: string, argumentsJson: string, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.byName.get(name);
    if (!tool) {
      return fail('herramienta_desconocida', `No existe la herramienta "${name}".`, { disponibles: [...this.byName.keys()] });
    }
    let args: unknown;
    try {
      args = JSON.parse(argumentsJson);
    } catch {
      return fail('json_invalido', 'Los argumentos no son un JSON válido.');
    }
    return tool.execute(args, ctx);
  }
}

/** Convierte un error de validación en un resultado que el modelo pueda corregir. */
export function invalidArgs(error: ZodError): ToolOutcome {
  return fail('argumentos_invalidos', 'Revisa los argumentos de la herramienta.', {
    detalles: error.issues.map((i) => ({ campo: i.path.join('.'), problema: i.message })),
  });
}
