import { describe, expect, it } from 'vitest';
import { buildAgenda, type ExtractedAgenda } from '../../src/agenda/extraction/buildAgenda.js';

// Texto con la forma del documento real: tablas aplanadas y horarios sin hora por profesional.
const DOC = `1.1 Sedes
Sede Norte – Granada
Sede Sur – Ciudad Jardín
Dirección Avenida 9N # 15-40 / Calle 16 # 105-30
Lunes a viernes 6:30 a. m. – 7:00 p. m. / 7:00 a. m. – 6:00 p. m.
1.2 Profesionales
Dr. Carlos Mejía · Medicina general · Norte: lunes a viernes · Teleconsulta martes y jueves 5:00 – 7:00 p. m.
Dra. Valentina Rojas · Medicina general · Sur: lunes a viernes
Nut. Daniela Castro · Nutrición · Norte y Sur (rota según agenda)
2. Servicios
Consulta de medicina general 20 min
Consulta de nutrición 45 min
Electrocardiograma 15 min`;

const base: ExtractedAgenda = {
  locations: [
    { name: 'Sede Norte – Granada', address: 'Avenida 9N # 15-40', hours: [{ days: [1, 2, 3, 4, 5], start: '06:30', end: '19:00' }] },
    { name: 'Sede Sur – Ciudad Jardín', address: 'Calle 16 # 105-30', hours: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '18:00' }] },
    { name: 'Teleconsulta', address: null, hours: [] },
  ],
  services: [
    { name: 'Consulta de medicina general', duration_min: 20 },
    { name: 'Consulta de nutrición', duration_min: 45 },
    { name: 'Electrocardiograma', duration_min: 15 },
  ],
  professionals: [
    {
      name: 'Dr. Carlos Mejía',
      services: ['Consulta de medicina general'],
      schedules: [
        { location: 'Sede Norte – Granada', days: [1, 2, 3, 4, 5], start: null, end: null },
        { location: 'Teleconsulta', days: [2, 4], start: '17:00', end: '19:00' },
      ],
    },
    { name: 'Dra. Valentina Rojas', services: ['Consulta de medicina general'], schedules: [{ location: 'Sede Sur – Ciudad Jardín', days: [1, 2, 3, 4, 5], start: null, end: null }] },
  ],
  notes: ['Nut. Daniela Castro rota según agenda'],
};

