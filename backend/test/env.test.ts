import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  MONGO_URL: 'mongodb://localhost:27017',
  DEFAULT_CLINIC_ID: 'clinica-test',
};

describe('loadEnv', () => {
  it('aplica valores por defecto', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.CLINIC_TIMEZONE).toBe('America/Bogota');
  });

  it('falla con un mensaje claro si falta una variable obligatoria', () => {
    expect(() => loadEnv({ MONGO_URL: base.MONGO_URL })).toThrow(/DATABASE_URL/);
  });
});
