import { DateTime } from 'luxon';
import type { Appointment, AppointmentsRepository } from '../appointments/appointmentsRepository.js';
import type { CatalogRepository } from '../catalog/catalogRepository.js';
import type { Resource } from '../catalog/schemas.js';
import { BookingError, type AgendaProvider, type AvailabilityQuery, type BookingRequest } from './AgendaProvider.js';
import { computeSlots, type Slot } from './availability.js';

/** Agenda propia: catálogo y horarios en MongoDB, citas en PostgreSQL. */
export class LocalAgendaProvider implements AgendaProvider {
  constructor(
    private readonly catalog: CatalogRepository,
    private readonly appointments: AppointmentsRepository,
  ) {}

  listResources(clinicId: string, serviceId: string): Promise<Resource[]> {
    return this.catalog.findResourcesForService(clinicId, serviceId);
  }

  async findAvailability(q: AvailabilityQuery): Promise<Slot[]> {
    const service = q.clinic.services.find((s) => s.id === q.serviceId);
    if (!service) return [];
    const resources = await this.catalog.findResourcesForService(q.clinic._id, q.serviceId, q.locationId ?? undefined);

    const day = DateTime.fromISO(q.date, { zone: q.clinic.timezone });
    const busy = await this.appointments.findConfirmedOverlapping(
      q.clinic._id,
      resources.map((r) => r._id),
      day.startOf('day').toJSDate(),
      day.endOf('day').toJSDate(),
    );

    return computeSlots({
      clinic: q.clinic,
      service,
      resources,
      date: q.date,
      locationId: q.locationId,
      franja: q.franja,
      now: q.now,
      busy: busy.map((a) => ({ resourceId: a.resourceId, start: a.startsAt, end: a.endsAt })),
    });
  }

  async book(req: BookingRequest): Promise<Appointment> {
    const service = req.clinic.services.find((s) => s.id === req.serviceId);
    const resource = await this.catalog.findResourceById(req.clinic._id, req.resourceId);
    if (!service || !resource || !resource.active || !resource.service_ids.includes(req.serviceId)) {
      throw new BookingError('profesional_invalido', 'El profesional no existe o no presta ese servicio.');
    }

    // ¿El horario pedido existe en la agenda del recurso? Se recalcula sin
    // considerar citas: la ocupación la decide la restricción EXCLUDE al insertar.
    const start = DateTime.fromISO(`${req.date}T${req.time}`, { zone: req.clinic.timezone });
    const grid = computeSlots({
      clinic: req.clinic,
      service,
      resources: [resource],
      date: req.date,
      locationId: req.locationId,
      now: req.now,
      busy: [],
    });
    const slot = grid.find((s) => s.start.getTime() === start.toMillis());
    if (!slot) {
      throw new BookingError(
        'horario_fuera_de_agenda',
        `${resource.name} no tiene un horario que empiece a las ${req.time} el ${req.date} en esa sede (o ya no cumple la anticipación mínima).`,
      );
    }

    // Reintento del mismo turno (p. ej. el worker se cayó después de agendar):
    // se devuelve la cita existente en vez de chocar consigo misma.
    const previous = await this.appointments.findBySourceMessage(req.clinic._id, req.sourceMessageId);
    const same = previous.find((a) => a.resourceId === resource._id && a.startsAt.getTime() === slot.start.getTime());
    if (same) return same;

    return this.appointments.create({
      clinicId: req.clinic._id,
      resourceId: resource._id,
      locationId: slot.locationId,
      serviceId: service.id,
      startsAt: slot.start,
      endsAt: slot.end,
      patientPhone: req.patientPhone,
      patientName: req.patientName,
      customFields: req.customFields,
      sourceMessageId: req.sourceMessageId,
    });
  }
}
