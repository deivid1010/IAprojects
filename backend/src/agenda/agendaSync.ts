import type { Db } from 'mongodb';
import { clinicSchema, resourceSchema, validateResourceAgainstClinic } from '../catalog/schemas.js';
import { clinicsCollection, knowledgeDocumentsCollection, resourcesCollection } from '../db/collections.js';
import type { AgendaExtractor } from './extraction/agendaExtractor.js';
import { buildAgenda } from './extraction/buildAgenda.js';

export type AgendaStatus = 'generando' | 'lista' | 'sin_agenda' | 'sin_documentos' | 'error';

/** Estado de la última generación, guardado en el documento de la clínica. */
export interface AgendaMeta {
  status: AgendaStatus;
  source: 'documentos';
  started_at: Date;
  finished_at: Date | null;
  documents: string[];
  warnings: string[];
  discarded: string[];
  notes: string[];
  error: string | null;
}

interface Logger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Agenda dinámica: se genera desde los documentos de la base de conocimiento
 * cada vez que cambian (subir, reemplazar, borrar, reindexar) o a pedido.
 * El LLM extrae; buildAgenda valida contra el texto; aquí se reemplazan las
 * sedes, servicios y profesionales de la clínica.
 */
export class AgendaSync {
  private readonly running = new Set<string>();
  private readonly pending = new Set<string>();

  constructor(
    private readonly db: Db,
    /** Extractor con la API key de la clínica, o null si no tiene key. */
    private readonly extractorFor: (clinicId: string) => Promise<AgendaExtractor | null>,
    private readonly log: Logger,
  ) {}

  /** Lanza la regeneración en segundo plano. Si ya hay una en curso, se repite al terminar. */
  schedule(clinicId: string): void {
    if (this.running.has(clinicId)) {
      this.pending.add(clinicId);
      return;
    }
    void this.run(clinicId).catch((err) => this.log.error({ clinicId, error: (err as Error).message }, 'falló la generación de la agenda'));
  }

  async run(clinicId: string): Promise<AgendaMeta> {
    this.running.add(clinicId);
    try {
      let meta: AgendaMeta;
      do {
        this.pending.delete(clinicId);
        meta = await this.generate(clinicId);
      } while (this.pending.has(clinicId));
      return meta;
    } finally {
      this.running.delete(clinicId);
    }
  }

  async status(clinicId: string): Promise<AgendaMeta | null> {
    const doc = await clinicsCollection(this.db).findOne({ _id: clinicId }, { projection: { agenda: 1 } });
    return ((doc as { agenda?: AgendaMeta } | null)?.agenda ?? null) as AgendaMeta | null;
  }

  private async generate(clinicId: string): Promise<AgendaMeta> {
    const clinics = clinicsCollection(this.db);
    const clinic = await clinics.findOne({ _id: clinicId });
    if (!clinic) throw new Error(`no existe la clínica ${clinicId}`);

    const docs = await knowledgeDocumentsCollection(this.db).find({ clinic_id: clinicId }).sort({ slug: 1 }).toArray();
    const meta: AgendaMeta = {
      status: 'generando',
      source: 'documentos',
      started_at: new Date(),
      finished_at: null,
      documents: docs.map((d) => d.title),
      warnings: [],
      discarded: [],
      notes: [],
      error: null,
    };
    await this.saveMeta(clinicId, meta);

    // Sin documentos no hay agenda: el asistente queda sin agendamiento.
    if (docs.length === 0) return this.replace(clinicId, { ...meta, status: 'sin_documentos' }, [], [], []);

    const extractor = await this.extractorFor(clinicId);
    if (!extractor) return this.finish(clinicId, { ...meta, status: 'error', error: 'La clínica no tiene API key de IA configurada.' });

    const text = docs.map((d) => `### ${d.title}\n${d.content}`).join('\n\n');
    try {
      const raw = await extractor(text, { signal: AbortSignal.timeout(120_000) });
      const built = buildAgenda(raw, text);

      // Validación final con los esquemas del catálogo antes de escribir.
      const candidate = clinicSchema.parse({ ...clinic, locations: built.locations, services: built.services });
      const resources = built.resources.map((r) => resourceSchema.parse({ ...r, clinic_id: clinicId }));
      for (const r of resources) {
        const errors = validateResourceAgainstClinic(r, candidate);
        if (errors.length) throw new Error(`agenda inconsistente para ${r.name}: ${errors.join('; ')}`);
      }

      const status: AgendaStatus = resources.length ? 'lista' : 'sin_agenda';
      this.log.info({ clinicId, services: candidate.services.length, resources: resources.length }, 'agenda generada desde la base de conocimiento');
      return this.replace(
        clinicId,
        { ...meta, status, warnings: built.warnings, discarded: built.discarded, notes: raw.notes },
        candidate.locations,
        candidate.services,
        resources,
      );
    } catch (err) {
      // La agenda anterior se conserva: un error no deja a la clínica sin agenda.
      return this.finish(clinicId, { ...meta, status: 'error', error: (err as Error).message });
    }
  }

  private async replace(clinicId: string, meta: AgendaMeta, locations: unknown[], services: unknown[], resources: { _id: string }[]): Promise<AgendaMeta> {
    const done = { ...meta, finished_at: new Date() };
    await clinicsCollection(this.db).updateOne({ _id: clinicId }, { $set: { locations, services, agenda: done } as never });
    await resourcesCollection(this.db).deleteMany({ clinic_id: clinicId });
    if (resources.length) await resourcesCollection(this.db).insertMany(resources as never[]);
    return done;
  }

  private async finish(clinicId: string, meta: AgendaMeta): Promise<AgendaMeta> {
    const done = { ...meta, finished_at: new Date() };
    await this.saveMeta(clinicId, done);
    return done;
  }

  private async saveMeta(clinicId: string, meta: AgendaMeta) {
    await clinicsCollection(this.db).updateOne({ _id: clinicId }, { $set: { agenda: meta } as never });
  }
}
