import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AgendaProvider } from '../../agenda/AgendaProvider.js';
import type { Slot } from '../../agenda/availability.js';
import { checkBookableDate, describeDate, resolveDate } from '../../agenda/dates.js';
import type { Clinic } from '../../catalog/schemas.js';
import { invalidArgs } from './registry.js';
import { locationName, resolveLocation, resolveService } from './resolve.js';
import { fail, type Tool } from './types.js';

const MAX_SLOTS_SHOWN = 12;
const DAYS_TO_SUGGEST = 3;

const argsSchema = z.object({
  especialidad: z.string().trim().min(1),
  sede: z.string().trim().nullable().default(null),
  fecha: z.string().trim().min(1),
  franja: z.enum(['manana', 'tarde']).nullable().default(null),
});

export function consultarDisponibilidadTool(clinic: Clinic, agenda: AgendaProvider): Tool {
  const hasLocations = clinic.locations.length > 0;

  // El esquema se arma con la configuración de la clínica: si no tiene sedes,
  // el parámetro "sede" no existe para el modelo.
  const properties: Record<string, unknown> = {
    especialidad: {
      type: 'string',
      description: "Servicio o especialidad tal como lo pide el paciente (por ejemplo 'dermatología'). Si no existe, la herramienta devuelve las opciones válidas para corregir.",
    },
    fecha: {
      type: 'string',
      description:
        "Día a consultar. Para fechas relativas usa exactamente 'hoy', 'manana' o 'pasado_manana' (el sistema las resuelve en hora de la clínica). Para otras fechas usa YYYY-MM-DD.",
    },
    franja: {
      type: ['string', 'null'],
      enum: ['manana', 'tarde', null],
      description: "'manana' (antes de las 12:00), 'tarde' (desde las 12:00) o null si al paciente le sirve cualquier hora.",
    },
  };
  if (hasLocations) {
    properties.sede = {
      type: ['string', 'null'],
      description: "Sede que pidió el paciente, o null para consultar todas. Si el paciente quiere atención virtual, usa 'Teleconsulta'.",
    };
  }

  return {
    name: 'consultar_disponibilidad',
    description:
      'Consulta los horarios libres reales de un servicio en un día. Úsala siempre antes de ofrecer horarios: nunca ofrezcas un horario que no venga de esta herramienta.',
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },

    async execute(rawArgs, ctx) {
      const parsed = argsSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const args = parsed.data;

      const service = resolveService(clinic, args.especialidad);
      if (!service.ok) return service.outcome;
      const location = resolveLocation(clinic, args.sede);
      if (!location.ok) return location.outcome;

      const date = resolveDate(args.fecha, ctx.message.timestamp, clinic.timezone);
      if (!date.ok) return fail('fecha_invalida', date.message);
      const problem = checkBookableDate(date.date, clinic, ctx.now);
      if (problem) return fail(problem.code, problem.message);

      const query = { clinic, serviceId: service.value.id, locationId: location.value?.id ?? null, franja: args.franja, now: ctx.now };
      const slots = await agenda.findAvailability({ ...query, date: date.date });

      const result: Record<string, unknown> = {
        fecha: date.date,
        dia: describeDate(date.date, clinic.timezone),
        especialidad: service.value.name,
        duracion_min: service.value.duration_min,
        sede: location.value?.name ?? 'todas',
        franja: args.franja ?? 'cualquiera',
        total_horarios: slots.length,
        horarios: slots.slice(0, MAX_SLOTS_SHOWN).map((s) => formatSlot(s, clinic)),
      };
      if (slots.length > 0) {
        // Rango completo: evita que el modelo presente la lista recortada como si fuera todo.
        result.primer_horario = formatSlot(slots[0]!, clinic).hora;
        result.ultimo_horario = formatSlot(slots.at(-1)!, clinic).hora;
      }
      if (slots.length > MAX_SLOTS_SHOWN) {
        result.nota = `Hay ${slots.length} horarios libres entre ${result.primer_horario} y ${result.ultimo_horario}; aquí se listan solo los primeros ${MAX_SLOTS_SHOWN}. No digas que los listados son todos.`;
      }

      // Sin cupos: se buscan los próximos días con disponibilidad para que el
      // modelo ofrezca alternativas reales en vez de inventarlas.
      if (slots.length === 0) result.proximas_fechas_con_disponibilidad = await nextAvailableDates(agenda, clinic, query, date.date);

      return { ok: true, data: result };
    },
  };
}

export function formatSlot(slot: Slot, clinic: Clinic) {
  return {
    hora: DateTime.fromJSDate(slot.start).setZone(clinic.timezone).toFormat('HH:mm'),
    profesional: slot.resourceName,
    profesional_id: slot.resourceId,
    sede: locationName(clinic, slot.locationId),
    sede_id: slot.locationId,
  };
}

async function nextAvailableDates(
  agenda: AgendaProvider,
  clinic: Clinic,
  query: Omit<Parameters<AgendaProvider['findAvailability']>[0], 'date'>,
  fromDate: string,
): Promise<{ fecha: string; dia: string; horarios_libres: number }[]> {
  const found: { fecha: string; dia: string; horarios_libres: number }[] = [];
  let day = DateTime.fromISO(fromDate, { zone: clinic.timezone });
  for (let i = 0; i < clinic.rules.booking_horizon_days && found.length < DAYS_TO_SUGGEST; i++) {
    day = day.plus({ days: 1 });
    const date = day.toISODate()!;
    if (checkBookableDate(date, clinic, query.now)) continue;
    const slots = await agenda.findAvailability({ ...query, date });
    if (slots.length > 0) found.push({ fecha: date, dia: describeDate(date, clinic.timezone), horarios_libres: slots.length });
  }
  return found;
}
