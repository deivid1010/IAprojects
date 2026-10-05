import { SlotTakenError, type Appointment, type NewAppointment } from '../../src/appointments/appointmentsRepository.js';
import type { AppointmentsRepository } from '../../src/appointments/appointmentsRepository.js';
import type { CatalogRepository } from '../../src/catalog/catalogRepository.js';
import { clinicSchema, resourceSchema, type Clinic, type Resource } from '../../src/catalog/schemas.js';
import { LocalAgendaProvider } from '../../src/agenda/localAgendaProvider.js';
import { clinic as seedClinic, resources as seedResources } from '../../src/seed/data.js';

/** Mensaje del enunciado: 2026-10-06T03:40Z = lunes 5 de octubre, 10:40 p. m. en Cali. */
export const PDF_MESSAGE_AT = new Date('2026-10-06T03:40:00Z');

export const testClinic: Clinic = clinicSchema.parse(seedClinic);
export const testResources: Resource[] = seedResources.map((r) => resourceSchema.parse(r));

/** Catálogo en memoria con la misma interfaz que CatalogRepository. */
export function fakeCatalog(resources: Resource[] = testResources) {
  return {
    async findResourcesForService(clinicId: string, serviceId: string, locationId?: string) {
      return resources.filter(
        (r) =>
          r.clinic_id === clinicId &&
          r.active &&
          r.service_ids.includes(serviceId) &&
          (!locationId || r.schedules.some((s) => s.location_id === locationId)),
      );
    },
    async findResourceById(clinicId: string, id: string) {
      return resources.find((r) => r.clinic_id === clinicId && r._id === id) ?? null;
    },
  } as unknown as CatalogRepository;
}

/** Citas en memoria que imitan la restricción EXCLUDE de Postgres. */
export class FakeAppointments {
  readonly rows: Appointment[] = [];

  async create(a: NewAppointment): Promise<Appointment> {
    const clash = this.rows.some(
      (r) => r.status === 'confirmada' && r.clinicId === a.clinicId && r.resourceId === a.resourceId && a.startsAt < r.endsAt && a.endsAt > r.startsAt,
    );
    if (clash) throw new SlotTakenError();
    const row: Appointment = {
      id: `appt-${this.rows.length + 1}`,
      clinicId: a.clinicId,
      resourceId: a.resourceId,
      locationId: a.locationId,
      serviceId: a.serviceId,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      patientPhone: a.patientPhone,
      patientName: a.patientName,
      customFields: a.customFields ?? {},
      status: 'confirmada',
      sourceMessageId: a.sourceMessageId ?? null,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async findConfirmedOverlapping(clinicId: string, resourceIds: string[], from: Date, to: Date) {
    return this.rows.filter((r) => r.clinicId === clinicId && resourceIds.includes(r.resourceId) && r.status === 'confirmada' && r.startsAt < to && r.endsAt > from);
  }

  async findBySourceMessage(clinicId: string, sourceMessageId: string) {
    return this.rows.filter((r) => r.clinicId === clinicId && r.sourceMessageId === sourceMessageId && r.status === 'confirmada');
  }
}

export function fakeAgenda(appointments = new FakeAppointments(), resources = testResources) {
  return { agenda: new LocalAgendaProvider(fakeCatalog(resources), appointments as unknown as AppointmentsRepository), appointments };
}
