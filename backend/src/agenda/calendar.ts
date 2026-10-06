import { DateTime } from 'luxon';
import type { Appointment } from '../appointments/appointmentsRepository.js';
import type { Clinic, Resource } from '../catalog/schemas.js';

export interface CalendarAppointment {
  id: string;
  start: string;
  end: string;
  patient_name: string;
  patient_phone: string;
  service: string;
  location: string | null;
}

export interface CalendarBlock {
  location: string | null;
  start: string;
  end: string;
  /** Tramos del bloque sin citas y todavía agendables (respeta la anticipación mínima). */
  free: { start: string; end: string }[];
}

export interface CalendarDay {
  date: string;
  holiday: boolean;
  professionals: {
    id: string;
    name: string;
    /** El profesional tiene una excepción ese día (vacaciones, incapacidad…). */
    unavailable: string | null;
    blocks: CalendarBlock[];
    appointments: CalendarAppointment[];
  }[];
}

export interface CalendarQuery {
  clinic: Clinic;
  resources: Resource[];
  /** Citas confirmadas que se cruzan con el rango. */
  appointments: Appointment[];
  /** Fechas locales de la clínica, YYYY-MM-DD, ambas incluidas. */
  from: string;
  to: string;
  now: Date;
}

/**
 * Calendario de la clínica (función pura): por día y profesional, los bloques de
 * atención, las citas confirmadas y los tramos libres. Los tramos libres no
 * dependen del servicio: son el bloque menos las citas, sin festivos, sin
 * excepciones y desde la anticipación mínima. Horas en HH:mm locales.
 */
export function buildCalendar(q: CalendarQuery): CalendarDay[] {
  const { clinic } = q;
  const tz = clinic.timezone;
  const earliest = DateTime.fromJSDate(q.now).setZone(tz).plus({ minutes: clinic.rules.min_lead_minutes });
  const locationName = (id?: string | null) => (id ? (clinic.locations.find((l) => l.id === id)?.name ?? id) : null);
  const serviceName = (id: string) => clinic.services.find((s) => s.id === id)?.name ?? id;
  const hhmm = (d: DateTime) => d.toFormat('HH:mm');

  const days: CalendarDay[] = [];
  const last = DateTime.fromISO(q.to, { zone: tz });
  for (let day = DateTime.fromISO(q.from, { zone: tz }).startOf('day'); day <= last; day = day.plus({ days: 1 })) {
    const date = day.toISODate()!;
    const holiday = clinic.holidays.includes(date);
    const dayEnd = day.plus({ days: 1 });

    const professionals = q.resources
      .filter((r) => r.active)
      .map((resource) => {
        const exception = resource.exceptions.find((e) => e.date === date);
        const appointments = q.appointments
          .filter((a) => a.resourceId === resource._id && a.status === 'confirmada')
          .map((a) => ({ a, start: DateTime.fromJSDate(a.startsAt).setZone(tz), end: DateTime.fromJSDate(a.endsAt).setZone(tz) }))
          .filter(({ start, end }) => start < dayEnd && end > day)
          .sort((x, y) => x.start.toMillis() - y.start.toMillis());

        const blocks: CalendarBlock[] =
          holiday || exception
            ? []
            : resource.schedules
                .filter((b) => b.weekday === day.weekday)
                .sort((a, b) => a.start.localeCompare(b.start))
                .map((b) => {
                  const start = atTime(day, b.start);
                  const end = atTime(day, b.end);
                  return {
                    location: locationName(b.location_id),
                    start: b.start,
                    end: b.end,
                    free: subtract(start < earliest ? earliest : start, end, appointments).map((f) => ({ start: hhmm(f.start), end: hhmm(f.end) })),
                  };
                });

        return {
          id: resource._id,
          name: resource.name,
          unavailable: exception ? (exception.reason ?? 'No atiende este día') : null,
          blocks,
          appointments: appointments.map(({ a, start, end }) => ({
            id: a.id,
            start: hhmm(start),
            end: hhmm(end),
            patient_name: a.patientName,
            patient_phone: a.patientPhone,
            service: serviceName(a.serviceId),
            location: locationName(a.locationId),
          })),
        };
      })
      .filter((p) => p.blocks.length > 0 || p.appointments.length > 0 || p.unavailable);

    days.push({ date, holiday, professionals });
  }
  return days;
}

/** [start, end) menos los intervalos ocupados (ordenados por inicio). */
function subtract(start: DateTime, end: DateTime, busy: { start: DateTime; end: DateTime }[]) {
  const free: { start: DateTime; end: DateTime }[] = [];
  let cursor = start;
  for (const b of busy) {
    if (b.end <= cursor || b.start >= end) continue;
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    if (b.end > cursor) cursor = b.end;
  }
  if (cursor < end) free.push({ start: cursor, end });
  return free.filter((f) => f.end.diff(f.start, 'minutes').minutes >= 1);
}

function atTime(day: DateTime, time: string): DateTime {
  const [hour, minute] = time.split(':').map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}
