import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingError } from '../../src/agenda/AgendaProvider.js';
import { LocalAgendaProvider } from '../../src/agenda/localAgendaProvider.js';
import { AppointmentsRepository, SlotTakenError } from '../../src/appointments/appointmentsRepository.js';
import { CatalogRepository } from '../../src/catalog/catalogRepository.js';
import { clinicSchema, type Clinic } from '../../src/catalog/schemas.js';
import { loadEnv } from '../../src/config/env.js';
import { clinicsCollection, ensureMongoIndexes, resourcesCollection } from '../../src/db/collections.js';
import { connectMongo, type Mongo } from '../../src/db/mongo.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgPool, type PgPool } from '../../src/db/postgres.js';
import { clinic as seedClinic, resources as seedResources } from '../../src/seed/data.js';

// LocalAgendaProvider contra MongoDB (catálogo) y PostgreSQL (citas) reales.
let mongo: Mongo;
let pool: PgPool;
let agenda: LocalAgendaProvider;
let clinic: Clinic;
const suffix = randomUUID().slice(0, 8);
const clinicId = `test-${suffix}`;
const NOW = new Date('2026-10-06T03:40:00Z'); // lunes 5, 10:40 p. m. en Cali

beforeAll(async () => {
  const env = loadEnv();
  mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
  pool = createPgPool(env.DATABASE_URL);
  await ensureMongoIndexes(mongo.db);
  await runMigrations(pool, () => {});

  clinic = clinicSchema.parse({ ...seedClinic, _id: clinicId, whatsapp_number: `+5797${Date.now() % 1e8}`, whatsapp_business_account_id: `7${Date.now()}` });
  await clinicsCollection(mongo.db).insertOne(clinic);
  await resourcesCollection(mongo.db).insertMany(seedResources.map((r) => ({ ...r, _id: `${r._id}-${suffix}`, clinic_id: clinicId })));
  agenda = new LocalAgendaProvider(new CatalogRepository(mongo.db), new AppointmentsRepository(pool));
});

afterAll(async () => {
  await pool.query('DELETE FROM outbox WHERE clinic_id = $1', [clinicId]);
  await pool.query('DELETE FROM appointments WHERE clinic_id = $1', [clinicId]);
  await clinicsCollection(mongo.db).deleteOne({ _id: clinicId });
  await resourcesCollection(mongo.db).deleteMany({ clinic_id: clinicId });
  await Promise.all([pool.end(), mongo.client.close()]);
});

const felipe = () => `dr-felipe-martinez-${suffix}`;
const hours = (slots: { start: Date }[]) => slots.map((s) => DateTime.fromJSDate(s.start).setZone('America/Bogota').toFormat('HH:mm'));
const booking = (time: string, phone: string, messageId: string) => ({
  clinic,
  serviceId: 'dermatologia',
  locationId: 'sede-norte',
  resourceId: felipe(),
  date: '2026-10-06',
  time,
  now: NOW,
  patientPhone: phone,
  patientName: 'Paciente de prueba',
  customFields: { documento: '1' },
  sourceMessageId: messageId,
});

describe('LocalAgendaProvider (Mongo + Postgres)', () => {
  it('agenda y el horario desaparece de la disponibilidad', async () => {
    const query = { clinic, serviceId: 'dermatologia', locationId: 'sede-norte', date: '2026-10-06', franja: 'tarde' as const, now: NOW };
    expect(hours(await agenda.findAvailability(query))).toContain('15:00');

    await agenda.book(booking('15:00', '+573000000001', `m-${suffix}-1`));
    expect(hours(await agenda.findAvailability(query))).not.toContain('15:00');
  });

  it('otro paciente no puede tomar el mismo horario', async () => {
    await expect(agenda.book(booking('15:00', '+573000000002', `m-${suffix}-2`))).rejects.toBeInstanceOf(SlotTakenError);
  });

  it('el reintento del mismo mensaje devuelve la cita existente', async () => {
    const a = await agenda.book(booking('16:00', '+573000000003', `m-${suffix}-3`));
    const b = await agenda.book(booking('16:00', '+573000000003', `m-${suffix}-3`));
    expect(b.id).toBe(a.id);
  });

  it('rechaza horarios que no existen en la agenda del profesional', async () => {
    await expect(agenda.book(booking('18:00', '+573000000004', `m-${suffix}-4`))).rejects.toBeInstanceOf(BookingError);
    await expect(agenda.book({ ...booking('09:00', '+573000000004', `m-${suffix}-5`) })).rejects.toBeInstanceOf(BookingError);
  });
});
