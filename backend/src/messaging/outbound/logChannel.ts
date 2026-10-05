import type { OutboundChannel, OutboundMessage } from './OutboundChannel.js';

interface InfoLogger {
  info(obj: object, msg: string): void;
}

/** Canal local: no envía nada, deja la respuesta en el log. */
export class LogChannel implements OutboundChannel {
  constructor(private readonly log: InfoLogger) {}

  async send(msg: OutboundMessage) {
    this.log.info({ to: msg.to, clinic_id: msg.clinicId, key: msg.idempotencyKey, text: msg.text }, 'whatsapp (simulado): mensaje enviado');
    return { providerMessageId: null };
  }
}
