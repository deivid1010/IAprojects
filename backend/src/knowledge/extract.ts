import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { getDocumentProxy } from 'unpdf';
import { markdownTablesToLines, pdfItemsToLines, pdfLinesToText, tableToLines, type PositionedText } from './tables.js';

export type SourceFormat = 'markdown' | 'texto' | 'pdf' | 'word';

export const SUPPORTED_EXTENSIONS = ['.md', '.markdown', '.txt', '.pdf', '.docx'] as const;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export class UnsupportedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFileError';
  }
}

export interface ExtractedDocument {
  /** Texto del documento en Markdown: los títulos marcan las secciones para el chunking. */
  content: string;
  format: SourceFormat;
}

/**
 * Convierte un archivo subido en texto Markdown para indexar. Se guarda el texto
 * extraído, no el archivo original (en producción el original iría a S3).
 */
export async function extractDocument(filename: string, data: Buffer): Promise<ExtractedDocument> {
  if (data.length === 0) throw new UnsupportedFileError('El archivo está vacío.');
  if (data.length > MAX_FILE_BYTES) throw new UnsupportedFileError('El archivo supera 10 MB.');

  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  switch (ext) {
    case '.md':
    case '.markdown':
      return { content: markdownTablesToLines(decodeText(data)), format: 'markdown' };
    case '.txt':
      return { content: decodeText(data), format: 'texto' };
    case '.pdf':
      return { content: await pdfToText(data), format: 'pdf' };
    case '.docx':
      return { content: await docxToMarkdown(data), format: 'word' };
    case '.doc':
      throw new UnsupportedFileError('El formato .doc (Word 97-2003) no está soportado: guárdalo como .docx.');
    default:
      throw new UnsupportedFileError(`Formato no soportado. Usa ${SUPPORTED_EXTENSIONS.join(', ')}.`);
  }
}

function decodeText(data: Buffer): string {
  // Quita el BOM de UTF-8 si viene (frecuente en archivos guardados desde Windows).
  return data.toString('utf8').replace(/^﻿/, '');
}

async function pdfToText(data: Buffer): Promise<string> {
  const pages: string[] = [];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const { items } = await page.getTextContent();
      // Se usan las posiciones de cada texto para reconstruir líneas y tablas.
      const positioned: PositionedText[] = items
        .filter((i): i is typeof i & { str: string; transform: number[]; width: number } => 'str' in i)
        .map((i) => ({ str: i.str, x: i.transform[4]!, y: i.transform[5]!, width: i.width, fontSize: Math.abs(i.transform[3]!) || 10 }));
      pages.push(pdfLinesToText(pdfItemsToLines(positioned)).trim());
    }
  } catch {
    throw new UnsupportedFileError('No se pudo leer el PDF (¿está dañado o protegido con contraseña?).');
  }
  const text = pages.filter(Boolean).join('\n\n');
  if (text.replace(/\s/g, '').length < 20) {
    throw new UnsupportedFileError('El PDF no tiene texto extraíble (¿es un escaneo o una imagen?). Súbelo con texto seleccionable.');
  }
  return text;
}

async function docxToMarkdown(data: Buffer): Promise<string> {
  let html: string;
  try {
    ({ value: html } = await mammoth.convertToHtml({ buffer: data }));
  } catch {
    throw new UnsupportedFileError('No se pudo leer el archivo Word (¿está dañado?).');
  }
  // Los estilos "Título 1/2/3" de Word se vuelven #, ##, ###: el chunker parte por ellos.
  const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
  // turndown no tiene formato para tablas: las deja celda por celda. Cada fila
  // pasa a ser una línea con sus valores junto a la columna que les corresponde.
  turndown.addRule('tablas', {
    filter: 'table',
    replacement: (_content, node) => {
      const lines = htmlTableToLines(node as unknown as DomElement);
      return lines.length ? `\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\n` : '';
    },
  });
  // turndown escapa caracteres que en Markdown tendrían significado ("1\. Datos");
  // para indexar y mostrar se prefiere el texto limpio.
  const markdown = turndown
    .turndown(html)
    .replace(/\\([.\-#*_+()[\]!>`])/g, '$1')
    .trim();
  if (!markdown) throw new UnsupportedFileError('El archivo Word no tiene texto.');
  return markdown;
}

/** Lo mínimo del DOM que usa la conversión de tablas (turndown usa domino en Node). */
interface DomElement {
  tagName: string;
  textContent: string | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  children: ArrayLike<DomElement>;
}

function htmlTableToLines(table: DomElement): string[] {
  const rows = Array.from(table.querySelectorAll('tr'));
  const matrix = rows.map((tr) => Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.tagName)).map(cellText));
  if (matrix.length === 0) return [];
  // Encabezado: en tablas de 3 o más columnas, la primera fila por convención; en
  // las de 2 (Campo / Dato), solo si sus celdas son th o están en negrita.
  const first = rows[0] ? Array.from(rows[0].children) : [];
  const firstLooksLikeHeader = first.length > 0 && first.every((c) => /^th$/i.test(c.tagName) || isAllBold(c));
  const width = Math.max(...matrix.map((r) => r.length));
  return tableToLines(matrix, { firstRowIsHeader: width !== 2 || firstLooksLikeHeader });
}

/** Texto de una celda: sus párrafos o ítems de lista separados por " · ". */
function cellText(cell: DomElement): string {
  const blocks = Array.from(cell.querySelectorAll('p, li'))
    .map((b) => (b.textContent ?? '').trim())
    .filter(Boolean);
  return blocks.length ? blocks.join(' · ') : (cell.textContent ?? '').trim();
}

function isAllBold(cell: DomElement): boolean {
  const text = (cell.textContent ?? '').trim();
  if (!text) return true;
  const bold = Array.from(cell.querySelectorAll('strong, b'))
    .map((b) => b.textContent ?? '')
    .join('')
    .trim();
  return bold === text;
}
