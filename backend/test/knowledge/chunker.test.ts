import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../../src/knowledge/chunker.js';

const DOCS = path.resolve('src/seed/docs');
const load = (file: string) => {
  const content = readFileSync(path.join(DOCS, file), 'utf8');
  return { title: content.split('\n')[0]!.replace(/^#\s*/, ''), content };
};

describe('chunkMarkdown', () => {
  it('parte por secciones y antepone título del documento y de la sección', () => {
    const chunks = chunkMarkdown(load('05-preparacion-examenes.md'));
    expect(chunks.map((c) => c.heading)).toEqual([null, 'Ayuno', 'Muestra de orina', 'General']);
    expect(chunks[1]!.content.startsWith('Preparación para exámenes de laboratorio — Ayuno\n')).toBe(true);
    expect(chunks[1]!.content).toContain('ayuno de 8 a 12 horas');
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
  });

  it('un documento sin secciones queda en un solo fragmento con su título', () => {
    const chunks = chunkMarkdown(load('06-politica-cancelacion.md'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content.startsWith('Política de cancelación y reprogramación\n')).toBe(true);
    expect(chunks[0]!.content).not.toContain('# Política'); // el título Markdown no se duplica
  });

  it('las secciones largas se parten por párrafos con solapamiento, sin cortar ítems', () => {
    const items = Array.from({ length: 12 }, (_, i) => `- Ítem número ${i + 1} con un texto de relleno suficientemente largo.`).join('\n');
    const chunks = chunkMarkdown({ title: 'Doc', content: `# Doc\n## Larga\n${items}` }, { maxChars: 200, overlapParagraphs: 1 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.split('\n').slice(1).every((l) => l.startsWith('- Ítem'))).toBe(true);
    // El último ítem de un fragmento se repite al inicio del siguiente.
    const lastOfFirst = chunks[0]!.content.split('\n').at(-1);
    expect(chunks[1]!.content.split('\n')[1]).toBe(lastOfFirst);
  });

  it('todos los documentos del seed producen fragmentos no vacíos y de tamaño acotado', () => {
    for (const file of readdirSync(DOCS)) {
      const chunks = chunkMarkdown(load(file));
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) expect(c.content.length).toBeLessThan(1200);
    }
  });
});

describe('chunkMarkdown: estructura de títulos y preguntas frecuentes', () => {
  const doc = {
    title: 'Base de conocimiento Salud Viva',
    content: [
      'Base de conocimiento Salud Viva',
      'Texto de introducción.',
      '# 1. DATOS DE LA CLÍNICA',
      '## 1.2 Profesionales',
      '- Profesional: Dr. Carlos Mejía | Especialidad: Medicina general',
      '# 2. SERVICIOS',
      '- Servicio: Citología | Duración: 15 min',
      '# 7. PREGUNTAS FRECUENTES',
      '**¿Atienden por EPS?**',
      'No atendemos por EPS básica.',
      '**¿Tienen pediatra los sábados?**',
      'Sí, la Dra. Juliana Ocampo atiende sábados.',
      '# 9. URGENCIAS',
      'Salud Viva no presta servicio de urgencias.',
    ].join('\n'),
  };
  const chunks = chunkMarkdown(doc);

  it('los títulos de nivel 1 abren sección: el contenido no queda bajo la subsección anterior', () => {
    expect(chunks.map((c) => c.heading)).toEqual([
      null,
      '1. DATOS DE LA CLÍNICA › 1.2 Profesionales',
      '2. SERVICIOS',
      '7. PREGUNTAS FRECUENTES › ¿Atienden por EPS?',
      '7. PREGUNTAS FRECUENTES › ¿Tienen pediatra los sábados?',
      '9. URGENCIAS',
    ]);
  });

  it('cada pregunta frecuente queda en su propio fragmento, rotulada con la pregunta', () => {
    const eps = chunks.find((c) => c.heading?.endsWith('¿Atienden por EPS?'))!;
    expect(eps.content).toBe('Base de conocimiento Salud Viva — 7. PREGUNTAS FRECUENTES › ¿Atienden por EPS?\nNo atendemos por EPS básica.');
  });
});
