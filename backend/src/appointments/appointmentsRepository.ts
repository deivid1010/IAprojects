import type { PgPool } from '../db/postgres.js';

export interface NewAppointment {
  clinicId: string;
  resourceId: string;
  locationId: string | null;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  patientPhone: string;
  patientName: string;
  customFields?: Record<string, unknown>;
  sourceMessageId?: string | null;
}

export interface Appointment {
  id: string;
  clinicId: string;
  resourceId: string;
  locationId: string | null;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  patientPhone: string;
  patientName: string;
  customFields: Record<string, unknown>;
  status: 'confirmada' | 'cancelada';
  sourceMessageId: string | null;
  createdAt: Date;
}

/** El horario ya está tomado: lo dice la base, no una verificación previa del código. */
export class SlotTakenError extends Error {
  constructor() {
    super('El horario ya no está disponible');
    this.name = 'SlotTakenError';
  }
}

// Código de Postgres para violación de una restricción EXCLUDE.
const EXCLUSION_VIOLATION = '23P01';

const COLUMNS = `
  id, clinic_id, resource_id, location_id, service_id, starts_at, ends_at,
  patient_phone, patient_name, custom_fields, status, source_message_id, created_at`;

export class AppointmentsRepository {
  constructor(private readonly pool: PgPool) {}

  /**
   * Inserta la cita y el evento de outbox en la misma transacción.
   * Si otro paciente tomó un horario que se cruza, aunque sea en el mismo
   * milisegundo, la restricción EXCLUDE rechaza la inserción y se lanza
   * SlotTakenError.
   */
  async create(input: NewAppointment): Promise<Appointment> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO appointments
           (clinic_id, resource_id, location_id, service_id, starts_at, ends_at,
            patient_phone, patient_name, custom_fields, source_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${COLUMNS}`,
        [
          input.clinicId,
          input.resourceId,
          input.locationId,
          input.serviceId,
          input.startsAt,
          input.endsAt,
          input.patientPhone,
          input.patientName,
          input.customFields ?? {},
          input.sourceMessageId ?? null,
        ],
      );
      const appointment = toAppointment(rows[0]);
      await client.query(`INSERT INTO outbox (clinic_id, event_type, payload) VALUES ($1, 'appointment.created', $2)`, [
        appointment.clinicId,
        { appointment_id: appointment.id, patient_phone: appointment.patientPhone, source_message_id: appointment.sourceMessageId },
      ]);
      await client.query('COMMIT');
      return appointment;
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { code?: string }).code === EXCLUSION_VIOLATION) throw new SlotTakenError();
      throw err;
    } finally {
      client.release();
    }
  }

  async cancel(clinicId: string, appointmentId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE appointments SET status = 'cancelada', cancelled_at = now()
         WHERE id = $1 AND clinic_id = $2 AND status = 'confirmada'`,
        [appointmentId, clinicId],
      );
      if (rowCount === 1) {
        await client.query(`INSERT INTO outbox (clinic_id, event_type, payload) VALUES ($1, 'appointment.cancelled', $2)`, [
          clinicId,
          { appointment_id: appointmentId },
        ]);
      }
      await client.query('COMMIT');
      return rowCount === 1;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Citas confirmadas creadas por un mensaje (idempotencia ante reintentos del mismo turno). */
  async findBySourceMessage(clinicId: string, sourceMessageId: string): Promise<Appointment[]> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM appointments
       WHERE clinic_id = $1 AND source_message_id = $2 AND status = 'confirmada'`,
      [clinicId, sourceMessageId],
    );
    return rows.map(toAppointment);
  }

  /** Citas confirmadas de unos recursos que se cruzan con [from, to). Base del cálculo de disponibilidad. */
  async findConfirmedOverlapping(clinicId: string, resourceIds: string[], from: Date, to: Date): Promise<Appointment[]> {
    if (resourceIds.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM appointments
       WHERE clinic_id = $1 AND resource_id = ANY($2) AND status = 'confirmada'
         AND starts_at < $4 AND ends_at > $3
       ORDER BY starts_at`,
      [clinicId, resourceIds, from, to],
    );
    return rows.map(toAppointment);
  }
}

function toAppointment(row: Record<string, unknown>): Appointment {
  return {
    id: row.id as string,
    clinicId: row.clinic_id as string,
    resourceId: row.resource_id as string,
    locationId: (row.location_id as string | null) ?? null,
    serviceId: row.service_id as string,
    startsAt: row.starts_at as Date,
    endsAt: row.ends_at as Date,
    patientPhone: row.patient_phone as string,
    patientName: row.patient_name as string,
    customFields: (row.custom_fields as Record<string, unknown>) ?? {},
    status: row.status as Appointment['status'],
    sourceMessageId: (row.source_message_id as string | null) ?? null,
    createdAt: row.created_at as Date,
  };
}
