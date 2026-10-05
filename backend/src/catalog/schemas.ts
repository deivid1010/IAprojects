import { z } from 'zod';

// Catálogo flexible por clínica. Lo mínimo es fijo (id, nombre, zona horaria);
// sedes, servicios, campos de agendamiento y reglas varían por cliente.

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'usa minúsculas, números y guiones');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'formato HH:mm');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato YYYY-MM-DD');

export const locationSchema = z.object({
  id,
  name: z.string().min(1),
  address: z.string().optional(),
});

export const serviceSchema = z.object({
  id,
  name: z.string().min(1),
  duration_min: z.number().int().min(5).max(480),
  // Atributos propios del servicio en cada clínica (preparación, requisitos…).
  attributes: z.record(z.unknown()).default({}),
});

export const bookingFieldSchema = z.object({
  key: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  label: z.string().min(1),
  type: z.enum(['string', 'number', 'date']),
  required: z.boolean().default(false),
});

export const clinicRulesSchema = z.object({
  min_lead_minutes: z.number().int().min(0).default(60),
  booking_horizon_days: z.number().int().min(1).max(90).default(14),
  cancel_policy_hours: z.number().int().min(0).default(24),
});

export const clinicSchema = z
  .object({
    _id: id,
    name: z.string().min(1),
    whatsapp_number: z.string().regex(/^\+\d{8,15}$/, 'formato E.164'),
    // WhatsApp Business Account ID: identifica a qué clínica va cada mensaje
    // entrante (en el webhook real de Meta llega en entry[].id).
    whatsapp_business_account_id: z.string().regex(/^\d+$/).optional(),
    timezone: z.string().min(1),
    locations: z.array(locationSchema).default([]),
    // Puede quedar vacía: si la base de conocimiento no describe una agenda, el
    // asistente funciona sin agendamiento.
    services: z.array(serviceSchema).default([]),
    booking_fields: z.array(bookingFieldSchema).default([]),
    rules: clinicRulesSchema.default({}),
    holidays: z.array(isoDate).default([]),
  })
  .superRefine((c, ctx) => {
    unique(c.locations.map((l) => l.id), 'locations', ctx);
    unique(c.services.map((s) => s.id), 'services', ctx);
    unique(c.booking_fields.map((f) => f.key), 'booking_fields', ctx);
  });

export const scheduleBlockSchema = z
  .object({
    location_id: id.optional(), // ausente si la clínica no tiene sedes
    weekday: z.number().int().min(1).max(7), // ISO: 1 = lunes … 7 = domingo
    start: hhmm,
    end: hhmm,
  })
  .refine((b) => b.start < b.end, { message: 'start debe ser anterior a end' });

export const resourceSchema = z.object({
  _id: id,
  clinic_id: id,
  name: z.string().min(1),
  type: z.enum(['professional', 'room', 'equipment']),
  service_ids: z.array(id).min(1),
  schedules: z.array(scheduleBlockSchema).min(1),
  exceptions: z.array(z.object({ date: isoDate, reason: z.string().optional() })).default([]),
  active: z.boolean().default(true),
});

export const knowledgeDocumentSchema = z.object({
  clinic_id: id,
  slug: id,
  title: z.string().min(1),
  content: z.string().min(1),
  /** Nombre del archivo subido, si vino de un archivo. */
  source_filename: z.string().optional(),
  /** Formato original: el contenido guardado es siempre el texto extraído. */
  source_format: z.enum(['markdown', 'texto', 'pdf', 'word']).optional(),
  updated_at: z.date().optional(),
});

export type Location = z.infer<typeof locationSchema>;
export type Service = z.infer<typeof serviceSchema>;
export type BookingField = z.infer<typeof bookingFieldSchema>;
export type Clinic = z.infer<typeof clinicSchema>;
export type ScheduleBlock = z.infer<typeof scheduleBlockSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

/**
 * Valida que un recurso sea coherente con su clínica: los servicios y sedes que
 * referencia existen. Es la integridad referencial que Mongo no da por sí solo.
 */
export function validateResourceAgainstClinic(resource: Resource, clinic: Clinic): string[] {
  const errors: string[] = [];
  if (resource.clinic_id !== clinic._id) errors.push(`clinic_id ${resource.clinic_id} no coincide con ${clinic._id}`);

  const serviceIds = new Set(clinic.services.map((s) => s.id));
  for (const sid of resource.service_ids) {
    if (!serviceIds.has(sid)) errors.push(`servicio inexistente: ${sid}`);
  }

  const locationIds = new Set(clinic.locations.map((l) => l.id));
  for (const block of resource.schedules) {
    if (clinic.locations.length > 0 && !block.location_id) {
      errors.push('la clínica tiene sedes: cada bloque de horario debe indicar location_id');
    } else if (block.location_id && !locationIds.has(block.location_id)) {
      errors.push(`sede inexistente: ${block.location_id}`);
    }
  }
  return errors;
}

function unique(values: string[], path: string, ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `id duplicado: ${v}` });
    seen.add(v);
  }
}
