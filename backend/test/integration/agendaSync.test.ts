import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgendaSync } from '../../src/agenda/agendaSync.js';
import type { AgendaExtractor } from '../../src/agenda/extraction/agendaExtractor.js';
import type { ExtractedAgenda } from '../../src/agenda/extraction/buildAgenda.js';
import { CatalogRepository } from '../../src/catalog/catalogRepository.js';
import { loadEnv } from '../../src/config/env.js';
import { clinicsCollection, knowledgeDocumentsCollection, resourcesCollection } from '../../src/db/collections.js';
import { connectMongo, type Mongo } from '../../src/db/mongo.js';
import { clinic as seedClinic, resources as seedResources } from '../../src/seed/data.js';

// Agenda dinámica contra MongoDB real, con un extractor falso (sin LLM).
let mongo: Mongo;
const clinicId = `test-ag-${randomUUID().slice(0, 8)}`;
const silent = { info() {}, error() {} };

const DOC = 'Sedes: Sede Centro (lunes a viernes 8:00 a. m. a 5:00 p. m.). Profesionales: Dra. Ana Ruiz, Psicología, Sede Centro lunes y miércoles. Servicios: Consulta de psicología 50 min.';
const extracted: ExtractedAgenda = {
  locations: [{ name: 'Sede Centro', address: null, hours: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' }] }],
  services: [{ name: 'Consulta de psicología', duration_min: 50 }],
  professionals: [{ name: 'Dra. Ana Ruiz', services: ['Consulta de psicología'], schedules: [{ location: 'Sede Centro', days: [1, 3], start: null, end: null }] }],
  notes: [],
};

beforeAll(async () => {
  const env = loadEnv();
  mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
  // Arranca con la agenda de prueba del seed: debe quedar reemplazada por la del documento.
  await clinicsCollection(mongo.db).insertOne({ ...seedClinic, _id: clinicId, whatsapp_number: `+5795${Date.now() % 1e8}`, whatsapp_business_account_id: `5${Date.now()}` });
  await resourcesCollection(mongo.db).insertMany(seedResources.map((r) => ({ ...r, _id: `${r._id}-${clinicId}`, clinic_id: clinicId })));
});

afterAll(async () => {
  await clinicsCollection(mongo.db).deleteOne({ _id: clinicId });
  await resourcesCollection(mongo.db).deleteMany({ clinic_id: clinicId });
  await knowledgeDocumentsCollection(mongo.db).deleteMany({ clinic_id: clinicId });
  await mongo.client.close();
});

const sync = (extractor: AgendaExtractor | null) => new AgendaSync(mongo.db, async () => extractor, silent);

describe('AgendaSync', () => {
  it('reemplaza la agenda por la que describe el documento', async () => {
    await knowledgeDocumentsCollection(mongo.db).insertOne({ clinic_id: clinicId, slug: 'datos', title: 'Datos', content: DOC });
    const meta = await sync(async () => extracted).run(clinicId);
    expect(meta).toMatchObject({ status: 'lista', documents: ['Datos'], error: null });

    const catalog = new CatalogRepository(mongo.db);
    const c = await catalog.findClinicById(clinicId);
    expect(c?.services.map((s) => s.name)).toEqual(['Consulta de psicología']);
    expect(c?.locations.map((l) => l.name)).toEqual(['Sede Centro']);
    const resources = await catalog.findResourcesByClinic(clinicId);
    expect(resources.map((r) => r.name)).toEqual(['Dra. Ana Ruiz']); // ya no están los del seed
    expect(resources[0]!.schedules).toEqual([
      { location_id: 'sede-centro', weekday: 1, start: '08:00', end: '17:00' },
      { location_id: 'sede-centro', weekday: 3, start: '08:00', end: '17:00' },
    ]);
    expect(meta.warnings.length).toBeGreaterThan(0); // horas tomadas de la sede
  });

  it('si el extractor falla, conserva la agenda anterior y registra el error', async () => {
    const meta = await sync(async () => {
      throw new Error('OpenAI no responde');
    }).run(clinicId);
    expect(meta).toMatchObject({ status: 'error', error: 'OpenAI no responde' });
    expect((await new CatalogRepository(mongo.db).findResourcesByClinic(clinicId)).map((r) => r.name)).toEqual(['Dra. Ana Ruiz']);
  });

  it('sin API key no toca la agenda', async () => {
    expect(await sync(null).run(clinicId)).toMatchObject({ status: 'error', error: 'La clínica no tiene API key de IA configurada.' });
  });

  it('un documento sin agenda deja la clínica sin agendamiento', async () => {
    const meta = await sync(async () => ({ locations: [], services: [], professionals: [], notes: ['es un guion de llamada'] })).run(clinicId);
    expect(meta).toMatchObject({ status: 'sin_agenda', notes: ['es un guion de llamada'] });
    expect((await new CatalogRepository(mongo.db).findClinicById(clinicId))?.services).toEqual([]);
  });

  it('sin documentos, la agenda queda vacía', async () => {
    await knowledgeDocumentsCollection(mongo.db).deleteMany({ clinic_id: clinicId });
    expect((await sync(async () => extracted).run(clinicId)).status).toBe('sin_documentos');
    expect(await new CatalogRepository(mongo.db).findResourcesByClinic(clinicId)).toEqual([]);
  });
});
