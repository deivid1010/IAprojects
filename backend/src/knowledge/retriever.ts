import type { ChunkHit, ChunksRepository } from './chunksRepository.js';
import type { EmbedderProvider } from './embedder.js';

export interface RetrieverConfig {
  topK: number;
  /** Por debajo de esta similitud, un fragmento se considera no relacionado. */
  minSimilarity: number;
}

export interface KnowledgeRetriever {
  search(clinicId: string, query: string, opts?: { signal?: AbortSignal }): Promise<ChunkHit[]>;
}

/** Búsqueda semántica sobre pgvector, filtrada por clínica y por umbral de similitud. */
export class PgVectorRetriever implements KnowledgeRetriever {
  constructor(
    private readonly embedderFor: EmbedderProvider,
    private readonly chunks: ChunksRepository,
    private readonly config: RetrieverConfig,
  ) {}

  async search(clinicId: string, query: string, opts: { signal?: AbortSignal } = {}): Promise<ChunkHit[]> {
    const embedder = await this.embedderFor(clinicId);
    if (!embedder) throw new Error('La clínica no tiene API key de IA configurada: no se puede buscar en la base de conocimiento.');
    const [vector] = await embedder.embed([query], opts);
    const hits = await this.chunks.search(clinicId, vector!, this.config.topK);
    return hits.filter((h) => h.similarity >= this.config.minSimilarity);
  }
}
