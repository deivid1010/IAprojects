import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { buildInstructions, DEFAULT_PROMPT_TEMPLATE, validatePromptTemplate } from '../src/assistant/prompt.js';
import { buildApp } from '../src/http/app.js';
import { PromptSettings } from '../src/settings/promptSettings.js';
import { PDF_MESSAGE_AT, testClinic } from './agenda/fakes.js';
import { fakeAppDeps } from './helpers.js';

/** Colección de Mongo en memoria con lo que usa PromptSettings. */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const collection = {
    findOne: async ({ _id }: { _id: string }) => docs.get(_id) ?? null,
    updateOne: async ({ _id }: { _id: string }, { $set }: { $set: Record<string, unknown> }) => void docs.set(_id, { _id, ...docs.get(_id), ...$set }),
    deleteOne: async ({ _id }: { _id: string }) => void docs.delete(_id),
  };
  return { db: { collection: () => collection } as unknown as Db, docs };
}

const VALID = 'Eres el asistente. Pide nombre{{datos_para_agendar}}.{{aviso_agenda}}\nHoy: {{fecha_actual}}';

describe('plantilla del prompt', () => {
  it('la plantilla por defecto usa todas las variables y ninguna desconocida', () => {
    expect(validatePromptTemplate(DEFAULT_PROMPT_TEMPLATE)).toEqual({ missing: [], unknown: [] });
  });

  it('reemplaza las variables con los datos de la clínica y la hora del mensaje', () => {
    const text = buildInstructions(testClinic, PDF_MESSAGE_AT, VALID);
    expect(text).toMatch(/^Eres el asistente\. Pide nombre/);
    expect(text).toMatch(/Hoy: lunes 5 de octubre de 2026, 10:40\sp\.\sm\. \(America\/Bogota\)$/);
    expect(text).not.toContain('{{');
  });

  it('detecta variables que faltan y desconocidas', () => {
    expect(validatePromptTemplate('Hola {{fecha_actual}} {{nombre_clinica}}')).toEqual({ missing: ['datos_para_agendar', 'aviso_agenda'], unknown: ['nombre_clinica'] });
  });
});

describe('PromptSettings', () => {
  it('sin cambios usa la plantilla por defecto; guardada, la de la clínica; restaurada, otra vez la por defecto', async () => {
    const prompts = new PromptSettings(fakeDb().db);
    expect(await prompts.status('c1')).toMatchObject({ is_default: true, template: DEFAULT_PROMPT_TEMPLATE });

    await prompts.save('c1', VALID);
    expect(await prompts.status('c1')).toMatchObject({ is_default: false, template: VALID });
    expect(await prompts.templateFor('c1')).toBe(VALID);
    expect(await prompts.templateFor('c2')).toBe(DEFAULT_PROMPT_TEMPLATE);

    await prompts.reset('c1');
    expect(await prompts.templateFor('c1')).toBe(DEFAULT_PROMPT_TEMPLATE);
  });

  it('guardar el texto por defecto no crea una copia: sigue las mejoras futuras del código', async () => {
    const { db, docs } = fakeDb();
    const status = await new PromptSettings(db).save('c1', DEFAULT_PROMPT_TEMPLATE);
    expect(status.is_default).toBe(true);
    expect(docs.size).toBe(0);
  });

  it('el worker ve el cambio cuando vence el caché (30 s)', async () => {
    let now = 0;
    const { db } = fakeDb();
    const panel = new PromptSettings(db);
    const worker = new PromptSettings(db, () => now);
    expect(await worker.templateFor('c1')).toBe(DEFAULT_PROMPT_TEMPLATE);
    await panel.save('c1', VALID);
    expect(await worker.templateFor('c1')).toBe(DEFAULT_PROMPT_TEMPLATE);
    now = 30_001;
    expect(await worker.templateFor('c1')).toBe(VALID);
  });
});

describe('API /settings/prompt', () => {
  const app = () => buildApp(fakeAppDeps({ prompt: new PromptSettings(fakeDb().db) }));

  it('guarda, devuelve y restaura el prompt', async () => {
    const a = app();
    const put = await a.inject({ method: 'PUT', url: '/settings/prompt', payload: { template: VALID } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ is_default: false, template: VALID });
    expect((await a.inject({ method: 'GET', url: '/settings/prompt' })).json().template).toBe(VALID);

    const del = await a.inject({ method: 'DELETE', url: '/settings/prompt' });
    expect(del.json()).toMatchObject({ is_default: true, template: DEFAULT_PROMPT_TEMPLATE });
  });

  it('rechaza un prompt sin las variables obligatorias, con un mensaje que dice cuáles faltan', async () => {
    const res = await app().inject({ method: 'PUT', url: '/settings/prompt', payload: { template: 'Eres un asistente. {{fecha_actual}}' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_prompt' });
    expect(res.json().message).toMatch(/\{\{datos_para_agendar\}\}, \{\{aviso_agenda\}\}/);
  });
});
