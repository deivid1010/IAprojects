import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../../src/knowledge/chunker.js';
import { extractDocument } from '../../src/knowledge/extract.js';
import { markdownTablesToLines, tableToLines } from '../../src/knowledge/tables.js';
import { makeDocxWithTables } from './fixtures.js';

describe('tableToLines', () => {
  it('tabla normal: cada fila con sus valores junto a la columna', () => {
    expect(
      tableToLines(
        [
          ['Profesional', 'Especialidad', 'Sede y días'],
          ['Dr. Carlos Mejía', 'Medicina general', 'Norte: lunes a viernes'],
        ],
        { firstRowIsHeader: true },
      ),
    ).toEqual(['Profesional: Dr. Carlos Mejía | Especialidad: Medicina general | Sede y días: Norte: lunes a viernes']);
  });

  it('tabla transpuesta (encabezado con la primera celda vacía): la etiqueta de la fila va primero', () => {
    expect(
      tableToLines(
        [
          ['', 'Sede Norte', 'Sede Sur'],
          ['Dirección', 'Avenida 9N # 15-40', 'Calle 16 # 105-30'],
        ],
        { firstRowIsHeader: true },
      ),
    ).toEqual(['Dirección — Sede Norte: Avenida 9N # 15-40 | Sede Sur: Calle 16 # 105-30']);
  });

  it('tabla de 2 columnas: "clave: valor", saltando el encabezado si lo hay', () => {
    const m = [
      ['Campo', 'Dato'],
      ['Nombre', 'Salud Viva'],
    ];
    expect(tableToLines(m, { firstRowIsHeader: true })).toEqual(['Nombre: Salud Viva']);
    expect(tableToLines(m, { firstRowIsHeader: false })).toEqual(['Campo: Dato', 'Nombre: Salud Viva']);
  });

  it('omite celdas vacías y limpia negritas y espacios', () => {
    expect(
      tableToLines(
        [
          ['Servicio', 'Duración', 'Valor'],
          ['**Citología**', '  15 min ', ''],
        ],
        { firstRowIsHeader: true },
      ),
    ).toEqual(['Servicio: Citología | Duración: 15 min']);
  });
});

describe('markdownTablesToLines', () => {
  it('convierte tablas con barras y deja el resto del texto igual', () => {
    const md = '# Precios\nTexto antes\n| Servicio | Valor |\n|---|---|\n| Consulta general | $70.000 |\n| Pediatría | $110.000 |\nTexto después';
    expect(markdownTablesToLines(md)).toBe('# Precios\nTexto antes\n- Consulta general: $70.000\n- Pediatría: $110.000\nTexto después');
  });
});

describe('Word con tablas', () => {
  it('las tablas llegan como una línea por fila, con cada valor junto a su columna', async () => {
    const { content } = await extractDocument('datos.docx', await makeDocxWithTables());
    expect(content).toContain('- Nombre: Clínica Integral Salud Viva');
    expect(content).not.toContain('Campo: Dato');
    expect(content).toContain('- Dirección — Sede Norte – Granada: Avenida 9N # 15-40 | Sede Sur – Ciudad Jardín: Calle 16 # 105-30, piso 3');
    expect(content).toContain(
      '- Profesional: Dra. Valentina Rojas | Especialidad: Medicina general | Sede y días: Sur: lunes a viernes · Norte: sábados | Teleconsulta: Sí, lunes y miércoles 2:00 – 4:00 p. m.',
    );
  });

  it('al partir en fragmentos, cada profesional queda entero en su línea con su sección', async () => {
    const { content } = await extractDocument('datos.docx', await makeDocxWithTables());
    const profesionales = chunkMarkdown({ title: 'Datos', content }).find((c) => c.heading?.endsWith('Profesionales'))!;
    expect(profesionales.content).toMatch(/^Datos — Datos de la clínica › Profesionales\n/);
    expect(profesionales.content.split('\n').filter((l) => l.startsWith('- Profesional: '))).toHaveLength(2);
  });
});

describe('PDF con tablas', () => {
  it('reconstruye filas y columnas desde la posición de los textos', async () => {
    const { makePdfWithTable } = await import('./fixtures.js');
    const { content } = await extractDocument('profesionales.pdf', await makePdfWithTable());
    expect(content).toContain('Profesionales de la clinica');
    expect(content).toContain('- Profesional: Dr. Carlos Mejia | Especialidad: Medicina general | Sede y dias: Norte: lunes a viernes');
    expect(content).toContain('- Profesional: Dra. Valentina Rojas | Especialidad: Medicina general | Sede y dias: Sur: lunes a viernes');
    expect(content).toContain('Las citas se confirman por WhatsApp.');
  });

  it('textos de una misma línea con espacios normales no se parten en columnas', async () => {
    const { pdfItemsToLines, pdfLinesToText } = await import('../../src/knowledge/tables.js');
    const items = [
      { str: 'La sede norte', x: 50, y: 700, width: 60, fontSize: 10 },
      { str: 'atiende de lunes a viernes.', x: 113, y: 700.5, width: 120, fontSize: 10 },
    ];
    expect(pdfLinesToText(pdfItemsToLines(items))).toBe('La sede norte atiende de lunes a viernes.');
  });
});
