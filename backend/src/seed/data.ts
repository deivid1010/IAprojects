import type { Clinic, Resource } from '../catalog/schemas.js';

// Clínica ficticia para la prueba. Los horarios de los recursos deben ser
// coherentes con lo que dicen los documentos de la base de conocimiento.
export const SEED_CLINIC_ID = 'clinica-vida-sana';

export const clinic: Clinic = {
  _id: SEED_CLINIC_ID,
  name: 'Clínica Vida Sana',
  whatsapp_number: '+576024440000',
  whatsapp_business_account_id: '102030405060708',
  timezone: 'America/Bogota',
  locations: [
    { id: 'sede-norte', name: 'Sede Norte', address: 'Avenida 6N # 28-15, Cali' },
    { id: 'sede-sur', name: 'Sede Sur', address: 'Carrera 100 # 16-20, Cali' },
  ],
  services: [
    { id: 'medicina-general', name: 'Medicina general', duration_min: 20, attributes: {} },
    {
      id: 'dermatologia',
      name: 'Dermatología',
      duration_min: 30,
      attributes: { requiere_orden_medica: false },
    },
    {
      id: 'pediatria',
      name: 'Pediatría',
      duration_min: 30,
      attributes: { edad_maxima_anios: 17 },
    },
  ],
  booking_fields: [
    { key: 'documento', label: 'Número de documento', type: 'string', required: true },
    { key: 'eps', label: 'EPS o medicina prepagada', type: 'string', required: false },
  ],
  rules: { min_lead_minutes: 60, booking_horizon_days: 14, cancel_policy_hours: 24 },
  // Festivos de Colombia en la ventana de agendamiento (no se atiende).
  holidays: ['2026-10-12', '2026-11-02', '2026-11-16', '2026-12-08', '2026-12-25'],
};

// weekday ISO: 1 = lunes … 6 = sábado
export const resources: Resource[] = [
  {
    _id: 'dra-laura-gomez',
    clinic_id: SEED_CLINIC_ID,
    name: 'Dra. Laura Gómez',
    type: 'professional',
    service_ids: ['medicina-general'],
    schedules: [1, 2, 3, 4, 5].map((weekday) => ({ location_id: 'sede-norte', weekday, start: '07:00', end: '12:00' })),
    exceptions: [],
    active: true,
  },
  {
    _id: 'dr-andres-rojas',
    clinic_id: SEED_CLINIC_ID,
    name: 'Dr. Andrés Rojas',
    type: 'professional',
    service_ids: ['medicina-general'],
    schedules: [
      ...[1, 2, 3, 4, 5].map((weekday) => ({ location_id: 'sede-sur', weekday, start: '13:00', end: '18:00' })),
      { location_id: 'sede-sur', weekday: 6, start: '08:00', end: '12:00' },
    ],
    exceptions: [],
    active: true,
  },
  {
    _id: 'dra-camila-restrepo',
    clinic_id: SEED_CLINIC_ID,
    name: 'Dra. Camila Restrepo',
    type: 'professional',
    service_ids: ['dermatologia'],
    schedules: [
      ...[1, 3, 5].map((weekday) => ({ location_id: 'sede-norte', weekday, start: '14:00', end: '18:00' })),
      ...[2, 4].map((weekday) => ({ location_id: 'sede-sur', weekday, start: '08:00', end: '12:00' })),
    ],
    exceptions: [],
    active: true,
  },
  {
    _id: 'dr-felipe-martinez',
    clinic_id: SEED_CLINIC_ID,
    name: 'Dr. Felipe Martínez',
    type: 'professional',
    service_ids: ['dermatologia'],
    schedules: [2, 4].map((weekday) => ({ location_id: 'sede-norte', weekday, start: '14:00', end: '18:00' })),
    exceptions: [],
    active: true,
  },
  {
    _id: 'dra-natalia-herrera',
    clinic_id: SEED_CLINIC_ID,
    name: 'Dra. Natalia Herrera',
    type: 'professional',
    service_ids: ['pediatria'],
    schedules: [1, 2, 3, 4, 5].map((weekday) => ({ location_id: 'sede-norte', weekday, start: '08:00', end: '12:00' })),
    exceptions: [],
    active: true,
  },
  {
    _id: 'dr-julian-castro',
    clinic_id: SEED_CLINIC_ID,
    name: 'Dr. Julián Castro',
    type: 'professional',
    service_ids: ['pediatria'],
    schedules: [1, 2, 3, 4, 5].map((weekday) => ({ location_id: 'sede-sur', weekday, start: '14:00', end: '18:00' })),
    exceptions: [],
    active: true,
  },
];
