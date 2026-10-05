import OpenAI from 'openai';
import type { Collection, Db } from 'mongodb';
import { EncryptionUnavailableError, maskSecret, type SecretBox } from './crypto.js';

/** Documento de configuración de IA por clínica. La key se guarda cifrada. */
interface AiSettingsDoc {
  _id: string; // clinic_id
  openai_key_encrypted: string;
  openai_key_masked: string;
  updated_at: Date;
  validated_at: Date;
}

export type KeySource = 'panel' | 'env';

export interface AiSettingsStatus {
  configured: boolean;
  /** De dónde sale la key que se está usando: el panel o el .env del servidor. */
  source: KeySource | null;
  masked: string | null;
  updated_at: Date | null;
  model: string;
  /** Si se puede guardar una key desde el panel (hay clave maestra de cifrado). */
  can_save: boolean;
}

export type KeyValidation = { ok: true } | { ok: false; reason: 'invalid_key' | 'model_unavailable' | 'unreachable'; message: string };

/** Valida una key contra OpenAI. Se inyecta para poder probar sin red. */
export type KeyValidator = (apiKey: string, model: string) => Promise<KeyValidation>;

export class InvalidApiKeyError extends Error {
  constructor(
    readonly reason: Exclude<KeyValidation, { ok: true }>['reason'],
    message: string,
  ) {
    super(message);
    this.name = 'InvalidApiKeyError';
  }
}

const CACHE_TTL_MS = 30_000;

/**
 * Credenciales del modelo de IA por clínica. La key configurada en el panel
 * tiene prioridad; si no hay, se usa OPENAI_API_KEY del .env. El worker y los
 * embeddings la leen en cada uso (con caché corto): un cambio en el panel aplica
 * sin reiniciar nada.
 */
export class AiCredentials {
  private readonly collection: Collection<AiSettingsDoc>;
  private readonly cache = new Map<string, { key: string | null; source: KeySource | null; at: number }>();

  constructor(
    db: Db,
    private readonly box: SecretBox | null,
    private readonly envKey: string | undefined,
    readonly model: string,
    private readonly validate: KeyValidator = validateWithOpenAI,
    private readonly now: () => number = Date.now,
  ) {
    this.collection = db.collection<AiSettingsDoc>('clinic_settings');
  }

  /** Key a usar para una clínica, o null si no hay ninguna configurada. */
  async resolveKey(clinicId: string): Promise<string | null> {
    return (await this.resolve(clinicId)).key;
  }

  async status(clinicId: string): Promise<AiSettingsStatus> {
    const doc = await this.collection.findOne({ _id: clinicId });
    const usable = doc && this.box ? doc : null;
    return {
      configured: Boolean(usable || this.envKey),
      source: usable ? 'panel' : this.envKey ? 'env' : null,
      masked: usable ? usable.openai_key_masked : this.envKey ? maskSecret(this.envKey) : null,
      updated_at: usable?.updated_at ?? null,
      model: this.model,
      can_save: Boolean(this.box),
    };
  }

  /** Valida la key contra OpenAI y, si sirve, la guarda cifrada. */
  async save(clinicId: string, apiKey: string): Promise<AiSettingsStatus> {
    if (!this.box) throw new EncryptionUnavailableError();
    const key = apiKey.trim();
    const check = await this.validate(key, this.model);
    if (!check.ok) throw new InvalidApiKeyError(check.reason, check.message);

    const now = new Date();
    await this.collection.updateOne(
      { _id: clinicId },
      { $set: { openai_key_encrypted: this.box.encrypt(key), openai_key_masked: maskSecret(key), updated_at: now, validated_at: now } },
      { upsert: true },
    );
    this.cache.delete(clinicId);
    return this.status(clinicId);
  }

  /** Borra la key del panel; si hay una en el .env, se vuelve a usar esa. */
  async remove(clinicId: string): Promise<AiSettingsStatus> {
    await this.collection.deleteOne({ _id: clinicId });
    this.cache.delete(clinicId);
    return this.status(clinicId);
  }

  /** Prueba la key que se está usando hoy para la clínica. */
  async test(clinicId: string): Promise<KeyValidation & { source: KeySource | null }> {
    this.cache.delete(clinicId);
    const { key, source } = await this.resolve(clinicId);
    if (!key) return { ok: false, reason: 'invalid_key', message: 'No hay ninguna API key configurada.', source: null };
    return { ...(await this.validate(key, this.model)), source };
  }

  private async resolve(clinicId: string): Promise<{ key: string | null; source: KeySource | null }> {
    const cached = this.cache.get(clinicId);
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return cached;

    let key: string | null = null;
    let source: KeySource | null = null;
    const doc = this.box ? await this.collection.findOne({ _id: clinicId }) : null;
    if (doc && this.box) {
      key = this.box.decrypt(doc.openai_key_encrypted);
      source = 'panel';
    } else if (this.envKey) {
      key = this.envKey;
      source = 'env';
    }
    this.cache.set(clinicId, { key, source, at: this.now() });
    return { key, source };
  }
}

/** Valida la key pidiendo a OpenAI el modelo configurado: comprueba la key y el acceso al modelo. */
export async function validateWithOpenAI(apiKey: string, model: string): Promise<KeyValidation> {
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(apiKey)) {
    return { ok: false, reason: 'invalid_key', message: 'El formato no corresponde a una API key de OpenAI (empieza por "sk-").' };
  }
  try {
    await new OpenAI({ apiKey, maxRetries: 0, timeout: 10_000 }).models.retrieve(model);
    return { ok: true };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) return { ok: false, reason: 'invalid_key', message: 'OpenAI rechazó la key (inválida o revocada).' };
    if (status === 404 || status === 403) return { ok: false, reason: 'model_unavailable', message: `La key es válida, pero no tiene acceso al modelo ${model}.` };
    return { ok: false, reason: 'unreachable', message: 'No se pudo contactar a OpenAI para validar la key. Intenta de nuevo.' };
  }
}
