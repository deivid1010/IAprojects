import type { CatalogRepository } from '../catalog/catalogRepository.js';
import type { Clinic } from '../catalog/schemas.js';

export class UnknownClinicError extends Error {
  constructor(detail: string) {
    super(`No hay una clínica configurada para ${detail}`);
    this.name = 'UnknownClinicError';
  }
}

/**
 * Decide a qué clínica pertenece un mensaje entrante.
 * - Producción: por el WhatsApp Business Account ID que trae el webhook de Meta.
 * - Prueba (una sola clínica, payload sin WABA): clínica por defecto del .env.
 * El tenant nunca se toma del texto del paciente ni de lo que diga el LLM.
 */
export class TenantResolver {
  constructor(
    private readonly catalog: CatalogRepository,
    private readonly defaultClinicId: string,
  ) {}

  async resolve(wabaId?: string): Promise<Clinic> {
    if (wabaId) {
      const clinic = await this.catalog.findClinicByWabaId(wabaId);
      if (!clinic) throw new UnknownClinicError(`el WABA ${wabaId}`);
      return clinic;
    }
    const clinic = await this.catalog.findClinicById(this.defaultClinicId);
    if (!clinic) throw new UnknownClinicError(`la clínica por defecto ${this.defaultClinicId} (¿corriste el seed?)`);
    return clinic;
  }
}
