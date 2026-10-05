import type { Db } from 'mongodb';
import { knowledgeDocumentSchema, type KnowledgeDocument } from '../catalog/schemas.js';
import { knowledgeDocumentsCollection } from '../db/collections.js';
import type { ChunksRepository } from './chunksRepository.js';
import type { Embedder, EmbedderProvider } from './embedder.js';
import { expectedFingerprint, indexClinicKnowledge, indexDocument, type IndexResult } from './indexer.js';
import type { SourceFormat } from './extract.js';
import type { RetrieverConfig } from './retriever.js';

export const MAX_DOCUMENT_CHARS = 300_000;

export class EmbeddingsUnavailableError extends Error {
  constructor() {
    super('No hay API key de IA configurada: no se pueden generar embeddings. Configúrala en Configuración → Modelo de IA.');
    this.name = 'EmbeddingsUnavailableError';
  }
}

export class InvalidDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDocumentError';
  }
}

export interface DocumentSummary {
  slug: string;
  title: string;
  source_filename: string | null;
  source_format: SourceFormat | null;
  chars: number;
  updated_at: Date | null;
  chunks: number;
  indexed_at: Date | null;
  embedding_model: string | null;
  /** El índice está al día con el contenido actual del documento. */
  indexed: boolean;
}

export interface UploadInput {
  filename?: string;
  title?: string;
  content: string;
  format?: SourceFormat;
}

/**
 * Administración de la base de conocimiento de una clínica: documentos en
 * MongoDB (fuente de verdad) e índice vectorial en PostgreSQL (derivado).
 */
export class KnowledgeService {
  constructor(
    private readonly db: Db,
    private readonly chunks: ChunksRepository,
    private readonly embedderFor: EmbedderProvider,
    /** Modelo de embeddings configurado (para saber si el índice está al día). */
    private readonly embeddingModel: string,
    private readonly retrieval: RetrieverConfig,
    /** Se llama cuando cambian los documentos de una clínica (p. ej. para regenerar la agenda). */
    private readonly onChange: (clinicId: string) => void = () => {},
  ) {}

  private async requireEmbedder(clinicId: string): Promise<Embedder> {
    const embedder = await this.embedderFor(clinicId);
    if (!embedder) throw new EmbeddingsUnavailableError();
    return embedder;
  }

  async list(clinicId: string): Promise<DocumentSummary[]> {
    const [docs, stats, fingerprints] = await Promise.all([
      knowledgeDocumentsCollection(this.db).find({ clinic_id: clinicId }).sort({ slug: 1 }).toArray(),
      this.chunks.documentStats(clinicId),
      this.chunks.fingerprints(clinicId),
    ]);
    return docs.map((d) => this.summarize(d, stats.get(d.slug), fingerprints.get(d.slug)));
  }

  async get(clinicId: string, slug: string) {
    const doc = await knowledgeDocumentsCollection(this.db).findOne({ clinic_id: clinicId, slug });
    if (!doc) return null;
    const [stats, fingerprints, chunks] = await Promise.all([
      this.chunks.documentStats(clinicId),
      this.chunks.fingerprints(clinicId),
      this.chunks.listDocumentChunks(clinicId, slug),
    ]);
    return { ...this.summarize(doc, stats.get(slug), fingerprints.get(slug)), content: doc.content, fragments: chunks };
  }

