import { DateTime } from 'luxon';
import type { Clinic } from '../catalog/schemas.js';

// Todas las fechas del dominio se interpretan en la zona horaria de la clínica.
// "Mañana" se resuelve aquí, en código, a partir de la hora del mensaje: no se
// le pide al LLM que haga aritmética de fechas ni de zonas horarias.
//
// Ejemplo del enunciado: mensaje a las 2026-10-06T03:40:00Z = 10:40 p. m. del
// 5 de octubre en Cali → "manana" = 2026-10-06, no el 7.

export const RELATIVE_DATES = ['hoy', 'manana', 'pasado_manana'] as const;
const OFFSETS: Record<(typeof RELATIVE_DATES)[number], number> = { hoy: 0, manana: 1, pasado_manana: 2 };

export function localDateTime(instant: Date, timezone: string): DateTime {
  return DateTime.fromJSDate(instant).setZone(timezone);
}

/** 'hoy' | 'manana' | 'pasado_manana' | 'YYYY-MM-DD' → fecha local de la clínica (YYYY-MM-DD). */
export function resolveDate(input: string, reference: Date, timezone: string): { ok: true; date: string } | { ok: false; message: string } {
  const value = input.trim().toLowerCase().replace('mañana', 'manana').replace(/\s+/g, '_');
  if (value in OFFSETS) {
    const today = localDateTime(reference, timezone).startOf('day');
    return { ok: true, date: today.plus({ days: OFFSETS[value as keyof typeof OFFSETS] }).toISODate()! };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = DateTime.fromISO(value, { zone: timezone });
    if (d.isValid) return { ok: true, date: d.toISODate()! };
  }
  return { ok: false, message: `Fecha no válida: "${input}". Usa 'hoy', 'manana', 'pasado_manana' o el formato YYYY-MM-DD.` };
}

export type DateProblem = 'fecha_pasada' | 'fuera_de_horizonte' | 'festivo';

/** Problemas de una fecha local respecto a las reglas de la clínica, o null si es agendable. */
export function checkBookableDate(date: string, clinic: Clinic, now: Date): { code: DateProblem; message: string } | null {
  const today = localDateTime(now, clinic.timezone).startOf('day');
  const day = DateTime.fromISO(date, { zone: clinic.timezone }).startOf('day');
  if (day < today) return { code: 'fecha_pasada', message: `La fecha ${date} ya pasó. Hoy es ${today.toISODate()}.` };

  const last = today.plus({ days: clinic.rules.booking_horizon_days });
  if (day > last) {
    return {
      code: 'fuera_de_horizonte',
      message: `Solo se agenda con hasta ${clinic.rules.booking_horizon_days} días de anticipación (hasta el ${last.toISODate()}).`,
    };
  }
  if (clinic.holidays.includes(date)) return { code: 'festivo', message: `El ${date} es festivo: la clínica no atiende.` };
  return null;
}

/** "lunes 5 de octubre de 2026, 10:40 p. m." en hora de la clínica. */
export function describeInstant(instant: Date, timezone: string): string {
  return localDateTime(instant, timezone).setLocale('es').toFormat("cccc d 'de' LLLL 'de' yyyy, h:mm a");
}

/** "martes 6 de octubre" */
export function describeDate(date: string, timezone: string): string {
  return DateTime.fromISO(date, { zone: timezone }).setLocale('es').toFormat("cccc d 'de' LLLL");
}
