import { useEffect, useState } from 'react';
import { useAgendaCalendar } from '../api/hooks';
import type { CalendarDay, CalendarProfessional } from '../api/types';
import { CLINIC_TIMEZONE } from '../lib/format';
import { ErrorState, Loading } from './states';

const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/**
 * Calendario mensual de la clínica: por día, las citas confirmadas y las horas
 * libres de los profesionales. Al hacer clic en un día se abre a la derecha el
 * detalle por profesional; se cierra con la X, con Escape o con otro clic en el día.
 * Las fechas son cadenas YYYY-MM-DD en la zona de la clínica: la aritmética se
 * hace en UTC para que la zona del navegador no mueva los días.
 */
export function AgendaCalendar() {
  const today = todayInClinic();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState<string | null>(null);
  const [professionalId, setProfessionalId] = useState('');

  const { from, to } = monthGrid(month);
  const calendar = useAgendaCalendar(from, to);

  const goTo = (m: string) => {
    setMonth(m);
    setSelected(null);
  };

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  if (calendar.isPending) return <Loading label="Cargando calendario…" />;
  if (calendar.isError) return <ErrorState error={calendar.error} onRetry={() => void calendar.refetch()} />;

  // El filtro se arma con todos los profesionales que aparecen en el rango.
  const allProfessionals = new Map<string, string>();
  for (const d of calendar.data.days) for (const p of d.professionals) allProfessionals.set(p.id, p.name);
  const filter = (d: CalendarDay): CalendarDay => (professionalId ? { ...d, professionals: d.professionals.filter((p) => p.id === professionalId) } : d);
  const days = calendar.data.days.map(filter);
  const selectedDay = days.find((d) => d.date === selected);

  return (
    <div className={`calendar-layout ${selectedDay ? 'with-detail' : ''}`}>
      <section className="card">
        <header className="card-header calendar-head">
          <div className="calendar-nav">
            <button className="icon-btn" onClick={() => goTo(shiftMonth(month, -1))} aria-label="Mes anterior">
              ‹
            </button>
            <h2>{monthLabel(month)}</h2>
            <button className="icon-btn" onClick={() => goTo(shiftMonth(month, 1))} aria-label="Mes siguiente">
              ›
            </button>
            <button className="btn btn-small" onClick={() => goTo(today.slice(0, 7))} disabled={month === today.slice(0, 7)}>
              Hoy
            </button>
            {calendar.isFetching && <span className="spinner" aria-label="Actualizando" />}
          </div>
          <select className="select" value={professionalId} onChange={(e) => setProfessionalId(e.target.value)} aria-label="Profesional">
            <option value="">Todos los profesionales</option>
            {[...allProfessionals].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </header>

        <div className="calendar-legend muted small">
          <span>
            <i className="dot dot-booked" /> Citas
          </span>
          <span>
            <i className="dot dot-free" /> Horas libres para agendar
          </span>
        </div>

        <div className="calendar-grid" role="grid" aria-label={`Calendario de ${monthLabel(month)}`}>
          {WEEKDAYS.map((w) => (
            <div key={w} className="calendar-weekday" role="columnheader">
              {w}
            </div>
          ))}
          {days.map((d) => {
            const booked = d.professionals.reduce((n, p) => n + p.appointments.length, 0);
            const free = d.professionals.reduce((n, p) => n + freeMinutes(p), 0);
            const classes = [
              'calendar-day',
              d.date.slice(0, 7) !== month && 'outside',
              d.date < today && 'past',
              d.date === today && 'today',
              d.date === selected && 'selected',
            ].filter(Boolean);
            return (
              <button key={d.date} role="gridcell" className={classes.join(' ')} onClick={() => setSelected(d.date === selected ? null : d.date)} aria-pressed={d.date === selected}>
                <span className="calendar-date">{Number(d.date.slice(8))}</span>
                {d.holiday && <span className="calendar-tag muted">Festivo</span>}
                {booked > 0 && (
                  <span className="calendar-tag tag-booked">
                    {booked} {booked === 1 ? 'cita' : 'citas'}
                  </span>
                )}
                {free > 0 && <span className="calendar-tag tag-free">{formatHours(free)} libres</span>}
              </button>
            );
          })}
        </div>
      </section>

      {selectedDay && <DayDetail day={selectedDay} isPast={selectedDay.date < today} onClose={() => setSelected(null)} />}
    </div>
  );
}

function DayDetail({ day, isPast, onClose }: { day: CalendarDay; isPast: boolean; onClose: () => void }) {
  const booked = day.professionals.reduce((n, p) => n + p.appointments.length, 0);
  return (
    <aside className="card day-detail" aria-label={`Citas del ${dayLabel(day.date)}`}>
      <header className="card-header">
        <div>
          <h2 className="capitalize">{dayLabel(day.date)}</h2>
          <span className="muted small">
            {booked} {booked === 1 ? 'cita' : 'citas'}
          </span>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Cerrar detalle del día">
          ✕
        </button>
      </header>
      {day.holiday && <p className="banner banner-warning">Festivo: la clínica no atiende.</p>}
      {!day.holiday && day.professionals.length === 0 && <p className="muted">Ningún profesional atiende este día.</p>}
      {day.professionals.map((p) => (
        <ProfessionalDay key={p.id} professional={p} isPast={isPast} />
      ))}
    </aside>
  );
}

function ProfessionalDay({ professional: p, isPast }: { professional: CalendarProfessional; isPast: boolean }) {
  const times = [...p.blocks.flatMap((b) => [b.start, b.end]), ...p.appointments.flatMap((a) => [a.start, a.end])].map(toMinutes);
  const start = Math.min(...times);
  const span = Math.max(...times) - start || 1;
  const at = (a: string, b: string) => ({ left: `${((toMinutes(a) - start) / span) * 100}%`, width: `${((toMinutes(b) - toMinutes(a)) / span) * 100}%` });
  const free = p.blocks.flatMap((b) => b.free);

  return (
    <div className="pro-day">
      <div className="pro-day-head">
        <strong>{p.name}</strong>
        <span className="muted small">{p.blocks.map((b) => `${b.location ? `${b.location} ` : ''}${b.start}–${b.end}`).join(' · ')}</span>
      </div>
      {p.unavailable && <p className="muted small">No atiende: {p.unavailable}</p>}
      {times.length > 0 && (
        <div className="timeline" aria-hidden="true">
          {p.blocks.map((b) => (
            <span key={`b${b.start}`} className="seg seg-block" style={at(b.start, b.end)} />
          ))}
          {free.map((f) => (
            <span key={`f${f.start}`} className="seg seg-free" style={at(f.start, f.end)} />
          ))}
          {p.appointments.map((a) => (
            <span key={a.id} className="seg seg-booked" style={at(a.start, a.end)} title={`${a.start}–${a.end} · ${a.patient_name}`} />
          ))}
          <span className="timeline-label left">{fromMinutes(start)}</span>
          <span className="timeline-label right">{fromMinutes(start + span)}</span>
        </div>
      )}
      {p.appointments.length > 0 && (
        <ul className="plain-list appointment-list">
          {p.appointments.map((a) => (
            <li key={a.id}>
              <span className="appt-time">
                {a.start}–{a.end}
              </span>
              <span>
                <strong>{a.patient_name}</strong> <span className="muted">· {a.patient_phone}</span>
              </span>
              <span className="muted">
                {a.service}
                {a.location && ` · ${a.location}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!p.unavailable && (
        <p className="small">
          <span className="muted">Libre: </span>
          {free.length ? free.map((f) => `${f.start}–${f.end}`).join(', ') : <span className="muted">{isPast ? 'el día ya pasó' : 'sin horas libres'}</span>}
        </p>
      )}
    </div>
  );
}

// --- Fechas -----------------------------------------------------------------------

function todayInClinic(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TIMEZONE }).format(new Date());
}

const utc = (date: string) => new Date(`${date}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Semanas completas (lunes a domingo) que cubren el mes. */
export function monthGrid(month: string): { from: string; to: string } {
  const first = utc(`${month}-01`);
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  const from = new Date(first);
  from.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const to = new Date(last);
  to.setUTCDate(last.getUTCDate() + ((7 - last.getUTCDay()) % 7));
  return { from: iso(from), to: iso(to) };
}

function shiftMonth(month: string, delta: number): string {
  const d = utc(`${month}-01`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return iso(d).slice(0, 7);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const monthLabel = (month: string) =>
  capitalize(new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(utc(`${month}-01`)).replace(' de ', ' '));
const dayLabel = (date: string) => new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(utc(date));

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};
const fromMinutes = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Minutos libres sin contar dos veces los bloques que se cruzan (p. ej. dos sedes el mismo día). */
function freeMinutes(p: CalendarProfessional): number {
  const ranges = p.blocks.flatMap((b) => b.free).map((f) => [toMinutes(f.start), toMinutes(f.end)] as const).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = -1;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    total += end - Math.max(start, cursor);
    cursor = end;
  }
  return total;
}

/** 90 → "1,5 h"; 30 → "30 min". */
function formatHours(min: number): string {
  return min < 60 ? `${min} min` : `${(min / 60).toLocaleString('es-CO', { maximumFractionDigits: 1 })} h`;
}
