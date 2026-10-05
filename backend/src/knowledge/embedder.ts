import type OpenAI from 'openai';

/** Genera embeddings. El RAG solo conoce esta interfaz: los tests usan uno falso. */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<number[][]>;
}

/** Embedder de una clínica (con su API key), o null si no tiene key configurada. */
export type EmbedderProvider = (clinicId: string) => Promise<Embedder | null>;

/** Dimensión de la columna document_chunks.embedding. */
export const EMBEDDING_DIMENSIONS = 1536;

export class OpenAIEmbedder implements Embedder {
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(
    private readonly client: OpenAI,
    readonly model: string,
  ) {}

  async embed(texts: string[], opts: { signal?: AbortSignal } = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.client.embeddings.create(
      { model: this.model, input: texts, dimensions: this.dimensions, encoding_format: 'float' },
      { signal: opts.signal },
    );
    const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    for (const v of vectors) {
      if (v.length !== this.dimensions) throw new Error(`el modelo ${this.model} devolvió ${v.length} dimensiones; se esperaban ${this.dimensions}`);
    }
    return vectors;
  }
}
