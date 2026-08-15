// DLQ replay — the production recovery story for failed events.
// After fixing whatever caused the dead-lettering (schema bug, DB outage),
// re-drive every replayable DLQ entry back through the normal pipeline:
//
//   pnpm --filter @ollive/worker replay-dlq        (or: make replay-dlq)
//
// Semantics: reads inference.dlq from the beginning with a fresh consumer
// group; entries that parse+validate are re-produced to inference.events
// (same keying), everything else is reported and left behind. Replay is SAFE
// TO RUN REPEATEDLY: re-produced events flow through the worker's
// ON CONFLICT (request_id) DO NOTHING insert, so already-landed rows are
// absorbed as duplicates. Kafka topics can't delete individual messages —
// unreplayable poison stays until topic retention expires it.
import { Kafka, logLevel } from 'kafkajs';
import { InferenceEventV1Schema, TOPIC_DLQ, TOPIC_EVENTS } from '@ollive/shared';

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:29092').split(',');
const kafka = new Kafka({ clientId: 'ollive-dlq-replay', brokers, logLevel: logLevel.NOTHING });

async function main(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  const offsets = await admin.fetchTopicOffsets(TOPIC_DLQ);
  await admin.disconnect();
  // Progress is tracked per partition BY OFFSET, not by a message counter —
  // a counter double-counts on redelivery after a transient produce failure
  // and can terminate before the tail is processed (audit finding). Entries
  // appended after this snapshot belong to the next replay run.
  const targets = new Map<number, number>();
  let total = 0;
  for (const p of offsets) {
    const high = Number(p.high);
    const low = Number(p.low);
    if (high > low) {
      targets.set(p.partition, high);
      total += high - low;
    }
  }
  if (targets.size === 0) {
    console.log('DLQ is empty — nothing to replay.');
    return;
  }
  console.log(`DLQ holds ${total} message(s); replaying valid ones to ${TOPIC_EVENTS}…`);

  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  const consumer = kafka.consumer({ groupId: `dlq-replay-${process.pid}-${Math.random().toString(36).slice(2)}` });
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC_DLQ, fromBeginning: true });

  let replayed = 0;
  const skipped: Array<{ offset: string; reason: string }> = [];

  await new Promise<void>((resolve, reject) => {
    consumer
      .run({
        eachMessage: async ({ partition, message }) => {
          const raw = message.value?.toString() ?? '';
          try {
            const parsed = InferenceEventV1Schema.safeParse(JSON.parse(raw));
            if (parsed.success) {
              // May run twice for one entry if a transient produce failure
              // forces redelivery — the worker's ON CONFLICT insert absorbs it.
              await producer.send({
                topic: TOPIC_EVENTS,
                acks: -1,
                messages: [
                  { key: parsed.data.conversation_id ?? parsed.data.request_id, value: raw },
                ],
              });
              replayed++;
            } else {
              skipped.push({ offset: message.offset, reason: 'still fails schema validation' });
            }
          } catch {
            skipped.push({ offset: message.offset, reason: 'still not valid JSON' });
          }
          // Progress AFTER handling: this partition is done once its snapshot
          // high-water mark is reached; all partitions done → stop.
          const target = targets.get(partition);
          if (target !== undefined && Number(message.offset) >= target - 1) {
            targets.delete(partition);
            if (targets.size === 0) resolve();
          }
        },
      })
      .catch(reject);
  });

  await consumer.disconnect();
  await producer.disconnect();

  console.log(`replayed: ${replayed} → ${TOPIC_EVENTS} (worker's ON CONFLICT dedupes any already-landed rows)`);
  console.log(`skipped:  ${skipped.length} unreplayable (left in DLQ until retention)`);
  for (const s of skipped.slice(0, 10)) console.log(`  offset ${s.offset}: ${s.reason}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('replay failed:', err);
    process.exit(1);
  });
