-- Citas: lo único del dominio que vive en Postgres, porque es lo único que
-- necesita una garantía dura: un recurso (profesional, sala, equipo) no puede
-- tener dos citas confirmadas que se crucen en el tiempo.
--
-- El catálogo (clínicas, sedes, servicios, recursos, horarios) vive en MongoDB
-- porque su forma cambia por cliente. Por eso clinic_id, resource_id,
-- location_id y service_id son texto sin FK: el código valida que existan en
-- Mongo antes de insertar.
CREATE TABLE appointments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          text        NOT NULL,
  resource_id        text        NOT NULL,
  location_id        text,                       -- NULL si la clínica no tiene sedes
  service_id         text        NOT NULL,
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  patient_phone      text        NOT NULL,
  patient_name       text        NOT NULL,
  custom_fields      jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- campos propios de cada clínica (EPS, documento…)
  status             text        NOT NULL DEFAULT 'confirmada',
  source_message_id  text,                       -- mensaje de WhatsApp que originó la cita
  created_at         timestamptz NOT NULL DEFAULT now(),
  cancelled_at       timestamptz,

  CONSTRAINT appointments_status_chk CHECK (status IN ('confirmada', 'cancelada')),
  CONSTRAINT appointments_time_chk   CHECK (ends_at > starts_at),

  -- Ninguna pareja de citas confirmadas del mismo recurso puede solaparse.
  -- Rango semiabierto [inicio, fin): 10:00–10:30 y 10:30–11:00 no chocan.
  -- Funciona con duraciones distintas por servicio, no solo con la misma hora.
  -- Una cita cancelada sale de la restricción y libera el horario.
  CONSTRAINT appointments_no_overlap EXCLUDE USING gist (
    clinic_id   WITH =,
    resource_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'confirmada')
);

-- Disponibilidad: citas confirmadas de unos recursos en un rango de fechas.
CREATE INDEX appointments_availability_idx
  ON appointments (clinic_id, resource_id, starts_at)
  WHERE status = 'confirmada';

-- Citas de un paciente (consultas, cancelaciones).
CREATE INDEX appointments_patient_idx ON appointments (clinic_id, patient_phone, starts_at DESC);

-- Trazabilidad e idempotencia de reintentos: qué cita creó cada mensaje.
CREATE INDEX appointments_source_message_idx ON appointments (source_message_id) WHERE source_message_id IS NOT NULL;


-- Outbox: los eventos que deben reflejarse en MongoDB se escriben en la misma
-- transacción que el cambio en Postgres. Un proceso aparte los publica con
-- reintentos, así una caída de Mongo no deja las bases inconsistentes.
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  clinic_id     text        NOT NULL,
  event_type    text        NOT NULL,
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  attempts      int         NOT NULL DEFAULT 0,
  last_error    text
);

CREATE INDEX outbox_pending_idx ON outbox (id) WHERE processed_at IS NULL;
