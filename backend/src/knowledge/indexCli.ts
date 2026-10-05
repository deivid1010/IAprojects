import { loadEnv } from '../config/env.js';
import { clinicsCollection } from '../db/collections.js';
import { runMigrations } from '../db/migrate.js';
import { connectMongo } from '../db/mongo.js';
import { createPgPool } from '../db/postgres.js';
import { indexClinicKnowledge } from './indexer.js';
import { createAiCredentials } from '../settings/setup.js';
import { createKnowledge } from './setup.js';

// Indexa la base de conocimiento de todas las clínicas: `npm run index`.
// Es incremental: solo genera embeddings de los documentos que cambiaron.
const env = loadEnv();
const pg = createPgPool(env.DATABASE_URL);
const mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);

try {
  await runMigrations(pg, () => {});
  const { embedderFor, chunks } = createKnowledge(env, pg, createAiCredentials(env, mongo.db));
  const clinics = await clinicsCollection(mongo.db).find({}, { projection: { _id: 1 } }).toArray();
  for (const { _id } of clinics) {
    const embedder = await embedderFor(_id);
    if (!embedder) {
      console.log(`${_id}: sin API key configurada, se omite`);
      continue;
    }
    const r = await indexClinicKnowledge({ db: mongo.db, chunks, embedder }, _id);
    console.log(
      `${_id}: ${r.documents} documentos, ${r.chunks} fragmentos · reindexados ${r.reindexed}, sin cambios ${r.unchanged}, eliminados ${r.removed}`,
    );
  }
} catch (err) {
  console.error('falló el indexado:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([pg.end(), mongo.client.close()]);
}
