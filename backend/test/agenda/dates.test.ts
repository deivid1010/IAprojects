import { describe, expect, it } from 'vitest';
import { checkBookableDate, describeInstant, resolveDate } from '../../src/agenda/dates.js';
import { PDF_MESSAGE_AT, testClinic } from './fakes.js';

const TZ = 'America/Bogota';

describe('fechas en hora de la clínica', () => {
  it('caso del enunciado: 03:40 UTC del 6 de octubre → "mañana" es el 6, no el 7', () => {
    expect(resolveDate('manana', PDF_MESSAGE_AT, TZ)).toEqual({ ok: true, date: '2026-10-06' });
    expect(resolveDate('hoy', PDF_MESSAGE_AT, TZ)).toEqual({ ok: true, date: '2026-10-05' });
    expect(resolveDate('pasado_manana', PDF_MESSAGE_AT, TZ)).toEqual({ ok: true, date: '2026-10-07' });
  });

  it('en UTC el resultado sería otro día: por eso no se usa la fecha UTC', () => {
    expect(PDF_MESSAGE_AT.toISOString().slice(0, 10)).toBe('2026-10-06'); // "hoy" en UTC
    expect(resolveDate('hoy', PDF_MESSAGE_AT, TZ)).toEqual({ ok: true, date: '2026-10-05' }); // hoy en Cali
  });

  it('tolera variantes que el modelo podría enviar', () => {
    expect(resolveDate('Mañana', PDF_MESSAGE_AT, TZ)).toEqual({ ok: true, date: '2026-10-06' });
    expect(resolveDate('pasado mañana', PDF_MESSAGE_AT, TZ)).toEqual({ ok: true, date: '2026-10-07' });
    expect(resolveDate('2026-10-09', PDF_MESSAGE_AT, TZ)).toEqual({ ok: true, date: '2026-10-09' });
  });

  it('rechaza fechas que no entiende', () => {
    expect(resolveDate('el jueves', PDF_MESSAGE_AT, TZ).ok).toBe(false);
    expect(resolveDate('2026-02-30', PDF_MESSAGE_AT, TZ).ok).toBe(false);
  });

  it('describe la hora actual en español y en hora local', () => {
    expect(describeInstant(PDF_MESSAGE_AT, TZ)).toMatch(/^lunes 5 de octubre de 2026, 10:40/);
  });

  it('valida fechas pasadas, festivos y el horizonte de agendamiento', () => {
    expect(checkBookableDate('2026-10-04', testClinic, PDF_MESSAGE_AT)?.code).toBe('fecha_pasada');
    expect(checkBookableDate('2026-10-12', testClinic, PDF_MESSAGE_AT)?.code).toBe('festivo');
    expect(checkBookableDate('2026-10-20', testClinic, PDF_MESSAGE_AT)?.code).toBe('fuera_de_horizonte');
    expect(checkBookableDate('2026-10-19', testClinic, PDF_MESSAGE_AT)).toBeNull(); // hoy + 14 días
    expect(checkBookableDate('2026-10-05', testClinic, PDF_MESSAGE_AT)).toBeNull(); // hoy (local) es válido
  });
});
