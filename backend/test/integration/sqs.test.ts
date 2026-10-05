import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { createSqsClient, SqsMessageQueue } from '../../src/messaging/queue/sqsQueue.js';
import { CreateQueueCommand, DeleteQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { ReceivedJob } from '../../src/messaging/queue/MessageQueue.js';

// Contra ElasticMQ: verifica que el adaptador real cumple la semántica FIFO que
// el worker asume (la misma que en AWS SQS). Usa una cola temporal propia para
// no competir con el worker que consume la cola real.
let client: SQSClient;
let queue: SqsMessageQueue;
let queueUrl: string | undefined;
const run = randomUUID().slice(0, 8);

beforeAll(async () => {
  const env = loadEnv();
  client = createSqsClient(env.AWS_REGION, env.SQS_ENDPOINT);
  const name = `test-${run}.fifo`;
  ({ QueueUrl: queueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', VisibilityTimeout: '30' } }),
  ));
  queue = new SqsMessageQueue(client, name);
});

afterAll(async () => {
  if (queueUrl) await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  client.destroy();
});

/** Recibe hasta vaciar lo de esta corrida y devuelve los mensajes en orden. */
async function receiveAll(): Promise<ReceivedJob[]> {
  const out: ReceivedJob[] = [];
  for (let i = 0; i < 5; i++) {
    const batch = await queue.receive({ max: 10, waitSeconds: 1 });
    const mine = batch.filter((m) => m.job.clinic_id === `test-${run}`);
    out.push(...mine);
    for (const m of mine) await queue.ack(m);
    if (batch.length === 0) break;
  }
  return out;
}

describe('SqsMessageQueue contra ElasticMQ', () => {
  it('encola, deduplica por message_id y entrega en orden por conversación', async () => {
    const conv = `test-${run}:+573000000000`;
    const job = (id: string) => ({ message_id: `${run}-${id}`, clinic_id: `test-${run}`, conversation_id: conv });

    await queue.enqueue(job('a'), { groupId: conv, dedupId: `${run}-a` });
    await queue.enqueue(job('a'), { groupId: conv, dedupId: `${run}-a` }); // duplicado
    await queue.enqueue(job('b'), { groupId: conv, dedupId: `${run}-b` });

    const received = await receiveAll();
    expect(received.map((m) => m.job.message_id)).toEqual([`${run}-a`, `${run}-b`]);
    expect(received[0]?.receiveCount).toBe(1);
    expect(received[0]?.groupId).toBe(conv);
  });

  it('retryLater vuelve a entregar el mensaje e incrementa el contador', async () => {
    const conv = `test-${run}:+573000000001`;
    await queue.enqueue({ message_id: `${run}-r`, clinic_id: `test-${run}`, conversation_id: conv }, { groupId: conv, dedupId: `${run}-r` });

    let first: ReceivedJob | undefined;
    for (let i = 0; i < 5 && !first; i++) {
      first = (await queue.receive({ max: 10, waitSeconds: 1 })).find((m) => m.job.message_id === `${run}-r`);
    }
    expect(first).toBeDefined();
    await queue.retryLater(first!, 0);

    const again = (await receiveAll()).find((m) => m.job.message_id === `${run}-r`);
    expect(again?.receiveCount).toBe(2);
  });
});
