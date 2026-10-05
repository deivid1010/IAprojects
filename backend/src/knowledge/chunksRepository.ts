import type { PgPool } from '../db/postgres.js';

export interface StoredChunk {
  index: number;
  heading: string | null;
  content: string;
  contentHash: string;
  embedding: number[];
}

export interface ChunkHit {
  documentSlug: string;
  documentTitle: string;
  heading: string | null;
  content: string;
  /** Similitud coseno: 1 = idéntico, 0 = sin relación. */
  similarity: number;
}

/** pgvector recibe el vector como texto: '[0.1,0.2,…]'. */
const toVector = (v: number[]) => `[${v.join(',')}]`;

export class ChunksRepository {
  constructor(private readonly pool: PgPool) {}

  /** Huella de un documento indexado (modelo + hashes de sus fragmentos), o null si no está. */
  async documentFingerprint(clinicId: string, slug: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ fp: string | null }>(
      `SELECT max(embedding_model) || ':' || string_agg(content_hash, ',' ORDER BY chunk_index) AS fp
       FROM document_chunks WHERE clinic_id = $1 AND document_slug = $2`,
      [clinicId, slug],
    );
    return rows[0]?.fp ?? null;
  }

  /** Huellas de todos los documentos indexados de una clínica (slug → huella). */
  async fingerprints(clinicId: string): Promise<Map<string, string>> {
    const { rows } = await this.pool.query<{ slug: string; fp: string }>(
      `SELECT document_slug AS slug, max(embedding_model) || ':' || string_agg(content_hash, ',' ORDER BY chunk_index) AS fp
       FROM document_chunks WHERE clinic_id = $1 GROUP BY document_slug`,
      [clinicId],
    );
    return new Map(rows.map((r) => [r.slug, r.fp]));
  }

  /** Reemplaza todos los fragmentos de un documento en una transacción. */
  async replaceDocument(clinicId: string, doc: { slug: string; title: string }, model: string, chunks: StoredChunk[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM document_chunks WHERE clinic_id = $1 AND document_slug = $2', [clinicId, doc.slug]);
      for (const c of chunks) {
        await client.query(
          `INSERT INTO document_chunks
             (clinic_id, document_slug, document_title, chunk_index, heading, content, content_hash, embedding_model, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
          [clinicId, doc.slug, doc.title, c.index, c.heading, c.content, c.contentHash, model, toVector(c.embedding)],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Borra del índice los documentos que ya no existen en la fuente. */
  async deleteDocumentsNotIn(clinicId: string, slugs: string[]): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM document_chunks WHERE clinic_id = $1 AND NOT (document_slug = ANY($2))', [
      clinicId,
      slugs,
    ]);
    return rowCount ?? 0;
  }

  /** Por documento: cantidad de fragmentos, cuándo se indexó y con qué modelo. */
  async documentStats(clinicId: string): Promise<Map<string, { chunks: number; indexedAt: Date; model: string }>> {
    const { rows } = await this.pool.query(
      `SELECT document_slug, count(*)::int AS chunks, min(created_at) AS indexed_at, max(embedding_model) AS model
       FROM document_chunks WHERE clinic_id = $1 GROUP BY document_slug`,
      [clinicId],
    );
    return new Map(rows.map((r) => [r.document_slug as string, { chunks: r.chunks as number, indexedAt: r.indexed_at as Date, model: r.model as string }]));
  }

  async listDocumentChunks(clinicId: string, slug: string): Promise<{ index: number; heading: string | null; content: string }[]> {
    const { rows } = await this.pool.query(
      'SELECT chunk_index, heading, content FROM document_chunks WHERE clinic_id = $1 AND document_slug = $2 ORDER BY chunk_index',
      [clinicId, slug],
    );
    return rows.map((r) => ({ index: r.chunk_index, heading: r.heading, content: r.content }));
  }

  async deleteDocument(clinicId: string, slug: string): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM document_chunks WHERE clinic_id = $1 AND document_slug = $2', [clinicId, slug]);
    return rowCount ?? 0;
  }

  async countForClinic(clinicId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM document_chunks WHERE clinic_id = $1', [clinicId]);
    return rows[0]?.n ?? 0;
  }

  /**
   * Los k fragmentos más parecidos de una clínica. Nunca cruza clínicas.
   *
   * Si Postgres usa el índice HNSW, este busca los vecinos más cercanos de toda
   * la tabla y después filtra por clínica: una clínica con pocos documentos
   * podría quedarse sin resultados. hnsw.iterative_scan (pgvector 0.8) hace que
   * siga buscando hasta completar los k de esa clínica.
   */
  async search(clinicId: string, embedding: number[], k: number): Promise<ChunkHit[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL hnsw.iterative_scan = 'strict_order'");
      const { rows } = await client.query(
        `SELECT document_slug, document_title, heading, content, 1 - (embedding <=> $2::vector) AS similarity
         FROM document_chunks
         WHERE clinic_id = $1
         ORDER BY embedding <=> $2::vector
         LIMIT $3`,
        [clinicId, toVector(embedding), k],
      );
      await client.query('COMMIT');
      return rows.map((r) => ({
        documentSlug: r.document_slug,
        documentTitle: r.document_title,
        heading: r.heading,
        content: r.content,
        similarity: Number(r.similarity),
      }));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
