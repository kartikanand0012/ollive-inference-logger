// Kafka topology constants. infra/kafka-init/index.js (standalone plain-JS
// image) duplicates the names/partition counts — keep them in sync.

export const TOPIC_EVENTS = 'inference.events';
export const TOPIC_DLQ = 'inference.dlq';

/** Partitions on inference.events = max parallel workers without repartitioning. */
export const EVENTS_PARTITIONS = 6;

export const CONSUMER_GROUP_WRITERS = 'inference-writers';
