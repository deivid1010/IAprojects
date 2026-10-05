import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import type { KnowledgeDocument } from '../catalog/schemas.js';
import { knowledgeDocumentsCollection } from '../db/collections.js';
import { chunkMarkdown } from './chunker.js';
import type { ChunksRepository } from './chunksRepository.js';
import type { Embedder } from './embedder.js';

export interface IndexResult {
  documents: number;
  chunks: number;
  /** Documentos a los que se les generaron embeddings (cambiaron o eran nuevos). */
  reindexed: number;
  /** Documentos sin cambios: no se pagó embedding. */
  unchanged: number;
  removed: number;
}

export interface IndexDeps {
  db: Db;
  chunks: ChunksRepository;
  embedder: Embedder;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Huella de lo que debería estar indexado para un documento: modelo + hash de cada fragmento. */
export function expectedFingerprint(doc: Pick<KnowledgeDocument, 'title' | 'content'>, model: string): string {
  return `${model}:${chunkMarkdown(doc).map((c) => sha256(c.content)).join(',')}`;
}

/**
 * Indexa un documento: lo parte en fragmentos, genera embeddings y los guarda.
 * Si sus fragmentos no cambiaron (mismo contenido y modelo), no hace nada.
 */
export async function indexDocument(
  deps: Omit<IndexDeps, 'db'>,
  doc: Pick<KnowledgeDocument, 'clinic_id' | 'slug' | 'title' | 'content'>,
): Promise<{ chunks: number; reindexed: boolean }> {
  const chunks = chunkMarkdown(doc).map((c) => ({ ...c, contentHash: sha256(c.content) }));
  const fingerprint = `${deps.embedder.model}:${chunks.map((c) => c.contentHash).join(',')}`;
  if ((await deps.chunks.documentFingerprint(doc.clinic_id, doc.slug)) === fingerprint) return { chunks: chunks.length, reindexed: false };

  const embeddings = await deps.embedder.embed(chunks.map((c) => c.content));
  await deps.chunks.replaceDocument(
    doc.clinic_id,
    { slug: doc.slug, title: doc.title },
    deps.embedder.model,
    chunks.map((c, i) => ({ ...c, embedding: embeddings[i]! })),
  );
  return { chunks: chunks.length, reindexed: true };
}

/**
 * Sincroniza el índice vectorial (Postgres) con los documentos de una clínica
 * (Mongo). Solo genera embeddings de los documentos que cambiaron y borra del
 * índice los que ya no existen.
 */
export async function indexClinicKnowledge(deps: IndexDeps, clinicId: string): Promise<IndexResult> {
  const docs = await knowledgeDocumentsCollection(deps.db).find({ clinic_id: clinicId }).sort({ slug: 1 }).toArray();
  const result: IndexResult = { documents: docs.length, chunks: 0, reindexed: 0, unchanged: 0, removed: 0 };

  for (const doc of docs) {
    const r = await indexDocument(deps, doc);
    result.chunks += r.chunks;
    if (r.reindexed) result.reindexed++;
    else result.unchanged++;
  }

  result.removed = await deps.chunks.deleteDocumentsNotIn(
    clinicId,
    docs.map((d) => d.slug),
  );
  return result;
}
