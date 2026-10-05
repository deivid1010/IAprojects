import type { Appointment } from '../appointments/appointmentsRepository.js';
import type { Clinic, Resource } from '../catalog/schemas.js';
import type { Franja, Slot } from './availability.js';

export interface AvailabilityQuery {
  clinic: Clinic;
  serviceId: string;
  locationId: string | null;
  /** Fecha local de la clínica, YYYY-MM-DD. */
  date: string;
  franja: Franja | null;
  now: Date;
}

export interface BookingRequest {
  clinic: Clinic;
  serviceId: string;
  locationId: string | null;
  resourceId: string;
  date: string;
  /** HH:mm en hora de la clínica. */
  time: string;
  now: Date;
  patientPhone: string;
  patientName: string;
  customFields: Record<string, unknown>;
  sourceMessageId: string;
}

export type BookingErrorCode = 'profesional_invalido' | 'horario_fuera_de_agenda';

export class BookingError extends Error {
  constructor(
    readonly code: BookingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BookingError';
  }
}

/**
 * Agenda de una clínica. Las tools del asistente solo conocen esta interfaz.
 * Hoy la implementa LocalAgendaProvider (Mongo + Postgres); en producción cada
 * cliente podría tener un adaptador hacia su propio sistema de agenda.
 */
export interface AgendaProvider {
  /** Recursos activos que prestan un servicio (para resolver "la Dra. Camila"). */
  listResources(clinicId: string, serviceId: string): Promise<Resource[]>;
  findAvailability(q: AvailabilityQuery): Promise<Slot[]>;
  /**
   * Crea la cita. Lanza BookingError si el horario no existe en la agenda del
   * recurso y SlotTakenError si otro paciente lo tomó.
   */
  book(req: BookingRequest): Promise<Appointment>;
}