describe('buildAgenda: agenda desde el documento, validada por el código', () => {
  it('arma sedes, servicios y profesionales con ids estables', () => {
    const a = buildAgenda(base, DOC);
    expect(a.locations.map((l) => l.id)).toEqual(['sede-norte-granada', 'sede-sur-ciudad-jardin', 'teleconsulta']);
    expect(a.services.map((s) => [s.id, s.duration_min])).toEqual([['consulta-de-medicina-general', 20]]);
    expect(a.resources.map((r) => r._id)).toEqual(['dr-carlos-mejia', 'dra-valentina-rojas']);
  });

  it('sin hora en el documento usa el horario de la sede y lo advierte', () => {
    const a = buildAgenda(base, DOC);
    const valentina = a.resources.find((r) => r._id === 'dra-valentina-rojas')!;
    expect(valentina.schedules).toHaveLength(5);
    expect(valentina.schedules[0]).toEqual({ location_id: 'sede-sur-ciudad-jardin', weekday: 1, start: '07:00', end: '18:00' });
    expect(a.warnings.some((w) => w.includes('Dra. Valentina Rojas') && w.includes('horario de la sede'))).toBe(true);
  });

  it('la teleconsulta queda como sede virtual con sus horas propias', () => {
    const carlos = buildAgenda(base, DOC).resources.find((r) => r._id === 'dr-carlos-mejia')!;
    expect(carlos.schedules.filter((s) => s.location_id === 'teleconsulta')).toEqual([
      { location_id: 'teleconsulta', weekday: 2, start: '17:00', end: '19:00' },
      { location_id: 'teleconsulta', weekday: 4, start: '17:00', end: '19:00' },
    ]);
  });

  it('descarta profesionales, servicios y sedes que no aparecen en el documento (alucinaciones)', () => {
    const a = buildAgenda(
      {
        ...base,
        locations: [...base.locations, { name: 'Sede Oeste', address: null, hours: [] }],
        services: [...base.services, { name: 'Cardiología', duration_min: 30 }],
        professionals: [...base.professionals, { name: 'Dr. Andrés Rojas', services: ['Consulta de medicina general'], schedules: [{ location: 'Sede Sur – Ciudad Jardín', days: [1], start: '13:00', end: '18:00' }] }],
      },
      DOC,
    );
    expect(a.resources.map((r) => r.name)).not.toContain('Dr. Andrés Rojas');
    expect(a.discarded).toEqual(
      expect.arrayContaining([
        'Sede "Sede Oeste": no aparece en el documento.',
        'Servicio "Cardiología": no aparece en el documento.',
        'Profesional "Dr. Andrés Rojas": no aparece en el documento.',
      ]),
    );
  });

  it('descarta profesionales sin servicios válidos o sin ningún horario', () => {
    const a = buildAgenda(
      {
        ...base,
        professionals: [
          { name: 'Nut. Daniela Castro', services: ['Consulta de nutrición'], schedules: [] },
          { name: 'Dra. Valentina Rojas', services: ['Pediatría'], schedules: base.professionals[1]!.schedules },
        ],
      },
      DOC,
    );
    expect(a.resources).toEqual([]);
    expect(a.discarded).toEqual(expect.arrayContaining(['Profesional "Nut. Daniela Castro": no quedó ningún horario válido.']));
    expect(a.discarded.some((d) => d.includes('Dra. Valentina Rojas') && d.includes('servicios'))).toBe(true);
  });

  it('servicios sin profesional no se pueden agendar y se advierte', () => {
    const a = buildAgenda(base, DOC);
    expect(a.services.map((s) => s.name)).not.toContain('Electrocardiograma');
    expect(a.warnings).toContain('Servicio "Electrocardiograma": ningún profesional lo presta; no se puede agendar.');
  });

  it('un documento sin agenda produce una agenda vacía', () => {
    expect(buildAgenda({ locations: [], services: [], professionals: [], notes: [] }, 'Guion de telemercadeo').resources).toEqual([]);
  });
});

describe('buildAgenda: teleconsulta sin sede declarada', () => {
  it('crea la sede virtual cuando un horario la usa aunque el extractor no la haya listado', () => {
    const a = buildAgenda({ ...base, locations: base.locations.filter((l) => l.name !== 'Teleconsulta') }, DOC);
    expect(a.locations.map((l) => l.id)).toContain('teleconsulta');
    expect(a.resources.find((r) => r._id === 'dr-carlos-mejia')!.schedules.some((s) => s.location_id === 'teleconsulta')).toBe(true);
  });

  it('agrupa las advertencias por profesional y sede', () => {
    const a = buildAgenda(base, DOC);
    expect(a.warnings.filter((w) => w.includes('Dra. Valentina Rojas'))).toEqual([
      '"Dra. Valentina Rojas" (Sede Sur – Ciudad Jardín, lunes, martes, miércoles, jueves, viernes): el documento no da la hora; se usa el horario de la sede.',
    ]);
  });
});

describe('buildAgenda: la teleconsulta no es un servicio', () => {
  it('descarta un "servicio" de teleconsulta y lo quita de los profesionales', () => {
    const a = buildAgenda(
      {
        ...base,
        services: [...base.services, { name: 'Teleconsulta', duration_min: null }],
        professionals: [{ ...base.professionals[0]!, services: ['Consulta de medicina general', 'Teleconsulta'] }],
      },
      DOC,
    );
    expect(a.services.map((s) => s.name)).toEqual(['Consulta de medicina general']);
    expect(a.resources[0]!.service_ids).toEqual(['consulta-de-medicina-general']);
    expect(a.discarded).toContain('Servicio "Teleconsulta": es una modalidad de atención (se agenda como sede virtual), no un servicio.');
  });
});
