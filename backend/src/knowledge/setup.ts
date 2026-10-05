import type { Env } from '../config/env.js';
import type { PgPool } from '../db/postgres.js';
import type { AiCredentials } from '../settings/aiCredentials.js';
import { openAIClientFor } from '../settings/setup.js';
import { ChunksRepository } from './chunksRepository.js';
import { OpenAIEmbedder, type EmbedderProvider } from './embedder.js';
import { PgVectorRetriever } from './retriever.js';

/**
 * Arma el RAG: repositorio de fragmentos, embedder y retriever. El embedder se
 * resuelve por clínica en cada uso, con la API key configurada para ella (panel
 * o .env); sin key, no hay embedder.
 */
export function createKnowledge(env: Env, pg: PgPool, credentials: AiCredentials) {
  const chunks = new ChunksRepository(pg);
  const embedderFor: EmbedderProvider = async (clinicId) => {
    const key = await credentials.resolveKey(clinicId);
    return key ? new OpenAIEmbedder(openAIClientFor(key, { maxRetries: 2 }), env.OPENAI_EMBEDDING_MODEL) : null;
  };
  const retriever = new PgVectorRetriever(embedderFor, chunks, { topK: env.RAG_TOP_K, minSimilarity: env.RAG_MIN_SIMILARITY });
  return { chunks, embedderFor, retriever };
}
