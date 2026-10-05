export interface OutboundMessage {
  clinicId: string;
  to: string;
  text: string;
  /** Clave para que el proveedor no duplique el envío en un reintento. */
  idempotencyKey: string;
}

/**
 * Canal de salida hacia el paciente. En producción: WhatsApp Cloud API.
 * En local: LogChannel (la respuesta queda en el log y en Mongo).
 */
export interface OutboundChannel {
  send(msg: OutboundMessage): Promise<{ providerMessageId: string | null }>;
}
