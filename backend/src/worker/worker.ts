import type { MessageQueue, ReceivedJob } from '../messaging/queue/MessageQueue.js';
import { processIncoming, type Logger, type ProcessorDeps } from './processor.js';

const BATCH_SIZE = 10;
const MAX_BACKOFF_SECONDS = 30;

/** Espera exponencial entre reintentos: 2 s, 4 s, 8 s… hasta 30 s. */
export const backoffSeconds = (receiveCount: number) => Math.min(MAX_BACKOFF_SECONDS, 2 ** receiveCount);

/**
 * Consume la cola. Las conversaciones distintas se procesan en paralelo y los
 * mensajes de una misma conversación, en orden y de a uno.
 */
export class Worker {
  constructor(
    private readonly queue: MessageQueue,
    private readonly deps: ProcessorDeps,
    private readonly log: Logger,
  ) {}

  /** Procesa un lote. Devuelve cuántos mensajes recibió. */
  async runOnce(waitSeconds: number): Promise<number> {
    const batch = await this.queue.receive({ max: BATCH_SIZE, waitSeconds });
    const byGroup = new Map<string, ReceivedJob[]>();
    for (const msg of batch) byGroup.set(msg.groupId, [...(byGroup.get(msg.groupId) ?? []), msg]);

    await Promise.all([...byGroup.values()].map((msgs) => this.processGroup(msgs)));
    return batch.length;
  }

  async start(signal: AbortSignal, waitSeconds = 20): Promise<void> {
    this.log.info({}, 'worker escuchando la cola');
    while (!signal.aborted) {
      try {
        await this.runOnce(waitSeconds);
      } catch (err) {
        this.log.error({ error: (err as Error).message }, 'error leyendo la cola; reintento en 2 s');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    this.log.info({}, 'worker detenido');
  }

  private async processGroup(msgs: ReceivedJob[]) {
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]!;
      const ok = await this.handle(msg);
      if (!ok) {
        // Si un mensaje se reintenta, los siguientes de la misma conversación
        // vuelven a la cola detrás de él para no responder fuera de orden.
        await Promise.all(msgs.slice(i + 1).map((m) => this.queue.retryLater(m, 0).catch(() => {})));
        return;
      }
    }
  }

  private async handle(msg: ReceivedJob): Promise<boolean> {
    try {
      const outcome = await processIncoming(this.deps, msg.job, msg.receiveCount);
      if (outcome === 'done') {
        await this.queue.ack(msg);
        return true;
      }
      await this.queue.retryLater(msg, backoffSeconds(msg.receiveCount));
      return false;
    } catch (err) {
      // Falla inesperada (p. ej. Mongo caído): reintento. Si se repite, la DLQ lo atrapa.
      this.log.error({ message_id: msg.job.message_id, error: (err as Error).message }, 'error inesperado procesando mensaje');
      await this.queue.retryLater(msg, backoffSeconds(msg.receiveCount)).catch(() => {});
      return false;
    }
  }
}
