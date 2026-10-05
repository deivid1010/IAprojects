import { describe, expect, it } from 'vitest';
import { InMemoryMessageQueue } from '../src/messaging/queue/inMemoryQueue.js';

const job = (id: string, conv = 'c1') => ({ message_id: id, clinic_id: 'k', conversation_id: conv });
const enqueue = (q: InMemoryMessageQueue, id: string, conv = 'c1') => q.enqueue(job(id, conv), { groupId: conv, dedupId: id });

// La cola en memoria debe comportarse como SQS FIFO para que los tests del
// worker sean representativos.
describe('InMemoryMessageQueue (semántica SQS FIFO)', () => {
  it('deduplica por dedupId', async () => {
    const q = new InMemoryMessageQueue();
    await enqueue(q, 'm1');
    await enqueue(q, 'm1');
    expect(q.size).toBe(1);
  });

  it('no entrega el siguiente mensaje de un grupo mientras el anterior está en vuelo', async () => {
    const q = new InMemoryMessageQueue();
    await enqueue(q, 'm1', 'c1');
    await enqueue(q, 'm2', 'c1');
    await enqueue(q, 'x1', 'c2');

    const first = await q.receive({ max: 10, waitSeconds: 0 });
    expect(first.map((m) => m.job.message_id)).toEqual(['m1', 'x1']);
    expect(await q.receive({ max: 10, waitSeconds: 0 })).toEqual([]);

    await q.ack(first[0]!);
    const next = await q.receive({ max: 10, waitSeconds: 0 });
    expect(next.map((m) => m.job.message_id)).toEqual(['m2']);
  });

  it('reintenta después del retraso y cuenta las entregas', async () => {
    let now = 0;
    const q = new InMemoryMessageQueue({}, () => now);
    await enqueue(q, 'm1');

    const [m] = await q.receive({ max: 1, waitSeconds: 0 });
    await q.retryLater(m!, 5);
    expect(await q.receive({ max: 1, waitSeconds: 0 })).toEqual([]);

    now = 5_000;
    const [again] = await q.receive({ max: 1, waitSeconds: 0 });
    expect(again?.receiveCount).toBe(2);
  });

  it('mueve a la DLQ al superar el máximo de entregas', async () => {
    const q = new InMemoryMessageQueue({ maxReceiveCount: 2 });
    await enqueue(q, 'm1');
    for (let i = 0; i < 2; i++) {
      const [m] = await q.receive({ max: 1, waitSeconds: 0 });
      await q.retryLater(m!, 0);
    }
    expect(await q.receive({ max: 1, waitSeconds: 0 })).toEqual([]);
    expect(q.deadLetters.map((j) => j.message_id)).toEqual(['m1']);
  });
});
