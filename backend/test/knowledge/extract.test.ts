import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../../src/knowledge/chunker.js';
import { extractDocument, UnsupportedFileError } from '../../src/knowledge/extract.js';
import { makeDocx, makePdf } from './fixtures.js';

describe('extracción de texto por formato', () => {
  it('Markdown y texto se leen tal cual (sin BOM)', async () => {
    expect(await extractDocument('a.md', Buffer.from('﻿# Título\nHola'))).toEqual({ content: '# Título\nHola', format: 'markdown' });
    expect((await extractDocument('a.txt', Buffer.from('Hola'))).format).toBe('texto');
  });

  it('Word: los títulos se convierten en secciones Markdown y el chunker parte por ellas', async () => {
    const { content, format } = await extractDocument('tarifas.docx', await makeDocx());
    expect(format).toBe('word');
    expect(content).toMatch(/^# Tarifas de consultas/m);
    expect(content).toMatch(/^## Dermatología/m);
    const chunks = chunkMarkdown({ title: 'Tarifas de consultas', content });
    expect(chunks.map((c) => c.heading)).toEqual(['Dermatología', 'Pediatría']);
    expect(chunks[0]!.content).toContain('120.000 pesos');
  });

  it('PDF: extrae el texto de todas las páginas', async () => {
    const pdf = await makePdf([['Horarios de atencion', 'La sede norte atiende de lunes a viernes.'], ['Politica de cancelacion', 'Se cancela con 24 horas.']]);
    const { content, format } = await extractDocument('manual.pdf', pdf);
    expect(format).toBe('pdf');
    expect(content).toContain('La sede norte atiende de lunes a viernes.');
    expect(content).toContain('Se cancela con 24 horas.');
  });

  it.each([
    ['Word 97-2003', 'viejo.doc', Buffer.from('x'), /\.docx/],
    ['formato desconocido', 'foto.png', Buffer.from('x'), /Formato no soportado/],
    ['archivo vacío', 'vacio.md', Buffer.alloc(0), /vacío/],
    ['PDF dañado', 'roto.pdf', Buffer.from('no es un pdf'), /No se pudo leer el PDF/],
  ])('rechaza %s con un mensaje claro', async (_n, name, data, message) => {
    await expect(extractDocument(name, data)).rejects.toThrow(message);
    await expect(extractDocument(name, data)).rejects.toBeInstanceOf(UnsupportedFileError);
  });

  it('rechaza un PDF sin texto extraíble (escaneado)', async () => {
    const empty = await makePdf([[]]);
    await expect(extractDocument('escaneo.pdf', empty)).rejects.toThrow(/no tiene texto extraíble/);
  });
});

describe('chunker con texto extraído de PDF', () => {
  it('un bloque largo sin líneas en blanco se parte por oraciones sin superar el máximo', () => {
    const sentence = 'La clínica atiende pacientes particulares y de medicina prepagada con convenio vigente. ';
    const chunks = chunkMarkdown({ title: 'Manual', content: sentence.repeat(40) }, { maxChars: 900 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(900 + 'Manual\n'.length);
  });
});
