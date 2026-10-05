import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Cifrado de secretos guardados en la base (API keys de los clientes).
// AES-256-GCM: confidencialidad e integridad (un valor alterado no descifra).
// La clave maestra viene de SETTINGS_ENCRYPTION_KEY y nunca se guarda en la
// base. En AWS se reemplazaría por KMS (cifrado por sobre) o Secrets Manager.

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export class EncryptionUnavailableError extends Error {
  constructor() {
    super('Falta SETTINGS_ENCRYPTION_KEY en el .env del servidor: sin ella no se pueden guardar secretos. Genera una con: openssl rand -base64 32');
    this.name = 'EncryptionUnavailableError';
  }
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(masterKeyBase64: string) {
    const key = Buffer.from(masterKeyBase64, 'base64');
    if (key.length !== 32) throw new Error('SETTINGS_ENCRYPTION_KEY debe ser de 32 bytes en base64 (openssl rand -base64 32)');
    this.key = key;
  }

  /** Devuelve "iv.tag.cifrado" en base64. */
  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64')).join('.');
  }

  decrypt(payload: string): string {
    const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
    if (!iv || !tag || !data) throw new Error('secreto cifrado con formato inválido');
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}

/** "sk-proj-abc…xyz9" → "sk-proj-…xyz9": suficiente para reconocerla, inútil para usarla. */
export function maskSecret(secret: string): string {
  const prefix = secret.startsWith('sk-proj-') ? 'sk-proj-' : secret.startsWith('sk-') ? 'sk-' : '';
  return `${prefix}…${secret.slice(-4)}`;
}
