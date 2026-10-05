import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { EmbeddingsUnavailableError, InvalidDocumentError, toSlug, type UploadInput } from '../src/knowledge/knowledgeService.js';
import { fakeAppDeps } from './helpers.js';
import { makeDocx } from './knowledge/fixtures.js';

type Knowledge = ReturnType<typeof fakeAppDeps>['knowledge'];
const appWith = (overrides: Partial<Knowledge>) => {
  const deps = fakeAppDeps();
  return buildApp({ ...deps, knowledge: { ...deps.knowledge, ...overrides } });
};

const summary = {
  slug: 'tarifas',
  title: 'Tarifas',
  source_filename: 'tarifas.md',
  source_format: 'markdown' as const,
  chars: 20,
  updated_at: new Date(),
  chunks: 1,
  indexed_at: new Date(),
  embedding_model: 'm',
  indexed: true,
};

/** Cuerpo multipart/form-data con un archivo, armado a mano para inject(). */
function multipart(filename: string, data: Buffer, contentType = 'application/octet-stream') {
  const boundary = '----prueba' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('API de la base de conocimiento: subida', () => {
  it('un archivo Word por multipart se extrae a texto y se entrega al servicio', async () => {
    let received: UploadInput | undefined;
    const app = appWith({
      upload: async (_c, input) => {
        received = input;
        return { document: summary, created: true, reindexed: true };
      },
    });
    const res = await app.inject({ method: 'POST', url: '/knowledge/documents', ...multipart('tarifas.docx', await makeDocx()) });
    expect(res.statusCode).toBe(201);
    expect(received).toMatchObject({ filename: 'tarifas.docx', format: 'word' });
    expect(received!.content).toMatch(/^## Dermatología/m);
  });

  it('400 con un formato no soportado, sin llegar al servicio', async () => {
    let called = false;
    const app = appWith({
      upload: async () => {
        called = true;
        return { document: summary, created: true, reindexed: true };
      },
    });
    const res = await app.inject({ method: 'POST', url: '/knowledge/documents', ...multipart('viejo.doc', Buffer.from('x')) });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/\.docx/);
    expect(called).toBe(false);
  });

  it('201 al subir texto pegado nuevo y 200 al reemplazarlo', async () => {
    let created = true;
    const app = appWith({ upload: async () => ({ document: summary, created, reindexed: true }) });
    const post = () => app.inject({ method: 'POST', url: '/knowledge/documents', payload: { title: 'Tarifas', content: '# Tarifas\nTexto' } });
    expect((await post()).statusCode).toBe(201);
    created = false;
    expect((await post()).statusCode).toBe(200);
  });

  it('400 si el texto pegado no trae título o contenido', async () => {
    const res = await appWith({}).inject({ method: 'POST', url: '/knowledge/documents', payload: { content: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_document');
  });

  it('400 cuando el servicio rechaza el documento', async () => {
    const app = appWith({
      upload: async () => {
        throw new InvalidDocumentError('El documento está vacío.');
      },
    });
    const res = await app.inject({ method: 'POST', url: '/knowledge/documents', payload: { title: 'x', content: 'y' } });
    expect(res.statusCode).toBe(400);
  });

  it('503 si no hay API key para generar embeddings', async () => {
    const app = appWith({
      upload: async () => {
        throw new EmbeddingsUnavailableError();
      },
    });
    const res = await app.inject({ method: 'POST', url: '/knowledge/documents', payload: { title: 'x', content: 'y' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('embeddings_unavailable');
  });
});

describe('API de la base de conocimiento: resto', () => {
  it('204 al borrar y 404 si no existe', async () => {
    expect((await appWith({ remove: async () => true }).inject({ method: 'DELETE', url: '/knowledge/documents/tarifas' })).statusCode).toBe(204);
    expect((await appWith({ remove: async () => false }).inject({ method: 'DELETE', url: '/knowledge/documents/tarifas' })).statusCode).toBe(404);
  });

  it('la búsqueda de prueba exige una pregunta y usa la clínica del header', async () => {
    let clinic = '';
    const app = appWith({
      search: async (clinicId, query) => {
        clinic = clinicId;
        return { query, min_similarity: 0.3, top_k: 4, results: [] };
      },
    });
    expect((await app.inject({ method: 'GET', url: '/knowledge/search?q=' })).statusCode).toBe(400);
    const res = await app.inject({ method: 'GET', url: '/knowledge/search?q=ayuno', headers: { 'x-clinic-id': 'clinica-b' } });
    expect(res.statusCode).toBe(200);
    expect(clinic).toBe('clinica-b');
  });
});

describe('toSlug', () => {
  it.each([
    ['05-Preparación de exámenes', 'preparacion-de-examenes'],
    ['Doctora García: horarios', 'doctora-garcia-horarios'],
    ['  Política   de cancelación  ', 'politica-de-cancelacion'],
  ])('%s → %s', (input, slug) => expect(toSlug(input)).toBe(slug));
});
