import { v7 as uuidv7 } from 'uuid';

/** Time-sortable request ids → btree-friendly inserts on the unique index. */
export function newRequestId(): string {
  return uuidv7();
}
