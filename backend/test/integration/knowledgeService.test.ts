import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { ensureMongoIndexes, knowledgeDocumentsCollection } from '../../src/db/collections.js';
import { runMigrations } from '../../src/db/migrate.js';
import { connectMongo, type Mongo } from '../../src/db/mongo.js';
import { createPgPool, type PgPool } from '../../src/db/postgres.js';
import { ChunksRepository } from '../../src/knowledge/chunksRepository.js';
import { EmbeddingsUnavailableError, InvalidDocumentError, KnowledgeService } from '../../src/knowledge/knowledgeService.js';
import { FakeEmbedder } from '../knowledge/fakes.js';

// Subida, reemplazo, borrado y búsqueda de documentos con Mongo y pgvector reales.
let mongo: Mongo;
let pool: PgPool;
let service: KnowledgeService;
let chunks: ChunksRepository;
const embedder = new FakeEmbedder();
const clinicId = `test-k-${randomUUID().slice(0, 8)}`;

const DOC = `# Tarifas de consulta
## Particular
La consulta de medicina general particular cuesta 80.000 pesos.
## Prepagada
Con prepagada aplica el copago de su plan.`;

beforeAll(async () => {
  const env = loadEnv();
  mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
  pool = createPgPool(env.DATABASE_URL);
  await ensureMongoIndexes(mongo.db);
  await runMigrations(pool, () => {});
  chunks = new ChunksRepository(pool);
  service = new KnowledgeService(mongo.db, chunks, async () => embedder, embedder.model, { topK: 3, minSimilarity: 0.2 });
});

afterAll(async () => {
  await pool.query('DELETE FROM document_chunks WHERE clinic_id = $1', [clinicId]);
  await knowledgeDocumentsCollection(mongo.db).deleteMany({ clinic_id: clinicId });
  await Promise.all([pool.end(), mongo.client.close()]);
});

describe('KnowledgeService', () => {
  it('sube un documento: lo guarda, lo parte en fragmentos y lo indexa en el momento', async () => {
    const r = await service.upload(clinicId, { filename: '07-Tarifas.md', content: DOC });
    expect(r).toMatchObject({ created: true, reindexed: true, document: { slug: 'tarifas', title: 'Tarifas de consulta', chunks: 2, indexed: true } });

    const [doc] = await service.list(clinicId);
    expect(doc).toMatchObject({ slug: 'tarifas', source_filename: '07-Tarifas.md', indexed: true, chunks: 2 });
  });

  it('volver a subir el mismo contenido no regenera embeddings y sigue indexado', async () => {
    const before = embedder.calls;
    const r = await service.upload(clinicId, { filename: '07-Tarifas.md', content: DOC });
    expect(r).toMatchObject({ created: false, reindexed: false, document: { indexed: true } });
    expect(embedder.calls).toBe(before);
  });

  it('reemplazar el contenido reindexa el documento', async () => {
    const r = await service.upload(clinicId, { filename: '07-Tarifas.md', content: DOC.replace('80.000', '90.000') });
    expect(r).toMatchObject({ created: false, reindexed: true });
    const detail = await service.get(clinicId, 'tarifas');
    expect(detail?.fragments.map((f) => f.heading)).toEqual(['Particular', 'Prepagada']);
    expect(detail?.fragments[0]!.content).toContain('90.000');
  });

  it('la búsqueda de prueba marca qué fragmentos recibiría el asistente', async () => {
    const r = await service.search(clinicId, 'cuánto cuesta la consulta particular');
    expect(r.results[0]).toMatchObject({ source: 'Tarifas de consulta — Particular', used_by_assistant: true });
    expect(r.min_similarity).toBe(0.2);
  });

  it('rechaza documentos vacíos o sin título', async () => {
    await expect(service.upload(clinicId, { content: '   ' })).rejects.toBeInstanceOf(InvalidDocumentError);
    // Sin "#", sin nombre de archivo y con una primera línea demasiado larga para ser título.
    await expect(service.upload(clinicId, { content: 'palabra '.repeat(30) })).rejects.toBeInstanceOf(InvalidDocumentError);
  });

  it('sin embedder no guarda nada (nunca queda un documento invisible para el RAG)', async () => {
    const noKey = new KnowledgeService(mongo.db, chunks, async () => null, embedder.model, { topK: 3, minSimilarity: 0.2 });
    await expect(noKey.upload(clinicId, { filename: 'otro.md', content: '# Otro\nTexto' })).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    expect(await knowledgeDocumentsCollection(mongo.db).countDocuments({ clinic_id: clinicId, slug: 'otro' })).toBe(0);
  });

  it('borrar elimina el documento y sus fragmentos', async () => {
    expect(await service.remove(clinicId, 'tarifas')).toBe(true);
    expect(await service.list(clinicId)).toEqual([]);
    expect(await chunks.countForClinic(clinicId)).toBe(0);
    expect(await service.remove(clinicId, 'tarifas')).toBe(false);
  });
});

describe('KnowledgeService: títulos de documentos sin encabezado', () => {
  it('un PDF o texto sin "#" toma la primera línea como título', async () => {
    const r = await service.upload(clinicId, { filename: '09-manual.pdf', content: 'Manual de bienvenida\nTexto del manual.', format: 'pdf' });
    expect(r.document).toMatchObject({ slug: 'manual', title: 'Manual de bienvenida', source_format: 'pdf' });
    await service.remove(clinicId, 'manual');
  });
});
