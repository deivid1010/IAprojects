import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { clinicSchema, knowledgeDocumentSchema, resourceSchema, validateResourceAgainstClinic } from '../catalog/schemas.js';
import { loadEnv } from '../config/env.js';
import { clinicsCollection, ensureMongoIndexes, knowledgeDocumentsCollection, resourcesCollection } from '../db/collections.js';
import { runMigrations } from '../db/migrate.js';
import { connectMongo } from '../db/mongo.js';
import { createPgPool } from '../db/postgres.js';
import { AppointmentsRepository } from '../appointments/appointmentsRepository.js';
import { indexClinicKnowledge } from '../knowledge/indexer.js';
import { createKnowledge } from '../knowledge/setup.js';
import { createAiCredentials } from '../settings/setup.js';
import { createAgendaSync } from '../agenda/setup.js';
import { clinic, resources, SEED_CLINIC_ID } from './data.js';

// Seed idempotente: borra y recrea los datos de la clínica de prueba.
// Solo toca la clínica del seed; no borra conversaciones.
const DOCS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs');

async function main() {
  const env = loadEnv();
  const pg = createPgPool(env.DATABASE_URL);
  const mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);

  try {
    await runMigrations(pg);
    await ensureMongoIndexes(mongo.db);

    // 1. Validar todo antes de escribir: si el seed está mal, no se toca nada.
    const validClinic = clinicSchema.parse(clinic);
    const validResources = resources.map((r) => {
      const parsed = resourceSchema.parse(r);
      const errors = validateResourceAgainstClinic(parsed, validClinic);
      if (errors.length) throw new Error(`recurso ${parsed._id} inválido: ${errors.join('; ')}`);
      return parsed;
    });
    const documents = await loadDocuments();

    // 2. Catálogo y documentos en Mongo.
    await clinicsCollection(mongo.db).deleteOne({ _id: SEED_CLINIC_ID });
    await resourcesCollection(mongo.db).deleteMany({ clinic_id: SEED_CLINIC_ID });
    await knowledgeDocumentsCollection(mongo.db).deleteMany({ clinic_id: SEED_CLINIC_ID });

    await clinicsCollection(mongo.db).insertOne(validClinic);
    await resourcesCollection(mongo.db).insertMany(validResources);
    await knowledgeDocumentsCollection(mongo.db).insertMany(documents);

    // 3. Algunas citas ya tomadas en Postgres para que la agenda no esté vacía.
    await pg.query('DELETE FROM outbox WHERE clinic_id = $1', [SEED_CLINIC_ID]);
    await pg.query('DELETE FROM appointments WHERE clinic_id = $1', [SEED_CLINIC_ID]);
    const booked = await seedAppointments(new AppointmentsRepository(pg), validClinic.timezone);

    // 4. Índice vectorial de los documentos (requiere una API key, del panel o del .env).
    let indexed = 'sin indexar (no hay API key: configúrala en el panel o en .env y corre npm run index)';
    const { embedderFor, chunks } = createKnowledge(env, pg, createAiCredentials(env, mongo.db));
    const embedder = await embedderFor(SEED_CLINIC_ID);
    let agenda = 'la de data.ts (sin API key no se puede generar desde los documentos)';
    if (embedder) {
      const r = await indexClinicKnowledge({ db: mongo.db, chunks, embedder }, SEED_CLINIC_ID);
      indexed = `${r.chunks} fragmentos indexados (${r.reindexed} documentos con embeddings nuevos, ${r.unchanged} sin cambios)`;
      // 5. Agenda dinámica: se genera desde los documentos (incluye 09-profesionales-y-horarios.md).
      const meta = await createAgendaSync(env, mongo.db, createAiCredentials(env, mongo.db), { info() {}, error() {} }).run(SEED_CLINIC_ID);
      agenda = meta.status === 'lista' ? `generada desde los documentos (${meta.warnings.length} advertencias, ${meta.discarded.length} descartes)` : `no se pudo generar (${meta.status}: ${meta.error ?? ''}); queda la de data.ts`;
    }

    console.log(
      `seed listo: 1 clínica, ${validClinic.locations.length} sedes, ${validClinic.services.length} servicios, ` +
        `${validResources.length} recursos, ${documents.length} documentos, ${booked} citas · RAG: ${indexed} · agenda: ${agenda}`,
    );
  } finally {
    await Promise.allSettled([pg.end(), mongo.client.close()]);
  }
}

async function loadDocuments() {
  const files = (await readdir(DOCS_DIR)).filter((f) => f.endsWith('.md')).sort();
  return Promise.all(
    files.map(async (file) => {
      const content = (await readFile(path.join(DOCS_DIR, file), 'utf8')).trim();
      const title = content.split('\n')[0]?.replace(/^#\s*/, '') ?? file;
      return knowledgeDocumentSchema.parse({
        clinic_id: SEED_CLINIC_ID,
        slug: file.replace(/^\d+-/, '').replace(/\.md$/, ''),
        title,
        content,
        source_filename: file,
        source_format: 'markdown',
        updated_at: new Date(),
      });
    }),
  );
}

/**
 * Citas en los próximos días hábiles, calculadas en hora de Colombia y relativas
 * a la fecha actual para que el seed siga sirviendo cualquier día que se corra.
 */
async function seedAppointments(repo: AppointmentsRepository, timezone: string): Promise<number> {
  const nextWeekday = (from: DateTime, weekday: number) => {
    let d = from.plus({ days: 1 }).startOf('day');
    while (d.weekday !== weekday || clinic.holidays.includes(d.toISODate()!)) d = d.plus({ days: 1 });
    return d;
  };
  const today = DateTime.now().setZone(timezone);
  const at = (day: DateTime, hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return day.set({ hour: h, minute: m });
  };

  const tuesday = nextWeekday(today, 2);
  const wednesday = nextWeekday(today, 3);

  const bookings = [
    // Dermatología Sede Sur del próximo martes: dos de las primeras horas ocupadas.
    { resourceId: 'dra-camila-restrepo', locationId: 'sede-sur', serviceId: 'dermatologia', start: at(tuesday, '08:00'), min: 30, name: 'María Fernanda López', phone: '+573001110001' },
    { resourceId: 'dra-camila-restrepo', locationId: 'sede-sur', serviceId: 'dermatologia', start: at(tuesday, '08:30'), min: 30, name: 'Carlos Ramírez', phone: '+573001110002' },
    // Pediatría Sede Norte del próximo miércoles.
    { resourceId: 'dra-natalia-herrera', locationId: 'sede-norte', serviceId: 'pediatria', start: at(wednesday, '09:00'), min: 30, name: 'Sofía Torres (acudiente: Ana Torres)', phone: '+573001110003' },
    // Medicina general Sede Norte del próximo miércoles.
    { resourceId: 'dra-laura-gomez', locationId: 'sede-norte', serviceId: 'medicina-general', start: at(wednesday, '07:00'), min: 20, name: 'Jorge Salazar', phone: '+573001110004' },
  ];

  for (const b of bookings) {
    await repo.create({
      clinicId: SEED_CLINIC_ID,
      resourceId: b.resourceId,
      locationId: b.locationId,
      serviceId: b.serviceId,
      startsAt: b.start.toJSDate(),
      endsAt: b.start.plus({ minutes: b.min }).toJSDate(),
      patientPhone: b.phone,
      patientName: b.name,
      customFields: { documento: 'seed' },
    });
  }
  return bookings.length;
}

main().catch((err) => {
  console.error('falló el seed:', err);
  process.exitCode = 1;
});
