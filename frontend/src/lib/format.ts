import type { ConversationStatus } from '../api/types';

export const CLINIC_TIMEZONE = 'America/Bogota';

export const STATUS_LABELS: Record<ConversationStatus, string> = {
  en_curso: 'En curso',
  resuelta_por_ia: 'Resuelta por IA',
  cita_agendada: 'Cita agendada',
  escalada: 'Escalada',
};

export const STATUS_ORDER: ConversationStatus[] = ['escalada', 'cita_agendada', 'resuelta_por_ia', 'en_curso'];

const dateTime = new Intl.DateTimeFormat('es-CO', {
  timeZone: CLINIC_TIMEZONE,
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** Fecha y hora en la zona de la clínica: "5 de oct, 10:40 p. m." */
export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

const relative = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

/** "hace 3 minutos", "ayer"… */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(seconds, 'second');
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86400), 'day');
}

/** Los turnos cuestan fracciones de centavo: se muestran con 4 a 6 decimales. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value === 0) return 'US$0';
  return `US$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('es-CO').format(n);
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** 174000 → "2 min 54 s"; 29000 → "29 s". */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min < 60) return sec ? `${min} min ${sec} s` : `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

/** Tiempo desde el inicio de la conversación: 13000 → "0:13". */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  return `${min}:${String(total % 60).padStart(2, '0')}`;
}

/** 3038 → "3,0 k" */
export function formatCompact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toLocaleString('es-CO', { maximumFractionDigits: 1 })} k` : String(n);
}
