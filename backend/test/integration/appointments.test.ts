import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppointmentsRepository, SlotTakenError, type NewAppointment } from '../../src/appointments/appointmentsRepository.js';
import { loadEnv } from '../../src/config/env.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgPool, type PgPool } from '../../src/db/postgres.js';

// Contra un Postgres real: la garantía contra citas cruzadas vive en el esquema,
// así que se prueba con la base, no con un mock.
let pool: PgPool;
let repo: AppointmentsRepository;
// Una clínica distinta por corrida para no chocar con el seed ni con otras corridas.
const clinicId = `test-${randomUUID().slice(0, 8)}`;

const at = (hhmm: string) => new Date(`2030-01-15T${hhmm}:00-05:00`);

function appt(overrides: Partial<NewAppointment> = {}): NewAppointment {
  return {
    clinicId,
    resourceId: 'dr-test',
    locationId: 'sede-test',
    serviceId: 'dermatologia',
    startsAt: at('10:00'),
    endsAt: at('10:30'),
    patientPhone: '+573000000000',
    patientName: 'Paciente de prueba',
    ...overrides,
  };
}

beforeAll(async () => {
  pool = createPgPool(loadEnv().DATABASE_URL);
  await runMigrations(pool, () => {});
  repo = new AppointmentsRepository(pool);
});

afterAll(async () => {
  await pool.query('DELETE FROM outbox WHERE clinic_id = $1', [clinicId]);
  await pool.query('DELETE FROM appointments WHERE clinic_id = $1', [clinicId]);
  await pool.end();
});

describe('appointments: restricción contra cruces de horario', () => {
  it('crea la cita y su evento de outbox en la misma transacción', async () => {
    const created = await repo.create(appt({ resourceId: 'dr-outbox' }));
    expect(created.status).toBe('confirmada');

    const { rows } = await pool.query(
      `SELECT event_type FROM outbox WHERE clinic_id = $1 AND payload->>'appointment_id' = $2`,
      [clinicId, created.id],
    );
    expect(rows).toEqual([{ event_type: 'appointment.created' }]);
  });

  it('rechaza la misma hora para el mismo recurso', async () => {
    await repo.create(appt({ resourceId: 'dr-a' }));
    await expect(repo.create(appt({ resourceId: 'dr-a' }))).rejects.toBeInstanceOf(SlotTakenError);
  });

  it('rechaza horarios que se cruzan parcialmente aunque las duraciones sean distintas', async () => {
    await repo.create(appt({ resourceId: 'dr-b', startsAt: at('10:00'), endsAt: at('10:30') }));
    await expect(
      repo.create(appt({ resourceId: 'dr-b', startsAt: at('10:15'), endsAt: at('11:00') })),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  it('permite citas contiguas: 10:00–10:30 y 10:30–11:00', async () => {
    await repo.create(appt({ resourceId: 'dr-c', startsAt: at('10:00'), endsAt: at('10:30') }));
    await expect(repo.create(appt({ resourceId: 'dr-c', startsAt: at('10:30'), endsAt: at('11:00') }))).resolves.toBeDefined();
  });

  it('permite la misma hora con otro recurso', async () => {
    await repo.create(appt({ resourceId: 'dr-d' }));
    await expect(repo.create(appt({ resourceId: 'dr-e' }))).resolves.toBeDefined();
  });

  it('una cita cancelada libera el horario', async () => {
    const first = await repo.create(appt({ resourceId: 'dr-f' }));
    expect(await repo.cancel(clinicId, first.id)).toBe(true);
    await expect(repo.create(appt({ resourceId: 'dr-f' }))).resolves.toBeDefined();
  });

  it('con 10 pacientes pidiendo el mismo horario a la vez, solo uno lo obtiene', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => repo.create(appt({ resourceId: 'dr-concurrente', patientPhone: `+57300000000${i}` }))),
    );
    const ok = attempts.filter((a) => a.status === 'fulfilled');
    const taken = attempts.filter((a) => a.status === 'rejected' && a.reason instanceof SlotTakenError);
    expect(ok).toHaveLength(1);
    expect(taken).toHaveLength(9);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM outbox o
       JOIN appointments a ON a.id = (o.payload->>'appointment_id')::uuid
       WHERE o.clinic_id = $1 AND a.resource_id = 'dr-concurrente'`,
      [clinicId],
    );
    expect(rows[0].n).toBe(1); // los intentos fallidos no dejan eventos huérfanos
  });

  it('rechaza una cita que termina antes de empezar', async () => {
    await expect(repo.create(appt({ resourceId: 'dr-g', startsAt: at('11:00'), endsAt: at('10:00') }))).rejects.toThrow(
      /appointments_time_chk/,
    );
  });

  it('findConfirmedOverlapping devuelve solo las confirmadas que se cruzan con el rango', async () => {
    await repo.create(appt({ resourceId: 'dr-h', startsAt: at('08:00'), endsAt: at('08:30') }));
    await repo.create(appt({ resourceId: 'dr-h', startsAt: at('09:00'), endsAt: at('09:30') }));
    const cancelled = await repo.create(appt({ resourceId: 'dr-h', startsAt: at('09:30'), endsAt: at('10:00') }));
    await repo.cancel(clinicId, cancelled.id);

    const found = await repo.findConfirmedOverlapping(clinicId, ['dr-h'], at('08:15'), at('10:00'));
    expect(found.map((a) => a.startsAt.toISOString())).toEqual([at('08:00').toISOString(), at('09:00').toISOString()]);
  });
});
