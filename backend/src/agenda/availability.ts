import { DateTime } from 'luxon';
import type { Clinic, Resource, Service } from '../catalog/schemas.js';

export type Franja = 'manana' | 'tarde';

export interface Slot {
  resourceId: string;
  resourceName: string;
  locationId: string | null;
  serviceId: string;
  start: Date;
  end: Date;
}

export interface BusyInterval {
  resourceId: string;
  start: Date;
  end: Date;
}

export interface SlotQuery {
  clinic: Clinic;
  service: Service;
  resources: Resource[];
  /** Fecha local de la clínica, YYYY-MM-DD. */
  date: string;
  /** null: todas las sedes. */
  locationId: string | null;
  franja?: Franja | null;
  now: Date;
  /** Citas confirmadas que ocupan a los recursos. */
  busy: BusyInterval[];
}

const AFTERNOON_STARTS_AT = 12;

/**
 * Horarios libres de un servicio en una fecha. Función pura: los horarios
 * semanales de cada recurso (Mongo) menos festivos, excepciones, anticipación
 * mínima y citas confirmadas (Postgres). Cada horario dura lo que dura el
 * servicio y se alinea al inicio del bloque de atención.
 */
export function computeSlots(q: SlotQuery): Slot[] {
  const { clinic, service } = q;
  const tz = clinic.timezone;
  if (clinic.holidays.includes(q.date)) return [];

  const day = DateTime.fromISO(q.date, { zone: tz });
  const earliest = DateTime.fromJSDate(q.now).plus({ minutes: clinic.rules.min_lead_minutes });
  const slots: Slot[] = [];

  for (const resource of q.resources) {
    if (!resource.active || !resource.service_ids.includes(service.id)) continue;
    if (resource.exceptions.some((e) => e.date === q.date)) continue;
    const busy = q.busy.filter((b) => b.resourceId === resource._id);

    for (const block of resource.schedules) {
      if (block.weekday !== day.weekday) continue;
      if (q.locationId && block.location_id !== q.locationId) continue;

      const blockEnd = atTime(day, block.end);
      for (let start = atTime(day, block.start); start.plus({ minutes: service.duration_min }) <= blockEnd; start = start.plus({ minutes: service.duration_min })) {
        const end = start.plus({ minutes: service.duration_min });
        if (start < earliest) continue;
        if (q.franja === 'manana' && start.hour >= AFTERNOON_STARTS_AT) continue;
        if (q.franja === 'tarde' && start.hour < AFTERNOON_STARTS_AT) continue;
        if (busy.some((b) => start.toJSDate() < b.end && end.toJSDate() > b.start)) continue;

        slots.push({
          resourceId: resource._id,
          resourceName: resource.name,
          locationId: block.location_id ?? null,
          serviceId: service.id,
          start: start.toJSDate(),
          end: end.toJSDate(),
        });
      }
    }
  }

  return slots.sort((a, b) => a.start.getTime() - b.start.getTime() || a.resourceName.localeCompare(b.resourceName));
}

function atTime(day: DateTime, hhmm: string): DateTime {
  const [hour, minute] = hhmm.split(':').map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}
