import type { IncomingJob } from '../types.js';

export interface EnqueueOptions {
  /** Mensajes del mismo grupo se entregan en orden y de a uno (una conversación). */
  groupId: string;
  /** Un mismo dedupId no se encola dos veces (message_id de WhatsApp). */
  dedupId: string;
}

export interface ReceivedJob {
  job: IncomingJob;
  /** Cuántas veces se ha entregado este mensaje, incluida esta. */
  receiveCount: number;
  groupId: string;
  receipt: string;
}

/**
 * Contrato de la cola con la semántica de SQS FIFO. Implementaciones:
 * SqsMessageQueue (ElasticMQ en local, SQS en AWS) e InMemoryMessageQueue (tests).
 */
export interface MessageQueue {
  enqueue(job: IncomingJob, opts: EnqueueOptions): Promise<void>;
  receive(opts: { max: number; waitSeconds: number }): Promise<ReceivedJob[]>;
  /** Procesado: se borra de la cola. */
  ack(msg: ReceivedJob): Promise<void>;
  /** Falló: vuelve a estar disponible después de `delaySeconds`. */
  retryLater(msg: ReceivedJob, delaySeconds: number): Promise<void>;
}
