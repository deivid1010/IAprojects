import { createHash } from 'node:crypto';
import type { ChunkHit } from '../../src/knowledge/chunksRepository.js';
import { EMBEDDING_DIMENSIONS, type Embedder } from '../../src/knowledge/embedder.js';
import { normalize } from '../../src/agenda/matching.js';
import type { KnowledgeRetriever } from '../../src/knowledge/retriever.js';

const STOPWORDS = new Set(['de', 'la', 'el', 'los', 'las', 'y', 'a', 'en', 'para', 'que', 'por', 'con', 'se', 'un', 'una', 'es', 'del', 'al', 'lo', 'si', 'no', 'hay', 'tienen', 'me']);

/**
 * Embedder falso y determinista para tests: cada palabra suma 1 en una
 * dimensión elegida por hash (bolsa de palabras). Textos que comparten
 * palabras quedan cerca. No es semántico, pero basta para probar el flujo
 * del RAG sin llamar a la API.
 */
export class FakeEmbedder implements Embedder {
  readonly model = 'fake-bow';
  readonly dimensions = EMBEDDING_DIMENSIONS;
  calls = 0;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map((text) => {
      const v = new Array<number>(this.dimensions).fill(0);
      for (const word of normalize(text).split(' ')) {
        if (word.length < 3 || STOPWORDS.has(word)) continue;
        const stem = word.slice(0, 6); // "ayuno"/"ayunar" → misma dimensión
        v[createHash('md5').update(stem).digest().readUInt32BE(0) % this.dimensions]! += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

/** Retriever en memoria para tests de las tools. */
export function fakeKnowledge(hits: ChunkHit[] = []): KnowledgeRetriever & { queries: { clinicId: string; query: string }[] } {
  const queries: { clinicId: string; query: string }[] = [];
  return {
    queries,
    async search(clinicId, query) {
      queries.push({ clinicId, query });
      return hits;
    },
  };
}
