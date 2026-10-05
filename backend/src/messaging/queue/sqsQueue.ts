import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { incomingJobSchema, type IncomingJob } from '../types.js';
import type { EnqueueOptions, MessageQueue, ReceivedJob } from './MessageQueue.js';

export function createSqsClient(region: string, endpoint?: string): SQSClient {
  return new SQSClient({
    region,
    endpoint,
    // ElasticMQ no valida credenciales; en AWS se usan las del rol (no se definen aquí).
    ...(endpoint ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  });
}

export class SqsMessageQueue implements MessageQueue {
  private queueUrl: string | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  private async url(): Promise<string> {
    if (!this.queueUrl) {
      const res = await this.client.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
      if (!res.QueueUrl) throw new Error(`no existe la cola ${this.queueName}`);
      this.queueUrl = res.QueueUrl;
    }
    return this.queueUrl;
  }

  async enqueue(job: IncomingJob, opts: EnqueueOptions): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.url(),
        MessageBody: JSON.stringify(job),
        MessageGroupId: opts.groupId,
        MessageDeduplicationId: opts.dedupId,
      }),
    );
  }

  async receive({ max, waitSeconds }: { max: number; waitSeconds: number }): Promise<ReceivedJob[]> {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.url(),
        MaxNumberOfMessages: max,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );
    return (res.Messages ?? []).map((m) => ({
      job: incomingJobSchema.parse(JSON.parse(m.Body ?? '{}')),
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
      groupId: m.Attributes?.MessageGroupId ?? '',
      receipt: m.ReceiptHandle!,
    }));
  }

  async ack(msg: ReceivedJob): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: await this.url(), ReceiptHandle: msg.receipt }));
  }

  async retryLater(msg: ReceivedJob, delaySeconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.url(),
        ReceiptHandle: msg.receipt,
        VisibilityTimeout: delaySeconds,
      }),
    );
  }
}
