import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { ensureMongoIndexes, knowledgeDocumentsCollection } from '../../src/db/collections.js';
import { runMigrations } from '../../src/db/migrate.js';
import { connectMongo, type Mongo } from '../../src/db/mongo.js';
import { createPgPool, type PgPool } from '../../src/db/postgres.js';
import { ChunksRepository } from '../../src/knowledge/chunksRepository.js';
import { indexClinicKnowledge } from '../../src/knowledge/indexer.js';
import { PgVectorRetriever } from '../../src/knowledge/retriever.js';
import { FakeEmbedder } from '../knowledge/fakes.js';

// Indexado incremental y búsqueda sobre pgvector real, con el embedder falso.
let mongo: Mongo;
let pool: PgPool;
let chunks: ChunksRepository;
const embedder = new FakeEmbedder();
const run = randomUUID().slice(0, 8);
const clinicA = `test-a-${run}`;
const clinicB = `test-b-${run}`;

const DOCS = path.resolve('src/seed/docs');
const seedDocs = (clinicId: string) =>
  readdirSync(DOCS).map((file) => {
    const content = readFileSync(path.join(DOCS, file), 'utf8').trim();
    return { clinic_id: clinicId, slug: file.replace(/^\d+-/, '').replace(/\.md$/, ''), title: content.split('\n')[0]!.replace(/^#\s*/, ''), content };
  });

beforeAll(async () => {
  const env = loadEnv();
  mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
  pool = createPgPool(env.DATABASE_URL);
  await ensureMongoIndexes(mongo.db);
  await runMigrations(pool, () => {});
  chunks = new ChunksRepository(pool);

  await knowledgeDocumentsCollection(mongo.db).insertMany(seedDocs(clinicA));
  // La clínica B solo tiene un documento, con un dato que A no tiene.
  await knowledgeDocumentsCollection(mongo.db).insertOne({
    clinic_id: clinicB,
    slug: 'tarifas',
    title: 'Tarifas',
    content: '# Tarifas\nLa consulta de dermatología cuesta 150.000 pesos.',
  });
});

afterAll(async () => {
  await pool.query('DELETE FROM document_chunks WHERE clinic_id = ANY($1)', [[clinicA, clinicB]]);
  await knowledgeDocumentsCollection(mongo.db).deleteMany({ clinic_id: { $in: [clinicA, clinicB] } });
  await Promise.all([pool.end(), mongo.client.close()]);
});

const deps = () => ({ db: mongo.db, chunks, embedder });

describe('indexado incremental', () => {
  it('indexa todos los documentos la primera vez', async () => {
    const r = await indexClinicKnowledge(deps(), clinicA);
    expect(r).toMatchObject({ documents: 9, reindexed: 9, unchanged: 0, removed: 0 });
    expect(await chunks.countForClinic(clinicA)).toBe(r.chunks);
  });

  it('sin cambios, no vuelve a generar embeddings', async () => {
    const before = embedder.calls;
    const r = await indexClinicKnowledge(deps(), clinicA);
    expect(r).toMatchObject({ reindexed: 0, unchanged: 9 });
    expect(embedder.calls).toBe(before);
  });

  it('solo reindexa el documento que cambió y borra los que ya no existen', async () => {
    const docs = knowledgeDocumentsCollection(mongo.db);
    await docs.updateOne({ clinic_id: clinicA, slug: 'politica-cancelacion' }, { $set: { content: '# Política\nSe cancela hasta 48 horas antes.' } });
    await docs.deleteOne({ clinic_id: clinicA, slug: 'eps-y-pagos' });

    const r = await indexClinicKnowledge(deps(), clinicA);
    expect(r).toMatchObject({ documents: 8, reindexed: 1, unchanged: 7, removed: 1 });
  });
});

describe('búsqueda semántica', () => {
  const retriever = (minSimilarity = 0.1) => new PgVectorRetriever(async () => embedder, chunks, { topK: 3, minSimilarity });

  it('encuentra el fragmento relevante con su fuente', async () => {
    const hits = await retriever().search(clinicA, '¿Necesito ayuno para el examen de glucosa?');
    expect(hits[0]).toMatchObject({ documentTitle: 'Preparación para exámenes de laboratorio', heading: 'Ayuno' });
    expect(hits[0]!.similarity).toBeGreaterThan(0);
  });

  it('nunca devuelve documentos de otra clínica', async () => {
    await indexClinicKnowledge(deps(), clinicB);
    const hits = await retriever(0).search(clinicA, 'tarifas cuánto cuesta la consulta de dermatología en pesos');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => !h.content.includes('150.000'))).toBe(true);

    const hitsB = await retriever(0).search(clinicB, 'cuánto cuesta dermatología');
    expect(hitsB.map((h) => h.documentSlug)).toEqual(['tarifas']);
  });

  it('descarta resultados por debajo del umbral de similitud', async () => {
    expect(await retriever(0.99).search(clinicA, 'ayuno glucosa')).toEqual([]);
  });
});
