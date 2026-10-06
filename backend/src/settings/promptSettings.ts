import type { Collection, Db } from 'mongodb';
import { DEFAULT_PROMPT_TEMPLATE, PROMPT_VARIABLES, validatePromptTemplate } from '../assistant/prompt.js';

/** Prompt editado por una clínica. Si no hay documento, se usa la plantilla por defecto. */
interface PromptDoc {
  _id: string; // clinic_id
  template: string;
  updated_at: Date;
}

export interface PromptStatus {
  template: string;
  default_template: string;
  is_default: boolean;
  updated_at: Date | null;
  variables: typeof PROMPT_VARIABLES;
}

export const PROMPT_MAX_CHARS = 20_000;

export class InvalidPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPromptError';
  }
}

const CACHE_TTL_MS = 30_000;

/**
 * Prompt del asistente por clínica. El worker lo lee en cada turno con un caché
 * corto: un cambio en el panel aplica en menos de 30 s, sin reiniciar nada.
 */
export class PromptSettings {
  private readonly collection: Collection<PromptDoc>;
  private readonly cache = new Map<string, { template: string; at: number }>();

  constructor(
    db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.collection = db.collection<PromptDoc>('clinic_prompts');
  }

  /** Plantilla a usar en el turno: la de la clínica o la por defecto. */
  async templateFor(clinicId: string): Promise<string> {
    const cached = this.cache.get(clinicId);
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return cached.template;
    const doc = await this.collection.findOne({ _id: clinicId });
    const template = doc?.template ?? DEFAULT_PROMPT_TEMPLATE;
    this.cache.set(clinicId, { template, at: this.now() });
    return template;
  }

  async status(clinicId: string): Promise<PromptStatus> {
    const doc = await this.collection.findOne({ _id: clinicId });
    return {
      template: doc?.template ?? DEFAULT_PROMPT_TEMPLATE,
      default_template: DEFAULT_PROMPT_TEMPLATE,
      is_default: !doc,
      updated_at: doc?.updated_at ?? null,
      variables: PROMPT_VARIABLES,
    };
  }

  /** Guarda la plantilla si tiene todas las variables obligatorias y ninguna desconocida. */
  async save(clinicId: string, template: string): Promise<PromptStatus> {
    const problems = describeProblems(template);
    if (problems) throw new InvalidPromptError(problems);
    // Guardar el texto por defecto equivale a restaurarlo: así sigue las mejoras futuras del código.
    if (template === DEFAULT_PROMPT_TEMPLATE) return this.reset(clinicId);
    await this.collection.updateOne({ _id: clinicId }, { $set: { template, updated_at: new Date() } }, { upsert: true });
    this.cache.delete(clinicId);
    return this.status(clinicId);
  }

  async reset(clinicId: string): Promise<PromptStatus> {
    await this.collection.deleteOne({ _id: clinicId });
    this.cache.delete(clinicId);
    return this.status(clinicId);
  }
}

function describeProblems(template: string): string | null {
  if (!template.trim()) return 'El prompt no puede quedar vacío.';
  if (template.length > PROMPT_MAX_CHARS) return `El prompt supera el máximo de ${PROMPT_MAX_CHARS} caracteres.`;
  const { missing, unknown } = validatePromptTemplate(template);
  const parts = [
    missing.length && `faltan las variables ${missing.map((v) => `{{${v}}}`).join(', ')}`,
    unknown.length && `variables desconocidas: ${unknown.map((v) => `{{${v}}}`).join(', ')}`,
  ].filter(Boolean);
  return parts.length ? `El prompt no es válido: ${parts.join('; ')}.` : null;
}
