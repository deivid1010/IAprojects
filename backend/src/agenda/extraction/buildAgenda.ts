import { z } from 'zod';
import { normalize } from '../matching.js';
import type { Location, Resource, ScheduleBlock, Service } from '../../catalog/schemas.js';

// Convierte lo que el LLM extrajo del documento en una agenda válida. El modelo
// solo propone; este código decide qué entra: cada nombre debe aparecer escrito
// en el documento, los días y horas deben ser válidos y las referencias entre
// profesionales, servicios y sedes deben cerrar. Lo que no cumple se descarta
// y queda registrado.

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const day = z.number().int().min(1).max(7);

/** Formato que debe devolver el extractor (JSON Schema estricto en el LLM). */
export const extractedAgendaSchema = z.object({
  locations: z.array(
    z.object({
      name: z.string(),
      address: z.string().nullable(),
      hours: z.array(z.object({ days: z.array(day), start: hhmm, end: hhmm })),
    }),
  ),
  services: z.array(z.object({ name: z.string(), duration_min: z.number().int().nullable() })),
  professionals: z.array(
    z.object({
      name: z.string(),
      services: z.array(z.string()),
      schedules: z.array(z.object({ location: z.string(), days: z.array(day), start: hhmm.nullable(), end: hhmm.nullable() })),
    }),
  ),
  notes: z.array(z.string()),
});
export type ExtractedAgenda = z.infer<typeof extractedAgendaSchema>;

export interface BuiltAgenda {
  locations: Location[];
  services: Service[];
  resources: Omit<Resource, 'clinic_id'>[];
  /** Ajustes aplicados (p. ej. horario de la sede usado porque el documento no da la hora). */
  warnings: string[];
  /** Elementos que el código rechazó y por qué. */
  discarded: string[];
}

export const VIRTUAL_LOCATION_ID = 'teleconsulta';
const DEFAULT_DURATION_MIN = 30;

