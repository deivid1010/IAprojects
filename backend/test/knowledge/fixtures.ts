import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Archivos Word y PDF reales generados en memoria para los tests.

/** Word real con títulos (estilo Título 1/2) y párrafos. */
export async function makeDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'Tarifas de consultas', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: 'Dermatología', heading: HeadingLevel.HEADING_2 }),
          new Paragraph('La consulta particular de dermatología cuesta 120.000 pesos.'),
          new Paragraph({ text: 'Pediatría', heading: HeadingLevel.HEADING_2 }),
          new Paragraph('La consulta particular de pediatría cuesta 90.000 pesos.'),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/** PDF real con texto seleccionable en dos páginas. */
export async function makePdf(lines: string[][]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const pageLines of lines) {
    const page = pdf.addPage([595, 842]);
    pageLines.forEach((line, i) => page.drawText(line, { x: 50, y: 780 - i * 18, size: 11, font }));
  }
  return Buffer.from(await pdf.save());
}

/** Word con las tres formas de tabla del documento real: normal, transpuesta y clave-valor. */
export async function makeDocxWithTables(): Promise<Buffer> {
  const { Table, TableRow, TableCell, TextRun } = await import('docx');
  const cell = (text: string, bold = false) => new TableCell({ children: text.split('\n').map((t) => new Paragraph({ children: [new TextRun({ text: t, bold })] })) });
  const row = (cells: string[], bold = false) => new TableRow({ children: cells.map((c) => cell(c, bold)) });
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'Datos de la clínica', heading: HeadingLevel.HEADING_1 }),
          new Table({ rows: [row(['Campo', 'Dato'], true), row(['Nombre', 'Clínica Integral Salud Viva']), row(['Ciudad', 'Santiago de Cali'])] }),
          new Paragraph({ text: 'Sedes', heading: HeadingLevel.HEADING_2 }),
          new Table({
            rows: [
              row(['', 'Sede Norte – Granada', 'Sede Sur – Ciudad Jardín'], true),
              row(['Dirección', 'Avenida 9N # 15-40', 'Calle 16 # 105-30, piso 3']),
              row(['Sábados', '7:00 a. m. – 1:00 p. m.', '8:00 a. m. – 12:00 m.']),
            ],
          }),
          new Paragraph({ text: 'Profesionales', heading: HeadingLevel.HEADING_2 }),
          new Table({
            rows: [
              row(['Profesional', 'Especialidad', 'Sede y días', 'Teleconsulta'], true),
              row(['Dr. Carlos Mejía', 'Medicina general', 'Norte: lunes a viernes', 'Sí, martes y jueves 5:00 – 7:00 p. m.']),
              row(['Dra. Valentina Rojas', 'Medicina general', 'Sur: lunes a viernes\nNorte: sábados', 'Sí, lunes y miércoles 2:00 – 4:00 p. m.']),
            ],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/** PDF con un párrafo y una tabla dibujada en columnas (como la exporta Word a PDF). */
export async function makePdfWithTable(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  page.drawText('Profesionales de la clinica', { x: 50, y: 780, size: 12, font });
  const cols = [50, 200, 360];
  const rows = [
    ['Profesional', 'Especialidad', 'Sede y dias'],
    ['Dr. Carlos Mejia', 'Medicina general', 'Norte: lunes a viernes'],
    ['Dra. Valentina Rojas', 'Medicina general', 'Sur: lunes a viernes'],
  ];
  rows.forEach((r, i) => r.forEach((text, c) => page.drawText(text, { x: cols[c]!, y: 740 - i * 20, size: 10, font })));
  page.drawText('Las citas se confirman por WhatsApp.', { x: 50, y: 660, size: 10, font });
  return Buffer.from(await pdf.save());
}
