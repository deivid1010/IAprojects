import type { AgendaProvider } from '../../agenda/AgendaProvider.js';
import { matchOne } from '../../agenda/matching.js';
import type { Clinic, Location, Resource, Service } from '../../catalog/schemas.js';
import { fail, type ToolOutcome } from './types.js';

// Resolución de referencias del modelo a entidades reales de la clínica.
// Si no existen, el error lista las opciones válidas.

type Resolved<T> = { ok: true; value: T } | { ok: false; outcome: ToolOutcome };

export function resolveService(clinic: Clinic, query: string): Resolved<Service> {
  const m = matchOne(clinic.services, query, (s) => [s.id, s.name]);
  if (m.ok) return { ok: true, value: m.item };
  return {
    ok: false,
    outcome: fail('especialidad_inexistente', `La clínica no ofrece "${query}".`, {
      especialidades_disponibles: clinic.services.map((s) => ({ id: s.id, nombre: s.name })),
    }),
  };
}

/** Sede opcional: null si la clínica no tiene sedes o el paciente no indicó una. */
export function resolveLocation(clinic: Clinic, query: string | null): Resolved<Location | null> {
  if (clinic.locations.length === 0 || query === null || query.trim() === '') return { ok: true, value: null };
  const m = matchOne(clinic.locations, query, (l) => [l.id, l.name]);
  if (m.ok) return { ok: true, value: m.item };
  return {
    ok: false,
    outcome: fail('sede_inexistente', `No existe la sede "${query}".`, {
      sedes_disponibles: clinic.locations.map((l) => ({ id: l.id, nombre: l.name })),
    }),
  };
}

export async function resolveResource(agenda: AgendaProvider, clinic: Clinic, service: Service, query: string): Promise<Resolved<Resource>> {
  const resources = await agenda.listResources(clinic._id, service.id);
  const m = matchOne(resources, query, (r) => [r._id, r.name]);
  if (m.ok) return { ok: true, value: m.item };
  const options = (m.reason === 'ambiguo' ? m.candidates : resources).map((r) => ({ id: r._id, nombre: r.name }));
  return {
    ok: false,
    outcome: fail(
      m.reason === 'ambiguo' ? 'profesional_ambiguo' : 'profesional_inexistente',
      m.reason === 'ambiguo' ? `"${query}" coincide con varios profesionales.` : `No hay un profesional "${query}" para ${service.name}.`,
      { profesionales: options },
    ),
  };
}

export function locationName(clinic: Clinic, locationId: string | null): string | null {
  return clinic.locations.find((l) => l.id === locationId)?.name ?? null;
}
