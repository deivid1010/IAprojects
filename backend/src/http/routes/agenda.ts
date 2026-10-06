import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AgendaSync } from '../../agenda/agendaSync.js';
import { buildCalendar } from '../../agenda/calendar.js';
import type { AppointmentsRepository } from '../../appointments/appointmentsRepository.js';
import type { CatalogRepository } from '../../catalog/catalogRepository.js';
import { coordinatorClinic } from '../clinicContext.js';

const DAYS = ['', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

// Un mes visto en semanas completas son hasta 42 días.
const MAX_CALENDAR_DAYS = 62;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato YYYY-MM-DD');
const calendarQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: 'from debe ser anterior o igual a to' })
  .refine((q) => DateTime.fromISO(q.to).diff(DateTime.fromISO(q.from), 'days').days < MAX_CALENDAR_DAYS, {
    message: `el rango no puede superar ${MAX_CALENDAR_DAYS} días`,
  });

export interface AgendaRouteDeps {
  sync: Pick<AgendaSync, 'status' | 'schedule'>;
  catalog: Pick<CatalogRepository, 'findClinicById' | 'findResourcesByClinic'>;
  appointments: Pick<AppointmentsRepository, 'findConfirmedOverlapping'>;
  now?: () => Date;
}

/** Agenda generada desde la base de conocimiento: ver lo detectado, regenerarla y el calendario de citas. */
export function agendaRoutes({ sync, catalog, appointments, now = () => new Date() }: AgendaRouteDeps, defaultClinicId: string) {
  return async (app: FastifyInstance) => {
    app.get('/agenda', async (req, reply) => {
      const clinicId = coordinatorClinic(req, defaultClinicId);
      const clinic = await catalog.findClinicById(clinicId);
      if (!clinic) return reply.code(404).send({ error: 'not_found', message: 'Clínica no encontrada' });
      const resources = await catalog.findResourcesByClinic(clinicId);
      const locationName = (id?: string) => clinic.locations.find((l) => l.id === id)?.name ?? '—';
      return {
        meta: await sync.status(clinicId),
        locations: clinic.locations,
        services: clinic.services.map((s) => ({ id: s.id, name: s.name, duration_min: s.duration_min })),
        professionals: resources.map((r) => ({
          id: r._id,
          name: r.name,
          services: r.service_ids.map((id) => clinic.services.find((s) => s.id === id)?.name ?? id),
          schedules: r.schedules.map((b) => ({ location: locationName(b.location_id), day: DAYS[b.weekday], start: b.start, end: b.end })),
        })),
      };
    });

    // Calendario: citas confirmadas y tramos libres por día y profesional, en hora de la clínica.
    app.get('/agenda/calendar', async (req, reply) => {
      const query = calendarQuerySchema.safeParse(req.query);
      if (!query.success) {
        const message = query.error.issues.map((i) => `${i.path.join('.') || 'parámetro'}: ${i.message}`).join('; ');
        return reply.code(400).send({ error: 'invalid_request', message });
      }
      const clinicId = coordinatorClinic(req, defaultClinicId);
      const clinic = await catalog.findClinicById(clinicId);
      if (!clinic) return reply.code(404).send({ error: 'not_found', message: 'Clínica no encontrada' });

      const { from, to } = query.data;
      const resources = await catalog.findResourcesByClinic(clinicId);
      const start = DateTime.fromISO(from, { zone: clinic.timezone }).startOf('day');
      const end = DateTime.fromISO(to, { zone: clinic.timezone }).startOf('day').plus({ days: 1 });
      const booked = await appointments.findConfirmedOverlapping(
        clinicId,
        resources.map((r) => r._id),
        start.toJSDate(),
        end.toJSDate(),
      );
      return {
        timezone: clinic.timezone,
        today: DateTime.fromJSDate(now()).setZone(clinic.timezone).toISODate(),
        days: buildCalendar({ clinic, resources, appointments: booked, from, to, now: now() }),
      };
    });

    // Regenera en segundo plano; el panel consulta GET /agenda hasta que termine.
    app.post('/agenda/regenerate', async (req, reply) => {
      sync.schedule(coordinatorClinic(req, defaultClinicId));
      return reply.code(202).send({ status: 'generando' });
    });
  };
}
