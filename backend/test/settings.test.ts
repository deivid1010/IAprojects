import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KnowledgeGateEngine, NO_API_KEY_REASON } from '../src/assistant/knowledgeGate.js';
import type { AssistantEngine, AssistantInput } from '../src/assistant/engine.js';
import { buildApp } from '../src/http/app.js';
import { InvalidApiKeyError } from '../src/settings/aiCredentials.js';
import { EncryptionUnavailableError, maskSecret, SecretBox } from '../src/settings/crypto.js';
import { fakeAppDeps } from './helpers.js';

const masterKey = randomBytes(32).toString('base64');
const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

describe('SecretBox (AES-256-GCM)', () => {
  it('cifra y descifra; el texto cifrado no contiene la key', () => {
    const box = new SecretBox(masterKey);
    const enc = box.encrypt(KEY);
    expect(enc).not.toContain('abcdef');
    expect(box.decrypt(enc)).toBe(KEY);
  });

  it('cada cifrado es distinto (IV aleatorio)', () => {
    const box = new SecretBox(masterKey);
    expect(box.encrypt(KEY)).not.toBe(box.encrypt(KEY));
  });

  it('un valor alterado o con otra clave maestra no descifra', () => {
    const box = new SecretBox(masterKey);
    const enc = box.encrypt(KEY);
    const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => box.decrypt(tampered)).toThrow();
    expect(() => new SecretBox(randomBytes(32).toString('base64')).decrypt(enc)).toThrow();
  });

  it('rechaza una clave maestra de tamaño incorrecto', () => {
    expect(() => new SecretBox(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('enmascara la key dejando solo el prefijo y los últimos 4', () => {
    expect(maskSecret(KEY)).toBe('sk-proj-…6789');
  });
});

describe('API /settings/ai', () => {
  const status = { configured: true, source: 'panel' as const, masked: 'sk-proj-…6789', updated_at: new Date(), model: 'gpt-test', can_save: true };
  const appWith = (overrides: Partial<ReturnType<typeof fakeAppDeps>['aiSettings']>) => {
    const deps = fakeAppDeps();
    return buildApp({ ...deps, aiSettings: { ...deps.aiSettings, ...overrides } });
  };

  it('GET devuelve el estado con la key enmascarada, nunca completa', async () => {
    const res = await appWith({ status: async () => status }).inject({ method: 'GET', url: '/settings/ai' });
    expect(res.json()).toMatchObject({ configured: true, source: 'panel', masked: 'sk-proj-…6789' });
    expect(res.body).not.toContain('abcdefghij');
  });

  it('PUT guarda la key válida y usa la clínica del header', async () => {
    let saved: [string, string] | undefined;
    const app = appWith({
      save: async (clinicId, key) => {
        saved = [clinicId, key];
        return status;
      },
    });
    const res = await app.inject({ method: 'PUT', url: '/settings/ai', payload: { api_key: ` ${KEY} ` }, headers: { 'x-clinic-id': 'clinica-b' } });
    expect(res.statusCode).toBe(200);
    expect(saved).toEqual(['clinica-b', KEY]);
    expect(res.body).not.toContain('abcdefghij');
  });

  it('PUT responde 400 con el motivo si OpenAI rechaza la key', async () => {
    const app = appWith({
      save: async () => {
        throw new InvalidApiKeyError('invalid_key', 'OpenAI rechazó la key (inválida o revocada).');
      },
    });
    const res = await app.inject({ method: 'PUT', url: '/settings/ai', payload: { api_key: KEY } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_key', message: 'OpenAI rechazó la key (inválida o revocada).' });
  });

  it('PUT responde 400 si falta la key y 503 si no hay clave maestra de cifrado', async () => {
    expect((await appWith({}).inject({ method: 'PUT', url: '/settings/ai', payload: { api_key: 'corta' } })).statusCode).toBe(400);
    const app = appWith({
      save: async () => {
        throw new EncryptionUnavailableError();
      },
    });
    const res = await app.inject({ method: 'PUT', url: '/settings/ai', payload: { api_key: KEY } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('encryption_unavailable');
  });

  it('DELETE borra la key del panel y POST /test prueba la actual', async () => {
    const app = appWith({ remove: async () => ({ ...status, source: 'env' }), test: async () => ({ ok: true, source: 'env' }) });
    expect((await app.inject({ method: 'DELETE', url: '/settings/ai' })).json().source).toBe('env');
    expect((await app.inject({ method: 'POST', url: '/settings/ai/test' })).json()).toEqual({ ok: true, source: 'env' });
  });
});

describe('sin API key no se llama al LLM', () => {
  it('responde el mensaje por defecto y escala con motivo sin_api_key', async () => {
    let called = false;
    const inner: AssistantEngine = {
      name: 'openai',
      async reply() {
        called = true;
        throw new Error('no debería llamarse');
      },
    };
    const gate = new KnowledgeGateEngine(inner, async () => true, async () => false);
    const reply = await gate.reply({ clinic: { _id: 'k' } } as unknown as AssistantInput, { signal: new AbortController().signal });
    expect(called).toBe(false);
    expect(reply).toMatchObject({ conversationStatus: 'escalada', escalationReason: NO_API_KEY_REASON, trace: { engine: 'sin_llm', guardrail: 'sin_api_key' } });
  });
});
