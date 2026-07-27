import type { Bindings } from "./types";

// Shared by rate-batch/book-all/export-all: all three read and mutate
// overlapping shipment/quote/booking rows, so they're serialized under one
// lock rather than one per endpoint.
export const BATCH_OPERATIONS_LOCK = "batch_operations";

export class LockHeldError extends Error {
  constructor(lockName: string) {
    super(`"${lockName}" is already in progress — try again in a moment`);
  }
}

// D1 (SQLite) serializes writes to a single primary, so this insert-or-skip
// is race-free: at most one caller ever gets changes === 1 for a given name.
export async function withLock<T>(
  db: Bindings["DB"],
  lockName: string,
  holderId: number,
  fn: () => Promise<T>
): Promise<T> {
  const result = await db
    .prepare("INSERT INTO locks (name, acquired_by) VALUES (?, ?) ON CONFLICT(name) DO NOTHING")
    .bind(lockName, holderId)
    .run();

  if (result.meta.changes === 0) {
    throw new LockHeldError(lockName);
  }

  try {
    return await fn();
  } finally {
    await db.prepare("DELETE FROM locks WHERE name = ?").bind(lockName).run();
  }
}
