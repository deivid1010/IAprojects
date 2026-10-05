import { DateTime } from 'luxon';
import { z } from 'zod';
import { BookingError, type AgendaProvider } from '../../agenda/AgendaProvider.js';
import { checkBookableDate, describeDate, resolveDate } from '../../agenda/dates.js';
import { SlotTakenError } from '../../appointments/appointmentsRepository.js';
import type { BookingField, Clinic } from '../../catalog/schemas.js';
import { formatSlot } from './consultarDisponibilidad.js';
import { invalidArgs } from './registry.js';
import { locationName, resolveLocation, resolveResource, resolveService } from './resolve.js';
import { fail, type Tool } from './types.js';

const ALTERNATIVES_SHOWN = 5;

const baseSchema = z.object({
  especialidad: z.string().trim().min(1),
  sede: z.string().trim().nullable().default(null),
  profesional: z.string().trim().min(1),
  fecha: z.string().trim().min(1),
  hora: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'usa el formato HH:mm de 24 horas, p. ej. 14:30'),
  nombre_paciente: z.string().trim().min(3, 'pide el nombre completo del paciente'),
  datos_adicionales: z.record(z.union([z.string(), z.number(), z.null()])).default({}),
});

export function agendarCitaTool(clinic: Clinic, agenda: AgendaProvider): Tool {
  const hasLocations = clinic.locations.length > 0;

  const properties: Record<string, unknown> = {
    especialidad: { type: 'string', description: 'Servicio o especialidad, tal como se usó en consultar_disponibilidad.' },
    profesional: { type: 'string', description: 'Nombre o id del profesional, tal como lo devolvió consultar_disponibilidad.' },
    fecha: { type: 'string', description: "'hoy', 'manana', 'pasado_manana' o YYYY-MM-DD." },
    hora: { type: 'string', description: 'Hora de inicio HH:mm (24 h), tal como la devolvió consultar_disponibilidad.' },
    nombre_paciente: { type: 'string', description: 'Nombre completo del paciente (si es un menor, el nombre del menor).' },
    // Los datos que pide cada clínica salen de su configuración (booking_fields):
    // el esquema que ve el modelo cambia por cliente sin cambiar el código.
    datos_adicionales: bookingFieldsSchema(clinic.booking_fields),
  };
  if (hasLocations) {
    properties.sede = { type: ['string', 'null'], description: 'Sede del horario elegido, tal como la devolvió consultar_disponibilidad.' };
  }

  return {
    name: 'agendar_cita',
    description:
      'Crea la cita en la agenda. Llámala solo cuando el paciente eligió un horario concreto de consultar_disponibilidad y confirmó los datos. Si responde error, la cita NO quedó creada.',
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },

    async execute(rawArgs, ctx) {
      const parsed = baseSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const args = parsed.data;

      const service = resolveService(clinic, args.especialidad);
      if (!service.ok) return service.outcome;
      const location = resolveLocation(clinic, args.sede);
      if (!location.ok) return location.outcome;
      if (hasLocations && !location.value) {
        return fail('sede_requerida', 'Indica en qué sede será la cita.', { sedes_disponibles: clinic.locations.map((l) => l.id) });
      }
      const resource = await resolveResource(agenda, clinic, service.value, args.profesional);
      if (!resource.ok) return resource.outcome;

      const date = resolveDate(args.fecha, ctx.message.timestamp, clinic.timezone);
      if (!date.ok) return fail('fecha_invalida', date.message);
      const problem = checkBookableDate(date.date, clinic, ctx.now);
      if (problem) return fail(problem.code, problem.message);

      const missing = validateBookingFields(clinic.booking_fields, args.datos_adicionales);
      if (missing.length) return fail('datos_faltantes', 'Faltan datos obligatorios del paciente: pídeselos antes de agendar.', { faltan: missing });

      try {
        const appointment = await agenda.book({
          clinic,
          serviceId: service.value.id,
          locationId: location.value?.id ?? null,
          resourceId: resource.value._id,
          date: date.date,
          time: args.hora,
          now: ctx.now,
          patientPhone: ctx.conversation.phone,
          patientName: args.nombre_paciente,
          customFields: cleanFields(args.datos_adicionales),
          sourceMessageId: ctx.message._id,
        });
        return {
          ok: true,
          data: {
            cita_id: appointment.id,
            estado: 'confirmada',
            especialidad: service.value.name,
            profesional: resource.value.name,
            sede: locationName(clinic, appointment.locationId),
            fecha: date.date,
            dia: describeDate(date.date, clinic.timezone),
            hora: DateTime.fromJSDate(appointment.startsAt).setZone(clinic.timezone).toFormat('HH:mm'),
            duracion_min: service.value.duration_min,
            paciente: appointment.patientName,
          },
          effects: { conversationStatus: 'cita_agendada' },
        };
      } catch (err) {
        if (!(err instanceof SlotTakenError) && !(err instanceof BookingError)) throw err;
        // Horario ocupado o inexistente: se devuelven alternativas reales del mismo día.
        const alternatives = await agenda.findAvailability({
          clinic,
          serviceId: service.value.id,
          locationId: location.value?.id ?? null,
          date: date.date,
          franja: null,
          now: ctx.now,
        });
        const code = err instanceof SlotTakenError ? 'horario_ocupado' : err.code;
        const message = err instanceof SlotTakenError ? 'Ese horario acaba de ser tomado por otro paciente.' : err.message;
        return fail(code, message, {
          alternativas_mismo_dia: alternatives.slice(0, ALTERNATIVES_SHOWN).map((s) => formatSlot(s, clinic)),
          sede: locationName(clinic, location.value?.id ?? null),
        });
      }
    },
  };
}

function bookingFieldsSchema(fields: BookingField[]) {
  const properties = Object.fromEntries(
    fields.map((f) => [
      f.key,
      {
        type: f.required ? (f.type === 'number' ? 'number' : 'string') : [f.type === 'number' ? 'number' : 'string', 'null'],
        description: `${f.label}${f.required ? ' (obligatorio)' : ' (opcional: null si el paciente no lo tiene)'}${f.type === 'date' ? ', formato YYYY-MM-DD' : ''}.`,
      },
    ]),
  );
  return { type: 'object', properties, required: fields.map((f) => f.key), additionalProperties: false };
}

function validateBookingFields(fields: BookingField[], values: Record<string, unknown>): string[] {
  return fields
    .filter((f) => f.required)
    .filter((f) => {
      const v = values[f.key];
      return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
    })
    .map((f) => f.label);
}

function cleanFields(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== ''));
}