  /**
   * Sube o reemplaza un documento (mismo nombre = mismo slug) y lo indexa en el
   * momento. Si no se pueden generar embeddings, no se guarda nada: así nunca
   * queda un documento visible para el coordinador pero invisible para el RAG.
   */
  async upload(clinicId: string, input: UploadInput): Promise<{ document: DocumentSummary; created: boolean; reindexed: boolean }> {
    const embedder = await this.requireEmbedder(clinicId);
    const content = input.content.replace(/\r\n/g, '\n').trim();
    if (!content) throw new InvalidDocumentError('El documento está vacío.');
    if (content.length > MAX_DOCUMENT_CHARS) throw new InvalidDocumentError(`El documento supera ${MAX_DOCUMENT_CHARS.toLocaleString('es-CO')} caracteres.`);

    // Título: la primera línea del documento si es corta (suele ser el título,
    // sea un "# Título" de Markdown, el título de un Word o el de un PDF); si no,
    // el primer encabezado #; si tampoco, el nombre del archivo.
    const firstLine = (content.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
    const heading = firstLine && firstLine.length <= 120 ? firstLine : /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
    const baseName = input.filename?.replace(/\.(md|markdown|txt|pdf|docx)$/i, '');
    const title = input.title?.trim() || heading || baseName;
    if (!title) throw new InvalidDocumentError('Indica un título o sube un archivo con nombre.');
    const slug = toSlug(baseName || title);
    if (!slug) throw new InvalidDocumentError('No se pudo derivar un identificador válido del nombre o el título.');

    const parsed = knowledgeDocumentSchema.safeParse({
      clinic_id: clinicId,
      slug,
      title,
      content,
      source_filename: input.filename,
      source_format: input.format ?? 'markdown',
      updated_at: new Date(),
    });
    if (!parsed.success) throw new InvalidDocumentError(parsed.error.issues.map((i) => i.message).join('; '));

    // Primero los embeddings (lo que puede fallar), después la escritura en Mongo.
    const { reindexed } = await indexDocument({ chunks: this.chunks, embedder }, parsed.data);
    const res = await knowledgeDocumentsCollection(this.db).replaceOne({ clinic_id: clinicId, slug }, parsed.data, { upsert: true });

    const [stats, fingerprints] = await Promise.all([this.chunks.documentStats(clinicId), this.chunks.fingerprints(clinicId)]);
    if (reindexed || res.upsertedCount === 1) this.onChange(clinicId);
    return { document: this.summarize(parsed.data, stats.get(slug), fingerprints.get(slug)), created: res.upsertedCount === 1, reindexed };
  }

  async remove(clinicId: string, slug: string): Promise<boolean> {
    const res = await knowledgeDocumentsCollection(this.db).deleteOne({ clinic_id: clinicId, slug });
    await this.chunks.deleteDocument(clinicId, slug);
    if (res.deletedCount === 1) this.onChange(clinicId);
    return res.deletedCount === 1;
  }

  async reindex(clinicId: string): Promise<IndexResult> {
    const result = await indexClinicKnowledge({ db: this.db, chunks: this.chunks, embedder: await this.requireEmbedder(clinicId) }, clinicId);
    this.onChange(clinicId);
    return result;
  }

  /**
   * Búsqueda de prueba para el coordinador: muestra los fragmentos más cercanos,
   * su similitud y si superan el umbral que usa el asistente.
   */
  async search(clinicId: string, query: string) {
    const [vector] = await (await this.requireEmbedder(clinicId)).embed([query]);
    const hits = await this.chunks.search(clinicId, vector!, this.retrieval.topK);
    return {
      query,
      min_similarity: this.retrieval.minSimilarity,
      top_k: this.retrieval.topK,
      results: hits.map((h) => ({
        source: h.heading ? `${h.documentTitle} — ${h.heading}` : h.documentTitle,
        document_slug: h.documentSlug,
        content: h.content,
        similarity: Math.round(h.similarity * 1000) / 1000,
        // Lo que el asistente recibiría: solo los que superan el umbral.
        used_by_assistant: h.similarity >= this.retrieval.minSimilarity,
      })),
    };
  }

  private summarize(d: KnowledgeDocument, stats?: { chunks: number; indexedAt: Date; model: string }, fingerprint?: string): DocumentSummary {
    const updatedAt = d.updated_at ?? null;
    return {
      slug: d.slug,
      title: d.title,
      source_filename: d.source_filename ?? null,
      source_format: d.source_format ?? null,
      chars: d.content.length,
      updated_at: updatedAt,
      chunks: stats?.chunks ?? 0,
      indexed_at: stats?.indexedAt ?? null,
      embedding_model: stats?.model ?? null,
      // Al día si lo indexado coincide con el contenido actual y con el modelo configurado.
      indexed: Boolean(fingerprint) && fingerprint === expectedFingerprint(d, this.embeddingModel),
    };
  }
}

/** "05-Preparación de exámenes" → "preparacion-de-examenes" */
export function toSlug(text: string): string {
  return text
    .replace(/^\d+[-_.\s]+/, '') // prefijo de orden: "05-"
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}
