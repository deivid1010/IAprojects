import { describe, expect, it } from 'vitest';
import { buildCalendar } from '../../src/agenda/calendar.js';
import type { Appointment } from '../../src/appointments/appointmentsRepository.js';
import { buildApp } from '../../src/http/app.js';
import { fakeAppDeps } from '../helpers.js';
import { PDF_MESSAGE_AT, testClinic, testResources } from './fakes.js';

const felipe = 'dr-felipe-martinez';

const appointment = (start: string, end: string, a: Partial<Appointment> = {}): Appointment => ({
  id: `cita-${start}`,
  clinicId: testClinic._id,
  resourceId: felipe,
  locationId: 'sede-norte',
  serviceId: 'dermatologia',
  startsAt: new Date(start),
  endsAt: new Date(end),
  patientPhone: '+573001112233',
  patientName: 'Ana Pérez',
  customFields: {},
  status: 'confirmada',
  sourceMessageId: null,
  createdAt: new Date(),
  ...a,
});

const professional = (days: ReturnType<typeof buildCalendar>, date: string, id: string) => days.find((d) => d.date === date)?.professionals.find((p) => p.id === id);

describe('buildCalendar', () => {
  it('descuenta las citas confirmadas de los bloques de atención (hora de Cali)', () => {
    // Martes 6 de octubre, 15:00–15:30 en Cali = 20:00–20:30 UTC.
    const days = buildCalendar({
      clinic: testClinic,
      resources: testResources,
      appointments: [appointment('2026-10-06T20:00:00Z', '2026-10-06T20:30:00Z')],
      from: '2026-10-06',
      to: '2026-10-06',
      now: PDF_MESSAGE_AT,
    });
    const p = professional(days, '2026-10-06', felipe)!;
    expect(p.blocks).toEqual([
      {
        location: 'Sede Norte',
        start: '14:00',
        end: '18:00',
        free: [
          { start: '14:00', end: '15:00' },
          { start: '15:30', end: '18:00' },
        ],
      },
    ]);
    expect(p.appointments).toEqual([
      { id: 'cita-2026-10-06T20:00:00Z', start: '15:00', end: '15:30', patient_name: 'Ana Pérez', patient_phone: '+573001112233', service: 'Dermatología', location: 'Sede Norte' },
    ]);
  });

  it('no ofrece tramos libres antes de la anticipación mínima', () => {
    // Martes 6, 15:10 en Cali: con 60 min de anticipación, lo libre arranca a las 16:10.
    const days = buildCalendar({ clinic: testClinic, resources: testResources, appointments: [], from: '2026-10-06', to: '2026-10-06', now: new Date('2026-10-06T20:10:00Z') });
    expect(professional(days, '2026-10-06', felipe)!.blocks[0]!.free).toEqual([{ start: '16:10', end: '18:00' }]);
  });

  it('en festivos no hay bloques de atención, y las citas canceladas no ocupan', () => {
    const days = buildCalendar({
      clinic: testClinic,
      resources: testResources,
      appointments: [appointment('2026-10-08T19:00:00Z', '2026-10-08T19:30:00Z', { status: 'cancelada' })],
      from: '2026-10-08',
      to: '2026-10-12',
      now: PDF_MESSAGE_AT,
    });
    expect(days.map((d) => d.date)).toEqual(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
    expect(professional(days, '2026-10-08', felipe)!.blocks[0]!.free).toEqual([{ start: '14:00', end: '18:00' }]);
    const holiday = days.find((d) => d.date === '2026-10-12')!;
    expect(holiday.holiday).toBe(true);
    expect(holiday.professionals).toEqual([]);
  });
});

describe('GET /agenda/calendar', () => {
  const deps = () =>
    fakeAppDeps({
      agenda: {
        sync: { status: async () => null, schedule: () => {} },
        catalog: { findClinicById: async () => testClinic, findResourcesByClinic: async () => testResources },
        appointments: { findConfirmedOverlapping: async () => [appointment('2026-10-06T20:00:00Z', '2026-10-06T20:30:00Z')] },
        now: () => PDF_MESSAGE_AT,
      },
    });

  it('devuelve los días del rango con citas y tramos libres', async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: 'GET', url: '/agenda/calendar?from=2026-10-05&to=2026-10-11' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.today).toBe('2026-10-05');
    expect(body.days).toHaveLength(7);
    expect(professional(body.days, '2026-10-06', felipe)!.appointments[0]!.patient_name).toBe('Ana Pérez');
  });

  it('rechaza rangos inválidos o demasiado largos', async () => {
    const app = buildApp(deps());
    for (const url of ['/agenda/calendar', '/agenda/calendar?from=2026-10-10&to=2026-10-01', '/agenda/calendar?from=2026-01-01&to=2026-12-31']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(400);
    }
  });
});