export function buildAgenda(raw: ExtractedAgenda, documentText: string): BuiltAgenda {
  const text = normalize(documentText);
  const appearsInDocument = (name: string) => normalize(name).length > 2 && text.includes(normalize(name));
  const warnings: string[] = [];
  const discarded: string[] = [];

  // --- Sedes (con sus horarios, que sirven para completar los de los profesionales)
  const locationHours = new Map<string, { days: number[]; start: string; end: string }[]>();
  const locations: Location[] = [];
  for (const loc of raw.locations) {
    const isVirtual = isVirtualName(loc.name);
    if (!isVirtual && !appearsInDocument(loc.name)) {
      discarded.push(`Sede "${loc.name}": no aparece en el documento.`);
      continue;
    }
    const id = isVirtual ? VIRTUAL_LOCATION_ID : slug(loc.name);
    if (!id || locations.some((l) => l.id === id)) continue;
    locations.push({ id, name: isVirtual ? 'Teleconsulta' : loc.name.trim(), ...(loc.address ? { address: loc.address.trim() } : {}) });
    locationHours.set(id, loc.hours.filter((h) => h.start < h.end));
  }

  // --- Servicios
  const services: Service[] = [];
  for (const svc of raw.services) {
    // La teleconsulta es una modalidad (sede virtual), no un servicio aparte.
    if (isVirtualName(svc.name)) {
      discarded.push(`Servicio "${svc.name}": es una modalidad de atención (se agenda como sede virtual), no un servicio.`);
      continue;
    }
    if (!appearsInDocument(svc.name)) {
      discarded.push(`Servicio "${svc.name}": no aparece en el documento.`);
      continue;
    }
    const id = slug(svc.name);
    if (!id || services.some((s) => s.id === id)) continue;
    let duration = svc.duration_min;
    if (duration === null || duration < 5 || duration > 480) {
      warnings.push(`Servicio "${svc.name}": el documento no da una duración válida; se usan ${DEFAULT_DURATION_MIN} min.`);
      duration = DEFAULT_DURATION_MIN;
    }
    services.push({ id, name: svc.name.trim(), duration_min: duration, attributes: {} });
  }

  // --- Profesionales
  const resources: Omit<Resource, 'clinic_id'>[] = [];
  for (const pro of raw.professionals) {
    if (!appearsInDocument(pro.name)) {
      discarded.push(`Profesional "${pro.name}": no aparece en el documento.`);
      continue;
    }
    const serviceIds = [...new Set(pro.services.map((n) => findByName(services, n, (s) => s.name)?.id).filter((x): x is string => Boolean(x)))];
    if (serviceIds.length === 0) {
      discarded.push(`Profesional "${pro.name}": ninguno de sus servicios (${pro.services.join(', ') || '—'}) está en la lista de servicios.`);
      continue;
    }

    const blocks: ScheduleBlock[] = [];
    const filledDays = new Map<string, number[]>(); // sede → días completados con el horario de la sede
    for (const sch of pro.schedules) {
      const location = findByName(locations, sch.location, (l) => l.name) ?? (isVirtualName(sch.location) ? virtualLocation(locations) : undefined);
      if (!location) {
        discarded.push(`Horario de "${pro.name}" en "${sch.location}": la sede no existe.`);
        continue;
      }
      for (const d of [...new Set(sch.days)]) {
        if (sch.start && sch.end) {
          if (sch.start < sch.end) blocks.push({ location_id: location.id, weekday: d, start: sch.start, end: sch.end });
          continue;
        }
        // El documento no da la hora: se usa el horario de la sede ese día.
        const hours = (locationHours.get(location.id) ?? []).find((h) => h.days.includes(d));
        if (hours) {
          blocks.push({ location_id: location.id, weekday: d, start: hours.start, end: hours.end });
          filledDays.set(location.name, [...(filledDays.get(location.name) ?? []), d]);
        } else {
          discarded.push(`"${pro.name}" (${location.name}, ${DAY_NAMES[d]}): sin hora en el documento ni horario de la sede para ese día.`);
        }
      }
    }
    // 2. Una advertencia por profesional y sede, no una por día.
    for (const [locName, ds] of filledDays) {
      warnings.push(`"${pro.name}" (${locName}, ${ds.map((d) => DAY_NAMES[d]).join(', ')}): el documento no da la hora; se usa el horario de la sede.`);
    }
    if (blocks.length === 0) {
      discarded.push(`Profesional "${pro.name}": no quedó ningún horario válido.`);
      continue;
    }
    const id = slug(pro.name);
    if (resources.some((r) => r._id === id)) continue;
    resources.push({ _id: id, name: pro.name.trim(), type: 'professional', service_ids: serviceIds, schedules: blocks, exceptions: [], active: true });
  }

  // Sedes y servicios que no usa ningún profesional no sirven para agendar.
  const usedServices = new Set(resources.flatMap((r) => r.service_ids));
  const usedLocations = new Set(resources.flatMap((r) => r.schedules.map((s) => s.location_id)));
  for (const s of services.filter((x) => !usedServices.has(x.id))) warnings.push(`Servicio "${s.name}": ningún profesional lo presta; no se puede agendar.`);

  return {
    locations: locations.filter((l) => usedLocations.has(l.id)),
    services: services.filter((s) => usedServices.has(s.id)),
    resources,
    warnings,
    discarded,
  };
}

function isVirtualName(name: string): boolean {
  const n = normalize(name);
  return n.includes('teleconsulta') || n.includes('virtual') || n.includes('videollamada');
}

/** La sede virtual se crea sola la primera vez que un horario la usa. */
function virtualLocation(locations: Location[]): Location {
  let loc = locations.find((l) => l.id === VIRTUAL_LOCATION_ID);
  if (!loc) {
    loc = { id: VIRTUAL_LOCATION_ID, name: 'Teleconsulta' };
    locations.push(loc);
  }
  return loc;
}

const DAY_NAMES = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

/** "Sede Norte – Granada" → "sede-norte-granada" */
function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Coincidencia exacta normalizada; si no, una parcial única. */
function findByName<T>(items: T[], name: string, key: (t: T) => string): T | undefined {
  const q = normalize(name);
  const exact = items.find((i) => normalize(key(i)) === q);
  if (exact) return exact;
  const partial = items.filter((i) => normalize(key(i)).includes(q) || q.includes(normalize(key(i))));
  return partial.length === 1 ? partial[0] : undefined;
}
