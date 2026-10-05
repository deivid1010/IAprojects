import { randomUUID } from 'node:crypto';
import type { IncomingJob } from '../types.js';
import type { EnqueueOptions, MessageQueue, ReceivedJob } from './MessageQueue.js';

interface StoredMessage {
  job: IncomingJob;
  groupId: string;
  receiveCount: number;
  visibleAt: number;
  receipt: string | null; // con receipt = en vuelo
}

/**
 * Cola en memoria con la semántica de SQS FIFO que el sistema necesita:
 * deduplicación, orden por grupo (un grupo no entrega su siguiente mensaje
 * mientras el anterior está en vuelo), reintentos con retraso y DLQ.
 * Solo para tests.
 */
export class InMemoryMessageQueue implements MessageQueue {
  private messages: StoredMessage[] = [];
  private readonly seenDedupIds = new Set<string>();
  readonly deadLetters: IncomingJob[] = [];

  constructor(
    private readonly opts: { visibilityTimeoutMs?: number; maxReceiveCount?: number } = {},
    private readonly now: () => number = Date.now,
  ) {}

  async enqueue(job: IncomingJob, { groupId, dedupId }: EnqueueOptions): Promise<void> {
    if (this.seenDedupIds.has(dedupId)) return;
    this.seenDedupIds.add(dedupId);
    this.messages.push({ job, groupId, receiveCount: 0, visibleAt: 0, receipt: null });
  }

  async receive({ max }: { max: number; waitSeconds: number }): Promise<ReceivedJob[]> {
    const now = this.now();
    const out: ReceivedJob[] = [];
    const blockedGroups = new Set<string>();
    const maxReceive = this.opts.maxReceiveCount ?? Infinity;

    for (const m of [...this.messages]) {
      if (out.length >= max) break;
      // El primer mensaje de cada grupo bloquea a los siguientes hasta que se borre.
      if (blockedGroups.has(m.groupId)) continue;
      blockedGroups.add(m.groupId);

      const inFlight = m.receipt !== null && m.visibleAt > now;
      if (inFlight || m.visibleAt > now) continue;

      if (m.receiveCount >= maxReceive) {
        this.deadLetters.push(m.job);
        this.messages = this.messages.filter((x) => x !== m);
        blockedGroups.delete(m.groupId);
        continue;
      }

      m.receiveCount += 1;
      m.receipt = randomUUID();
      m.visibleAt = now + (this.opts.visibilityTimeoutMs ?? 60_000);
      out.push({ job: m.job, receiveCount: m.receiveCount, groupId: m.groupId, receipt: m.receipt });
    }
    return out;
  }

  async ack(msg: ReceivedJob): Promise<void> {
    this.messages = this.messages.filter((m) => m.receipt !== msg.receipt);
  }

  async retryLater(msg: ReceivedJob, delaySeconds: number): Promise<void> {
    const m = this.messages.find((x) => x.receipt === msg.receipt);
    if (!m) return;
    m.receipt = null;
    m.visibleAt = this.now() + delaySeconds * 1000;
  }

  /** Mensajes que siguen en la cola (en vuelo o esperando). */
  get size(): number {
    return this.messages.length;
  }
}
