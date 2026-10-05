import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { computeSlots, type SlotQuery } from '../../src/agenda/availability.js';
import { PDF_MESSAGE_AT, testClinic, testResources } from './fakes.js';

const derma = testClinic.services.find((s) => s.id === 'dermatologia')!;
const general = testClinic.services.find((s) => s.id === 'medicina-general')!;
const local = (iso: string) => DateTime.fromISO(iso, { zone: 'America/Bogota' }).toJSDate();
const hours = (slots: ReturnType<typeof computeSlots>) => slots.map((s) => DateTime.fromJSDate(s.start).setZone('America/Bogota').toFormat('HH:mm'));

const query = (overrides: Partial<SlotQuery> = {}): SlotQuery => ({
  clinic: testClinic,
  service: derma,
  resources: testResources,
  date: '2026-10-06', // martes
  locationId: null,
  franja: null,
  now: PDF_MESSAGE_AT,
  busy: [],
  ...overrides,
});

describe('computeSlots', () => {
  it('dermatología el martes 6: Sede Sur en la mañana y Sede Norte en la tarde', () => {
    const slots = computeSlots(query());
    const sur = slots.filter((s) => s.locationId === 'sede-sur');
    const norte = slots.filter((s) => s.locationId === 'sede-norte');
    expect(sur.every((s) => s.resourceId === 'dra-camila-restrepo')).toBe(true);
    expect(norte.every((s) => s.resourceId === 'dr-felipe-martinez')).toBe(true);
    expect(hours(sur)).toEqual(['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    expect(hours(norte)).toHaveLength(8);
  });

  it('"mañana en la tarde": solo horarios desde las 12:00', () => {
    const slots = computeSlots(query({ franja: 'tarde' }));
    expect(hours(slots)).toEqual(['14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30']);
  });

  it('filtra por sede', () => {
    expect(computeSlots(query({ locationId: 'sede-sur' })).every((s) => s.locationId === 'sede-sur')).toBe(true);
  });

  it('la duración del servicio define el paso: medicina general cada 20 minutos', () => {
    const slots = computeSlots(query({ service: general, locationId: 'sede-norte' }));
    expect(hours(slots).slice(0, 4)).toEqual(['07:00', '07:20', '07:40', '08:00']);
    expect(hours(slots).at(-1)).toBe('11:40'); // 11:40–12:00 cabe; 12:00 no
  });

  it('excluye horarios ocupados, aunque la cita ocupe solo una parte', () => {
    const busy = [{ resourceId: 'dra-camila-restrepo', start: local('2026-10-06T08:15'), end: local('2026-10-06T08:45') }];
    const sur = computeSlots(query({ locationId: 'sede-sur', busy }));
    expect(hours(sur).slice(0, 3)).toEqual(['09:00', '09:30', '10:00']); // 08:00 y 08:30 chocan
  });

  it('respeta la anticipación mínima (60 min) el mismo día', () => {
    const now = local('2026-10-06T14:10'); // martes 2:10 p. m.
    const slots = computeSlots(query({ now, locationId: 'sede-norte' }));
    expect(hours(slots)[0]).toBe('15:30'); // 14:00–15:00 quedan antes de now + 60 min
  });

  it('no hay horarios en festivos, en excepciones del profesional ni en días sin agenda', () => {
    expect(computeSlots(query({ date: '2026-10-12' }))).toEqual([]); // festivo
    expect(computeSlots(query({ date: '2026-10-11' }))).toEqual([]); // domingo
    const conExcepcion = testResources.map((r) =>
      r._id === 'dr-felipe-martinez' ? { ...r, exceptions: [{ date: '2026-10-06', reason: 'congreso' }] } : r,
    );
    expect(computeSlots(query({ resources: conExcepcion, franja: 'tarde' }))).toEqual([]);
  });
});
