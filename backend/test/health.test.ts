import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { fakeAppDeps } from './helpers.js';

const ok = async () => {};
const fail = async () => {
  throw new Error('sin conexión');
};

describe('GET /health', () => {
  it('responde 200 cuando ambas bases están arriba', async () => {
    const app = buildApp(fakeAppDeps({ health: { postgres: ok, mongo: ok } }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { postgres: 'up', mongo: 'up' } });
  });

  it('responde 503 e indica cuál base falla', async () => {
    const app = buildApp(fakeAppDeps({ health: { postgres: ok, mongo: fail } }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', checks: { postgres: 'up', mongo: 'down' } });
  });

  it('responde 404 en rutas desconocidas', async () => {
    const app = buildApp(fakeAppDeps({ health: { postgres: ok, mongo: ok } }));
    const res = await app.inject({ method: 'GET', url: '/no-existe' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});
