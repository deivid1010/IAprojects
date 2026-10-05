import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractDocument, MAX_FILE_BYTES, UnsupportedFileError } from '../../knowledge/extract.js';
import { EmbeddingsUnavailableError, InvalidDocumentError, MAX_DOCUMENT_CHARS, type KnowledgeService, type UploadInput } from '../../knowledge/knowledgeService.js';
import { coordinatorClinic } from '../clinicContext.js';

type Service = Pick<KnowledgeService, 'list' | 'get' | 'upload' | 'remove' | 'reindex' | 'search'>;

// Texto pegado en el panel (JSON). Los archivos llegan por multipart.
const pastedSchema = z.object({
  title: z.string().trim().min(1, 'indica un título').max(200),
  content: z.string().min(1, 'el documento está vacío').max(MAX_DOCUMENT_CHARS),
});
const slugParams = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) });
const searchQuery = z.object({ q: z.string().trim().min(2).max(500) });

/** Administración de la base de conocimiento de la clínica del coordinador. */
export function knowledgeRoutes(service: Service, defaultClinicId: string) {
  return async (app: FastifyInstance) => {
    await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5 } });

    // Errores del dominio → respuestas claras para el panel.
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof EmbeddingsUnavailableError) return reply.code(503).send({ error: 'embeddings_unavailable', message: err.message });
      if (err instanceof InvalidDocumentError || err instanceof UnsupportedFileError) {
        return reply.code(400).send({ error: 'invalid_document', message: err.message });
      }
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: 'file_too_large', message: 'El archivo supera 10 MB.' });
      }
      req.log.error({ err }, 'error en la base de conocimiento');
      return reply.code(500).send({ error: 'internal_error', message: 'Error interno' });
    });

    app.get('/knowledge/documents', async (req) => ({ items: await service.list(coordinatorClinic(req, defaultClinicId)) }));

    app.get('/knowledge/documents/:slug', async (req, reply) => {
      const params = slugParams.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_request', message: 'Identificador inválido' });
      const doc = await service.get(coordinatorClinic(req, defaultClinicId), params.data.slug);
      return doc ?? reply.code(404).send({ error: 'not_found', message: 'Documento no encontrado' });
    });

    // Sube o reemplaza (mismo nombre) y procesa con embeddings en el momento.
    // Archivo (multipart: .md, .txt, .pdf, .docx) o texto pegado (JSON).
    app.post('/knowledge/documents', async (req, reply) => {
      const input = req.isMultipart() ? await readUpload(req) : readPasted(req.body);
      if ('error' in input) return reply.code(400).send({ error: 'invalid_document', message: input.error });
      const result = await service.upload(coordinatorClinic(req, defaultClinicId), input);
      return reply.code(result.created ? 201 : 200).send(result);
    });

    app.delete('/knowledge/documents/:slug', async (req, reply) => {
      const params = slugParams.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_request', message: 'Identificador inválido' });
      const removed = await service.remove(coordinatorClinic(req, defaultClinicId), params.data.slug);
      return removed ? reply.code(204).send() : reply.code(404).send({ error: 'not_found', message: 'Documento no encontrado' });
    });

    app.post('/knowledge/reindex', async (req) => service.reindex(coordinatorClinic(req, defaultClinicId)));

    // Búsqueda de prueba: qué fragmentos recibiría el asistente para una pregunta.
    app.get('/knowledge/search', async (req, reply) => {
      const query = searchQuery.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_request', message: 'Escribe una pregunta de al menos 2 caracteres' });
      return service.search(coordinatorClinic(req, defaultClinicId), query.data.q);
    });
  };
}

async function readUpload(req: FastifyRequest): Promise<UploadInput | { error: string }> {
  const file = await req.file();
  if (!file) return { error: 'Adjunta un archivo en el campo "file".' };
  const data = await file.toBuffer(); // lanza FST_REQ_FILE_TOO_LARGE si supera el límite
  const { content, format } = await extractDocument(file.filename, data);
  const title = typeof (file.fields.title as { value?: unknown } | undefined)?.value === 'string' ? (file.fields.title as { value: string }).value : undefined;
  return { filename: file.filename, title: title?.trim() || undefined, content, format };
}

function readPasted(body: unknown): UploadInput | { error: string } {
  const parsed = pastedSchema.safeParse(body);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { title: parsed.data.title, content: parsed.data.content, format: 'texto' };
}
