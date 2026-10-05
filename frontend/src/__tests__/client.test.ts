import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../api/client';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('cliente de la API', () => {
  it('codifica el id de la conversación en la URL', async () => {
    const fetch = mockFetch(200, { conversation: {}, messages: [], totals: {}, assistant_pending: false });
    await api.conversation('clinica-vida-sana:+573001112233');
    expect(fetch.mock.calls[0]![0]).toMatch(/\/conversations\/clinica-vida-sana%3A%2B573001112233$/);
  });

  it('arma los parámetros de la bandeja', async () => {
    const fetch = mockFetch(200, { items: [], next_cursor: null });
    await api.listConversations({ status: 'escalada', cursor: 'abc' });
    expect(fetch.mock.calls[0]![0]).toMatch(/\/conversations\?status=escalada&cursor=abc&limit=20$/);
  });

  it('devuelve el código HTTP del webhook para distinguir aceptado (202) de duplicado (200)', async () => {
    mockFetch(200, { status: 'duplicate', message_id: 'm', conversation_id: 'c' });
    const res = await api.sendWebhook({ message_id: 'm', from: '+573000000000', text: 'hola', timestamp: '2026-10-06T03:40:00Z' });
    expect(res).toEqual({ status: 200, body: { status: 'duplicate', message_id: 'm', conversation_id: 'c' } });
  });

  it('convierte las respuestas de error en ApiError con código, mensaje y detalles', async () => {
    mockFetch(400, { error: 'invalid_payload', message: 'El mensaje no tiene el formato esperado', details: [{ field: 'from', message: 'E.164' }] });
    const err = await api.sendWebhook({ message_id: 'm', from: 'x', text: 'hola', timestamp: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_payload', details: [{ field: 'from', message: 'E.164' }] });
    expect(err.retryable).toBe(false);
  });

  it('un 503 (cola caída) se marca como reintentable', async () => {
    mockFetch(503, { error: 'queue_unavailable', message: 'Intenta de nuevo en unos segundos' });
    const err = await api.summary().catch((e) => e);
    expect(err).toMatchObject({ status: 503, retryable: true });
  });

  it('si la API no responde, el error lo explica', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await api.summary().catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: 'network_error', retryable: true });
    expect(err.message).toMatch(/No se pudo conectar con la API/);
  });
});

describe('subida de documentos', () => {
  it('los archivos se envían como multipart, sin forzar content-type JSON', async () => {
    const fetch = mockFetch(201, { document: {}, created: true, reindexed: true });
    await api.knowledge.uploadFile(new File(['%PDF-1.4'], 'tarifas.pdf', { type: 'application/pdf' }));
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(File);
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('el texto pegado se envía como JSON', async () => {
    const fetch = mockFetch(201, { document: {}, created: true, reindexed: true });
    await api.knowledge.uploadText({ title: 'Tarifas', content: '# Tarifas' });
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});
