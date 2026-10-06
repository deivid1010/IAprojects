import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgendaCalendar as Calendar, AiSettingsStatus } from '../api/types';
import { AgendaCalendar, monthGrid } from '../components/AgendaCalendar';
import { Settings } from '../components/Settings';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** fetch falso que responde según el inicio de la ruta. */
function mockApi(routes: Record<string, unknown>) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => {
    const path = url.replace(/^\/api/, '');
    const match = Object.keys(routes).find((r) => path.startsWith(r));
    return new Response(JSON.stringify(match ? routes[match] : {}), { status: match ? 200 : 404, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

describe('monthGrid', () => {
  it('cubre el mes en semanas completas de lunes a domingo', () => {
    expect(monthGrid('2026-10')).toEqual({ from: '2026-09-28', to: '2026-11-01' });
    expect(monthGrid('2026-02')).toEqual({ from: '2026-01-26', to: '2026-03-01' });
  });
});

describe('Calendario de la agenda', () => {
  it('muestra citas y horas libres por día, y el detalle del día elegido', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-05T15:00:00Z') });
    const { from, to } = monthGrid('2026-10');
    const days: Calendar['days'] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      days.push({ date: d.toISOString().slice(0, 10), holiday: false, professionals: [] });
    }
    days.find((d) => d.date === '2026-10-06')!.professionals = [
      {
        id: 'dr-felipe',
        name: 'Dr. Felipe Martínez',
        unavailable: null,
        blocks: [{ location: 'Sede Norte', start: '14:00', end: '18:00', free: [{ start: '14:00', end: '15:00' }, { start: '15:30', end: '18:00' }] }],
        appointments: [{ id: 'a1', start: '15:00', end: '15:30', patient_name: 'Ana Pérez', patient_phone: '+573001112233', service: 'Dermatología', location: 'Sede Norte' }],
      },
    ];
    const fetch = mockApi({ '/agenda/calendar': { timezone: 'America/Bogota', today: '2026-10-05', days } });

    wrap(<AgendaCalendar />);
    expect(await screen.findByText('Octubre 2026')).toBeTruthy();
    expect(fetch.mock.calls[0]![0]).toMatch(/\/agenda\/calendar\?from=2026-09-28&to=2026-11-01$/);
    expect(screen.getByText('1 cita')).toBeTruthy();
    expect(screen.getByText('3,5 h libres')).toBeTruthy();

    const day6 = () => screen.getAllByRole('gridcell').find((c) => c.textContent?.startsWith('6'))!;
    // El detalle no se muestra hasta hacer clic en un día.
    expect(screen.queryByText('Ana Pérez')).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();

    fireEvent.click(day6());
    expect(screen.getByRole('complementary', { name: /Citas del martes, 6 de octubre/i })).toBeTruthy();
    expect(screen.getByText('Ana Pérez')).toBeTruthy();
    expect(screen.getByText('14:00–15:00, 15:30–18:00')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar detalle del día' }));
    expect(screen.queryByText('Ana Pérez')).toBeNull();

    // Otro clic en el mismo día lo vuelve a cerrar; Escape también.
    fireEvent.click(day6());
    fireEvent.click(day6());
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.click(day6());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('complementary')).toBeNull();
  });
});

describe('API key en ventana modal', () => {
  const status: AiSettingsStatus = { configured: true, source: 'panel', masked: 'sk-…wxyz', updated_at: null, model: 'gpt-test', can_save: true };

  it('el formulario solo aparece al pulsar el botón, y se cierra con Escape', async () => {
    mockApi({ '/settings/ai': status });
    wrap(<Settings />);

    const open = await screen.findByRole('button', { name: 'Reemplazar API key' });
    expect(screen.queryByLabelText('API key de OpenAI')).toBeNull();

    fireEvent.click(open);
    expect(screen.getByRole('dialog', { name: 'Reemplazar API key' })).toBeTruthy();
    expect(screen.getByLabelText('API key de OpenAI')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Simulador: caja de texto', () => {
  it('Enter envía el mensaje y Shift+Enter solo agrega un salto de línea', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    const { Simulator } = await import('../components/Simulator');
    const fetch = mockApi({ '/webhooks/messages': { status: 'accepted', message_id: 'm', conversation_id: 'c' }, '/conversations/': { conversation: { status: 'en_curso' }, messages: [], assistant_pending: false } });
    wrap(
      <MemoryRouter>
        <Simulator />
      </MemoryRouter>,
    );

    const box = screen.getByLabelText('Mensaje del paciente');
    expect(box.tagName).toBe('TEXTAREA');
    fireEvent.change(box, { target: { value: 'Hola,\nnecesito una cita' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: 'Enter' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toMatch(/\/webhooks\/messages$/);
    expect(JSON.parse(init.body as string).text).toBe('Hola,\nnecesito una cita');
  });
});

describe('Editor del prompt', () => {
  const TEMPLATE = 'Eres el asistente. Pide nombre{{datos_para_agendar}}.{{aviso_agenda}}\nHoy: {{fecha_actual}}';
  const promptStatus = {
    template: TEMPLATE,
    default_template: TEMPLATE,
    is_default: true,
    updated_at: null,
    variables: ['fecha_actual', 'datos_para_agendar', 'aviso_agenda'].map((name) => ({ name, description: name, example: '' })),
  };

  it('marca las variables que faltan, no deja guardar y al corregir envía el prompt', async () => {
    const aiStatus: AiSettingsStatus = { configured: true, source: 'env', masked: 'sk-…wxyz', updated_at: null, model: 'gpt-test', can_save: true };
    const fetch = mockApi({ '/settings/ai': aiStatus, '/settings/prompt': promptStatus });
    wrap(<Settings />);

    const editor = (await screen.findByLabelText('Prompt del asistente')) as HTMLTextAreaElement;
    expect(editor.value).toBe(TEMPLATE);
    const saveButton = screen.getByRole('button', { name: 'Guardar prompt' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true); // sin cambios

    fireEvent.change(editor, { target: { value: 'Eres Sofi. {{aviso_agenda}}{{datos_para_agendar}}' } });
    expect(screen.getByText('Faltan: {{fecha_actual}}')).toBeTruthy();
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(editor, { target: { value: 'Eres Sofi. {{aviso_agenda}}{{datos_para_agendar}} {{fecha_actual}}' } });
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    await vi.waitFor(() => expect(fetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(true));
    const put = fetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')! as unknown as [string, RequestInit];
    expect(put[0]).toMatch(/\/settings\/prompt$/);
    expect(JSON.parse(put[1].body as string)).toEqual({ template: 'Eres Sofi. {{aviso_agenda}}{{datos_para_agendar}} {{fecha_actual}}' });
  });
});
