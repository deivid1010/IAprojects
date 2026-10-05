import type { FastifyRequest } from 'fastify';

/**
 * Clínica del usuario del panel (coordinador). En local: header X-Clinic-Id o la
 * clínica por defecto. En producción vendría del token de Cognito (claim de la
 * clínica), nunca de un parámetro que el cliente pueda cambiar.
 */
export function coordinatorClinic(req: FastifyRequest, defaultClinicId: string): string {
  const header = req.headers['x-clinic-id'];
  return typeof header === 'string' && header.trim() ? header.trim() : defaultClinicId;
}
