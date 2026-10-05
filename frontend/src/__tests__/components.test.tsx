import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Turn } from '../api/types';
import { TurnDetails } from '../components/TurnDetails';
import { formatDateTime, formatUsd } from '../lib/format';

afterEach(cleanup);

const turn = (t: Partial<Turn> = {}): Turn => ({
  attempt: 1,
  engine: 'openai',
  model: 'gpt-6-luna',
  latency_ms: 4200,
  iterations: 2,
  tokens: { input: 3038, cached_input: 1282, output: 116 },
  cost_usd: 0.000246,
  final_status: 'resuelta_por_ia',
  error: null,
  guardrail: null,
  tool_calls: [
    {
      name: 'consultar_disponibilidad',
      arguments: { especialidad: 'dermatologia', fecha: 'manana', franja: 'tarde' },
      result: { fecha: '2026-10-06', total_horarios: 8 },
      error: null,
      duration_ms: 35,
    },
  ],
  created_at: '2026-10-06T03:40:05Z',
  ...t,
});

describe('TurnDetails', () => {
  it('resume tools y costo, y al abrirlo muestra argumentos y resultado de cada tool', () => {
    render(<TurnDetails turns={[turn()]} />);
    expect(screen.getByText(/1 herramienta · US\$0.000246/)).toBeTruthy();

    fireEvent.click(screen.getByText('consultar_disponibilidad'));
    expect(screen.getByText(/"franja": "tarde"/)).toBeTruthy();
    expect(screen.getByText(/"total_horarios": 8/)).toBeTruthy();
    expect(screen.getByText(/gpt-6-luna/)).toBeTruthy();
  });

  it('muestra los intentos fallidos y los errores que la tool le devolvió al modelo', () => {
    render(
      <TurnDetails
        turns={[
          turn({ error: 'proveedor caído', tool_calls: [], cost_usd: null, final_status: null }),
          turn({
            attempt: 2,
            tool_calls: [{ name: 'agendar_cita', arguments: { hora: '2pm' }, result: null, error: 'argumentos_invalidos: Revisa los argumentos', duration_ms: 3 }],
          }),
        ]}
      />,
    );
    expect(screen.getByText(/2 intentos/)).toBeTruthy();
    expect(screen.getByText('Error: proveedor caído')).toBeTruthy();
    expect(screen.getByText(/✗ argumentos_invalidos/)).toBeTruthy();
  });
});

describe('formato', () => {
  it('muestra las fechas en hora de la clínica, no del navegador', () => {
    // 03:40 UTC del 6 de octubre = 10:40 p. m. del 5 en Cali.
    expect(formatDateTime('2026-10-06T03:40:00Z')).toMatch(/^5 de oct.*10:40 p/);
  });

  it('muestra costos de fracciones de centavo con suficiente precisión', () => {
    expect(formatUsd(0.000246)).toBe('US$0.000246');
    expect(formatUsd(1.5)).toBe('US$1.5000');
    expect(formatUsd(null)).toBe('—');
  });
});
