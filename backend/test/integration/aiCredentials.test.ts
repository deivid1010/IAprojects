import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { connectMongo, type Mongo } from '../../src/db/mongo.js';
import { AiCredentials, InvalidApiKeyError, type KeyValidator } from '../../src/settings/aiCredentials.js';
import { EncryptionUnavailableError, SecretBox } from '../../src/settings/crypto.js';

// Credenciales por clínica contra MongoDB real, con un validador falso (sin red).
let mongo: Mongo;
const clinicId = `test-ai-${randomUUID().slice(0, 8)}`;
const box = new SecretBox(randomBytes(32).toString('base64'));
const PANEL_KEY = 'sk-proj-panelpanelpanelpanelpanel1111';
const ENV_KEY = 'sk-proj-envenvenvenvenvenvenvenv2222';
const okValidator: KeyValidator = async () => ({ ok: true });

beforeAll(async () => {
  const env = loadEnv();
  mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
});

afterAll(async () => {
  await mongo.db.collection('clinic_settings').deleteMany({ _id: clinicId as never });
  await mongo.client.close();
});

describe('AiCredentials', () => {
  it('sin key en el panel usa la del .env', async () => {
    const creds = new AiCredentials(mongo.db, box, ENV_KEY, 'gpt-test', okValidator);
    expect(await creds.resolveKey(clinicId)).toBe(ENV_KEY);
    expect(await creds.status(clinicId)).toMatchObject({ configured: true, source: 'env', masked: 'sk-proj-…2222' });
  });

  it('la key del panel tiene prioridad, se guarda cifrada y nunca en claro', async () => {
    const creds = new AiCredentials(mongo.db, box, ENV_KEY, 'gpt-test', okValidator);
    const status = await creds.save(clinicId, PANEL_KEY);
    expect(status).toMatchObject({ source: 'panel', masked: 'sk-proj-…1111' });
    expect(await creds.resolveKey(clinicId)).toBe(PANEL_KEY);

    const raw = JSON.stringify(await mongo.db.collection('clinic_settings').findOne({ _id: clinicId as never }));
    expect(raw).not.toContain('panelpanel');
  });

  it('otro proceso (el worker) ve la key nueva sin reiniciar, al vencer el caché', async () => {
    let now = 0;
    const worker = new AiCredentials(mongo.db, box, ENV_KEY, 'gpt-test', okValidator, () => now);
    const api = new AiCredentials(mongo.db, box, ENV_KEY, 'gpt-test', okValidator);
    expect(await worker.resolveKey(clinicId)).toBe(PANEL_KEY);

    await api.save(clinicId, 'sk-proj-nuevanuevanuevanuevanueva3333');
    expect(await worker.resolveKey(clinicId)).toBe(PANEL_KEY); // aún en caché
    now = 31_000;
    expect(await worker.resolveKey(clinicId)).toBe('sk-proj-nuevanuevanuevanuevanueva3333');
  });

  it('no guarda una key que OpenAI rechaza', async () => {
    const reject: KeyValidator = async () => ({ ok: false, reason: 'invalid_key', message: 'OpenAI rechazó la key' });
    const creds = new AiCredentials(mongo.db, box, ENV_KEY, 'gpt-test', reject);
    await expect(creds.save(clinicId, 'sk-proj-malamalamalamalamalamala4444')).rejects.toBeInstanceOf(InvalidApiKeyError);
    expect(await creds.resolveKey(clinicId)).toBe('sk-proj-nuevanuevanuevanuevanueva3333');
  });

  it('al borrar la key del panel vuelve a la del .env; sin ninguna, no hay key', async () => {
    const creds = new AiCredentials(mongo.db, box, ENV_KEY, 'gpt-test', okValidator);
    expect((await creds.remove(clinicId)).source).toBe('env');
    expect(await new AiCredentials(mongo.db, box, undefined, 'gpt-test', okValidator).resolveKey(clinicId)).toBeNull();
  });

  it('sin clave maestra de cifrado no se puede guardar', async () => {
    const creds = new AiCredentials(mongo.db, null, ENV_KEY, 'gpt-test', okValidator);
    await expect(creds.save(clinicId, PANEL_KEY)).rejects.toBeInstanceOf(EncryptionUnavailableError);
    expect((await creds.status(clinicId)).can_save).toBe(false);
  });
});
