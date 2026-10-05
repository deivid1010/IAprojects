import OpenAI from 'openai';
import type { Db } from 'mongodb';
import type { Env } from '../config/env.js';
import { AiCredentials } from './aiCredentials.js';
import { SecretBox } from './crypto.js';

export function createAiCredentials(env: Env, db: Db): AiCredentials {
  const box = env.SETTINGS_ENCRYPTION_KEY ? new SecretBox(env.SETTINGS_ENCRYPTION_KEY) : null;
  return new AiCredentials(db, box, env.OPENAI_API_KEY || undefined, env.OPENAI_MODEL);
}

// Un cliente de OpenAI por key: se reutiliza mientras la key no cambie.
const clients = new Map<string, OpenAI>();

export function openAIClientFor(apiKey: string, opts: { timeoutMs?: number; maxRetries?: number } = {}): OpenAI {
  const cacheKey = `${apiKey}|${opts.timeoutMs ?? ''}|${opts.maxRetries ?? ''}`;
  let client = clients.get(cacheKey);
  if (!client) {
    client = new OpenAI({ apiKey, maxRetries: opts.maxRetries ?? 1, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) });
    clients.set(cacheKey, client);
  }
  return client;
}
