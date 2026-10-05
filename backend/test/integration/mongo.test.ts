import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogRepository } from '../../src/catalog/catalogRepository.js';
import { loadEnv } from '../../src/config/env.js';
import { COLLECTIONS, clinicsCollection, ensureMongoIndexes, resourcesCollection } from '../../src/db/collections.js';
import { connectMongo, type Mongo } from '../../src/db/mongo.js';
import { clinic, resources } from '../../src/seed/data.js';

let mongo: Mongo;
const suffix = randomUUID().slice(0, 8);
const clinicId = `test-${suffix}`;

beforeAll(async () => {
  const env = loadEnv();
  mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
  await ensureMongoIndexes(mongo.db);
  await clinicsCollection(mongo.db).insertOne({
    ...clinic,
    _id: clinicId,
    whatsapp_number: `+5799${Date.now() % 1e8}`,
    whatsapp_business_account_id: `8${Date.now()}`, // el WABA es único por clínica
  });
  await resourcesCollection(mongo.db).insertMany(resources.map((r) => ({ ...r, _id: `${r._id}-${suffix}`, clinic_id: clinicId })));
});

afterAll(async () => {
  await clinicsCollection(mongo.db).deleteOne({ _id: clinicId });
  await resourcesCollection(mongo.db).deleteMany({ clinic_id: clinicId });
  await mongo.db.collection(COLLECTIONS.conversations).deleteMany({ clinic_id: clinicId });
  await mongo.db.collection(COLLECTIONS.messages).deleteMany({ clinic_id: clinicId });
  await mongo.client.close();
});

describe('MongoDB: catálogo e índices', () => {
  it('ensureMongoIndexes es idempotente', async () => {
    await expect(ensureMongoIndexes(mongo.db)).resolves.toBeUndefined();
  });

  it('lee y valida la clínica', async () => {
    const found = await new CatalogRepository(mongo.db).findClinicById(clinicId);
    expect(found?.services.map((s) => s.id)).toEqual(['medicina-general', 'dermatologia', 'pediatria']);
  });

  it('encuentra los recursos de un servicio, filtrando por sede', async () => {
    const repo = new CatalogRepository(mongo.db);
    const all = await repo.findResourcesForService(clinicId, 'dermatologia');
    const sur = await repo.findResourcesForService(clinicId, 'dermatologia', 'sede-sur');
    expect(all.map((r) => r.name)).toEqual(['Dr. Felipe Martínez', 'Dra. Camila Restrepo']);
    expect(sur.map((r) => r.name)).toEqual(['Dra. Camila Restrepo']);
  });

  it('una sola conversación por clínica y teléfono', async () => {
    const conversations = mongo.db.collection(COLLECTIONS.conversations);
    await conversations.insertOne({ clinic_id: clinicId, phone: '+573001112233' });
    await expect(conversations.insertOne({ clinic_id: clinicId, phone: '+573001112233' })).rejects.toMatchObject({ code: 11000 });
  });

  it('un message_id repetido no se inserta dos veces (idempotencia)', async () => {
    const messages = mongo.db.collection<{ _id: string; clinic_id: string }>(COLLECTIONS.messages);
    const id = `wamid.test-${suffix}`;
    await messages.insertOne({ _id: id, clinic_id: clinicId });
    await expect(messages.insertOne({ _id: id, clinic_id: clinicId })).rejects.toMatchObject({ code: 11000 });
  });
});
