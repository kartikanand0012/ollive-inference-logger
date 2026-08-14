// One-shot topic creation. Standalone plain-JS image (not part of the pnpm
// workspace) so it needs no TS build; topic names/partition counts below must
// stay in sync with packages/shared/src/kafka.ts.
const { Kafka, logLevel } = require('kafkajs');

const brokers = (process.env.KAFKA_BROKERS || 'kafka:9092').split(',');

const TOPICS = [
  // 6 partitions = up to 6 parallel workers without repartitioning.
  { topic: 'inference.events', numPartitions: 6, replicationFactor: 1 },
  // DLQ: low volume, ordering irrelevant → 1 partition.
  { topic: 'inference.dlq', numPartitions: 1, replicationFactor: 1 },
];

async function main() {
  const kafka = new Kafka({
    clientId: 'kafka-init',
    brokers,
    // kafkajs logs TOPIC_ALREADY_EXISTS at ERROR even though createTopics
    // swallows it and returns false — silence the client, we log ourselves.
    logLevel: logLevel.NOTHING,
    retry: { retries: 10, initialRetryTime: 500 },
  });
  const admin = kafka.admin();
  await admin.connect();
  try {
    const created = await admin.createTopics({ topics: TOPICS, waitForLeaders: true });
    console.log(created ? 'kafka-init: topics created' : 'kafka-init: topics already existed');
    // When a concurrent init instance created the topics, createTopics returns
    // false while leader election may still be pending — retry the metadata
    // read instead of failing the one-shot (topic existence is the guarantee).
    for (let attempt = 1; ; attempt++) {
      try {
        const meta = await admin.fetchTopicMetadata({ topics: TOPICS.map((t) => t.topic) });
        for (const t of meta.topics) {
          console.log(`kafka-init: ${t.name} → ${t.partitions.length} partition(s)`);
        }
        break;
      } catch (err) {
        if (attempt >= 10) {
          console.log('kafka-init: topics created but metadata not yet visible — continuing');
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } finally {
    await admin.disconnect();
  }
}

main().catch((err) => {
  console.error('kafka-init failed:', err && err.message ? err.message : err);
  process.exit(1);
});
