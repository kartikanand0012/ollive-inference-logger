// Kafka topology constants. infra/kafka-init/index.js (standalone plain-JS
// image) duplicates the names/partition counts — keep them in sync.

export const TOPIC_EVENTS = 'inference.events';
export const TOPIC_DLQ = 'inference.dlq';

/** Partitions on inference.events = max parallel workers without repartitioning. */
export const EVENTS_PARTITIONS = 6;

export const CONSUMER_GROUP_WRITERS = 'inference-writers';

/**
 * SASL/SSL config for managed Kafka (e.g. Redpanda Cloud). When
 * KAFKA_SASL_USERNAME is set, returns ssl + SCRAM-SHA-256 credentials;
 * otherwise returns {} so local plaintext brokers keep working untouched.
 */
export function kafkaSaslConfig() {
  const username = process.env.KAFKA_SASL_USERNAME;
  if (!username) return {};
  return {
    ssl: true,
    sasl: {
      mechanism: 'scram-sha-256' as const,
      username,
      password: process.env.KAFKA_SASL_PASSWORD ?? '',
    },
  };
}
