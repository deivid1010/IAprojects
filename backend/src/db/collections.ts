import type { Collection, Db } from 'mongodb';
import type { Clinic, KnowledgeDocument, Resource } from '../catalog/schemas.js';

// Nombres e índices de las colecciones en un solo lugar. Los índices responden
// a consultas concretas del sistema, no se crean "por si acaso".
export const COLLECTIONS = {
  clinics: 'clinics',
  resources: 'resources',
  knowledgeDocuments: 'knowledge_documents',
  conversations: 'conversations',
  messages: 'messages',
  turns: 'turns',
} as const;

export function clinicsCollection(db: Db): Collection<Clinic> {
  return db.collection<Clinic>(COLLECTIONS.clinics);
}

export function resourcesCollection(db: Db): Collection<Resource> {
  return db.collection<Resource>(COLLECTIONS.resources);
}

export function knowledgeDocumentsCollection(db: Db): Collection<KnowledgeDocument> {
  return db.collection<KnowledgeDocument>(COLLECTIONS.knowledgeDocuments);
}

export async function ensureMongoIndexes(db: Db): Promise<void> {
  await Promise.all([
    // Resolver la clínica por el número de WhatsApp que recibe el mensaje.
    db.collection(COLLECTIONS.clinics).createIndex({ whatsapp_number: 1 }, { unique: true }),
    // Multi-tenant: el WABA ID del mensaje entrante determina la clínica.
    db.collection(COLLECTIONS.clinics).createIndex(
      { whatsapp_business_account_id: 1 },
      { unique: true, partialFilterExpression: { whatsapp_business_account_id: { $type: 'string' } } },
    ),

    // Recursos de una clínica que prestan un servicio (consultar_disponibilidad).
    db.collection(COLLECTIONS.resources).createIndex({ clinic_id: 1, service_ids: 1, active: 1 }),

    db.collection(COLLECTIONS.knowledgeDocuments).createIndex({ clinic_id: 1, slug: 1 }, { unique: true }),

    // Una conversación por paciente y clínica: historial por teléfono.
    db.collection(COLLECTIONS.conversations).createIndex({ clinic_id: 1, phone: 1 }, { unique: true }),
    // Bandeja del coordinador: por estado o todas, más recientes primero. El _id
    // desempata conversaciones con la misma fecha en la paginación por cursor.
    db.collection(COLLECTIONS.conversations).createIndex({ clinic_id: 1, status: 1, last_message_at: -1, _id: -1 }),
    db.collection(COLLECTIONS.conversations).createIndex({ clinic_id: 1, last_message_at: -1, _id: -1 }),

    // Historial de una conversación en orden de llegada al servidor. La
    // idempotencia la da el _id (= message_id de WhatsApp), único por definición.
    db.collection(COLLECTIONS.messages).createIndex({ conversation_id: 1, created_at: 1 }),

    // Trazas de cada turno del asistente dentro de una conversación.
    db.collection(COLLECTIONS.turns).createIndex({ conversation_id: 1, created_at: 1 }),
  ]);
}
