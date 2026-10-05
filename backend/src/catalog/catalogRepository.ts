import type { Db } from 'mongodb';
import { clinicsCollection, resourcesCollection } from '../db/collections.js';
import { clinicSchema, resourceSchema, type Clinic, type Resource } from './schemas.js';

// Lectura del catálogo. Los documentos se validan al leerlos: como el esquema
// es flexible, el código no asume que lo guardado tenga la forma esperada.
export class CatalogRepository {
  constructor(private readonly db: Db) {}

  async findClinicById(clinicId: string): Promise<Clinic | null> {
    const doc = await clinicsCollection(this.db).findOne({ _id: clinicId });
    return doc ? clinicSchema.parse(doc) : null;
  }

  async findClinicByWhatsapp(whatsappNumber: string): Promise<Clinic | null> {
    const doc = await clinicsCollection(this.db).findOne({ whatsapp_number: whatsappNumber });
    return doc ? clinicSchema.parse(doc) : null;
  }

  async findClinicByWabaId(wabaId: string): Promise<Clinic | null> {
    const doc = await clinicsCollection(this.db).findOne({ whatsapp_business_account_id: wabaId });
    return doc ? clinicSchema.parse(doc) : null;
  }

  async findResourceById(clinicId: string, resourceId: string): Promise<Resource | null> {
    const doc = await resourcesCollection(this.db).findOne({ _id: resourceId, clinic_id: clinicId });
    return doc ? resourceSchema.parse(doc) : null;
  }

  /** Todos los recursos de una clínica (para mostrar la agenda). */
  async findResourcesByClinic(clinicId: string): Promise<Resource[]> {
    const docs = await resourcesCollection(this.db).find({ clinic_id: clinicId }).sort({ name: 1 }).toArray();
    return docs.map((d) => resourceSchema.parse(d));
  }

  /** Recursos activos de una clínica que prestan un servicio, opcionalmente en una sede. */
  async findResourcesForService(clinicId: string, serviceId: string, locationId?: string): Promise<Resource[]> {
    const filter: Record<string, unknown> = { clinic_id: clinicId, service_ids: serviceId, active: true };
    if (locationId) filter['schedules.location_id'] = locationId;
    const docs = await resourcesCollection(this.db).find(filter).sort({ _id: 1 }).toArray();
    return docs.map((d) => resourceSchema.parse(d));
  }
}
