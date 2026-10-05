import type { FastifyInstance } from 'fastify';
import type { AgendaSync } from '../../agenda/agendaSync.js';
import type { CatalogRepository } from '../../catalog/catalogRepository.js';
import { coordinatorClinic } from '../clinicContext.js';

const DAYS = ['', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/** Agenda generada desde la base de conocimiento: ver lo detectado y regenerarla. */
export function agendaRoutes(sync: Pick<AgendaSync, 'status' | 'schedule'>, catalog: Pick<CatalogRepository, 'findClinicById' | 'findResourcesByClinic'>, defaultClinicId: string) {
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

    // Regenera en segundo plano; el panel consulta GET /agenda hasta que termine.
    app.post('/agenda/regenerate', async (req, reply) => {
      sync.schedule(coordinatorClinic(req, defaultClinicId));
      return reply.code(202).send({ status: 'generando' });
    });
  };
}
