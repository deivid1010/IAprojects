import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { QueueUnavailableError } from '../src/messaging/ingestService.js';
import { UnknownClinicError } from '../src/messaging/tenantResolver.js';
import { fakeAppDeps } from './helpers.js';

const valid = {
  message_id: 'wamid.001',
  from: '+573001112233',
  text: 'Hola, ¿tienen cita con dermatología mañana en la tarde?',
  timestamp: '2026-10-06T03:40:00Z',
};

const post = (app: ReturnType<typeof buildApp>, payload: unknown) =>
  app.inject({ method: 'POST', url: '/webhooks/messages', payload: payload as object });

describe('POST /webhooks/messages', () => {
  it('acepta el payload del enunciado con 202', async () => {
    const res = await post(buildApp(fakeAppDeps()), valid);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'accepted', message_id: 'wamid.001' });
  });

  it('responde 200 a un duplicado', async () => {
    const app = buildApp(
      fakeAppDeps({ ingest: { ingest: async (m) => ({ status: 'duplicate', messageId: m.message_id, conversationId: 'c' }) } }),
    );
    const res = await post(app, valid);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('duplicate');
  });

  it.each([
    ['sin message_id', { ...valid, message_id: undefined }, 'message_id'],
    ['teléfono sin formato E.164', { ...valid, from: '3001112233' }, 'from'],
    ['texto vacío', { ...valid, text: '   ' }, 'text'],
    ['timestamp inválido', { ...valid, timestamp: 'ayer' }, 'timestamp'],
  ])('rechaza con 400: %s', async (_name, payload, field) => {
    const res = await post(buildApp(fakeAppDeps()), payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(res.json().details.map((d: { field: string }) => d.field)).toContain(field);
  });

  it('rechaza un cuerpo que no es JSON válido', async () => {
    const res = await buildApp(fakeAppDeps()).inject({
      method: 'POST',
      url: '/webhooks/messages',
      headers: { 'content-type': 'application/json' },
      payload: '{no es json',
    });
    expect(res.statusCode).toBe(400);
  });

  it('responde 404 si no hay clínica para el WABA', async () => {
    const app = buildApp(
      fakeAppDeps({
        ingest: {
          ingest: async () => {
            throw new UnknownClinicError('el WABA 999');
          },
        },
      }),
    );
    const res = await post(app, { ...valid, waba_id: '999' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('unknown_clinic');
  });

  it('responde 503 si la cola no está disponible, para que WhatsApp reintente', async () => {
    const app = buildApp(
      fakeAppDeps({
        ingest: {
          ingest: async () => {
            throw new QueueUnavailableError(new Error('ECONNREFUSED'));
          },
        },
      }),
    );
    const res = await post(app, valid);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('queue_unavailable');
  });
});
