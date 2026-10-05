import type { Db } from 'mongodb';
import { openAIResponsesClient } from '../assistant/openaiEngine.js';
import type { Env } from '../config/env.js';
import type { AiCredentials } from '../settings/aiCredentials.js';
import { openAIClientFor } from '../settings/setup.js';
import { AgendaSync } from './agendaSync.js';
import { openAIAgendaExtractor } from './extraction/agendaExtractor.js';

/** Agenda dinámica con el extractor de OpenAI y la API key de cada clínica. */
export function createAgendaSync(env: Env, db: Db, credentials: AiCredentials, log: ConstructorParameters<typeof AgendaSync>[2]): AgendaSync {
  return new AgendaSync(
    db,
    async (clinicId) => {
      const key = await credentials.resolveKey(clinicId);
      if (!key) return null;
      return openAIAgendaExtractor(openAIResponsesClient(openAIClientFor(key, { maxRetries: 1, timeoutMs: 120_000 })), env.OPENAI_MODEL, env.AGENDA_EXTRACTION_REASONING_EFFORT);
    },
    log,
  );
}
