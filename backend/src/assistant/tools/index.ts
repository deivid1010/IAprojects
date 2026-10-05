import type { AgendaProvider } from '../../agenda/AgendaProvider.js';
import type { Clinic } from '../../catalog/schemas.js';
import type { KnowledgeRetriever } from '../../knowledge/retriever.js';
import { agendarCitaTool } from './agendarCita.js';
import { buscarConocimientoTool } from './buscarConocimiento.js';
import { consultarDisponibilidadTool } from './consultarDisponibilidad.js';
import { escalarAHumanoTool } from './escalarAHumano.js';
import { ToolRegistry } from './registry.js';

export interface ToolDeps {
  agenda: AgendaProvider;
  knowledge: KnowledgeRetriever;
}

/**
 * Tools de una clínica. Se construyen por clínica porque sus esquemas dependen
 * de la configuración del cliente (servicios, sedes, datos que pide al agendar).
 */
export function buildToolRegistry(clinic: Clinic, deps: ToolDeps): ToolRegistry {
  // Sin agenda (la base de conocimiento no describe servicios ni profesionales),
  // el asistente no tiene herramientas de agendamiento: responde y escala.
  const scheduling = hasScheduling(clinic) ? [consultarDisponibilidadTool(clinic, deps.agenda), agendarCitaTool(clinic, deps.agenda)] : [];
  return new ToolRegistry([buscarConocimientoTool(deps.knowledge), ...scheduling, escalarAHumanoTool()]);
}

export function hasScheduling(clinic: Clinic): boolean {
  return clinic.services.length > 0;
}
