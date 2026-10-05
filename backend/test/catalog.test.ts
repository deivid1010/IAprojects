import { describe, expect, it } from 'vitest';
import { clinicSchema, resourceSchema, validateResourceAgainstClinic } from '../src/catalog/schemas.js';
import { clinic, resources } from '../src/seed/data.js';

describe('catálogo flexible', () => {
  it('los datos del seed son válidos y coherentes con su clínica', () => {
    const c = clinicSchema.parse(clinic);
    for (const r of resources) {
      expect(validateResourceAgainstClinic(resourceSchema.parse(r), c)).toEqual([]);
    }
  });

  it('acepta una clínica sin sedes y con un solo servicio', () => {
    const minimal = clinicSchema.parse({
      _id: 'consultorio-uno',
      name: 'Consultorio Uno',
      whatsapp_number: '+573009998877',
      timezone: 'America/Bogota',
      services: [{ id: 'psicologia', name: 'Psicología', duration_min: 50 }],
    });
    expect(minimal.locations).toEqual([]);
    expect(minimal.rules.booking_horizon_days).toBe(14);

    const resource = resourceSchema.parse({
      _id: 'ps-ana',
      clinic_id: 'consultorio-uno',
      name: 'Ps. Ana',
      type: 'professional',
      service_ids: ['psicologia'],
      schedules: [{ weekday: 1, start: '09:00', end: '13:00' }],
    });
    expect(validateResourceAgainstClinic(resource, minimal)).toEqual([]);
  });

  it('detecta servicios y sedes que no existen en la clínica', () => {
    const c = clinicSchema.parse(clinic);
    const bad = resourceSchema.parse({
      ...resources[0],
      service_ids: ['cardiologia'],
      schedules: [{ location_id: 'sede-oeste', weekday: 1, start: '08:00', end: '12:00' }],
    });
    expect(validateResourceAgainstClinic(bad, c)).toEqual(['servicio inexistente: cardiologia', 'sede inexistente: sede-oeste']);
  });

  it('exige sede en cada bloque si la clínica tiene sedes', () => {
    const c = clinicSchema.parse(clinic);
    const bad = resourceSchema.parse({ ...resources[0], schedules: [{ weekday: 1, start: '08:00', end: '12:00' }] });
    expect(validateResourceAgainstClinic(bad, c)).toHaveLength(1);
  });

  it('rechaza ids duplicados y bloques con fin antes del inicio', () => {
    expect(() => clinicSchema.parse({ ...clinic, services: [clinic.services[0], clinic.services[0]] })).toThrow(/duplicado/);
    expect(() =>
      resourceSchema.parse({ ...resources[0], schedules: [{ location_id: 'sede-norte', weekday: 1, start: '12:00', end: '08:00' }] }),
    ).toThrow(/anterior/);
  });
});
