/**
 * Per-key serialized task queues: tasks queued under the same key run strictly
 * in order (so a slow earlier task can't clobber a faster later one), while
 * different keys proceed independently. Tasks are expected to handle their own
 * errors — a rejection poisons that key's chain.
 */
export interface SerialQueues {
  enqueue(key: string, task: () => Promise<void>): void;
  /** Resolves once every queued task has settled — for clean shutdown. */
  drain(): Promise<void>;
}

export function createSerialQueues(): SerialQueues {
  const tails = new Map<string, Promise<void>>();

  return {
    enqueue(key, task) {
      const prev = tails.get(key) ?? Promise.resolve();
      const next = prev.then(task);
      tails.set(key, next);
      void next.finally(() => {
        if (tails.get(key) === next) tails.delete(key);
      });
    },

    async drain() {
      while (tails.size > 0) {
        await Promise.allSettled([...tails.values()]);
      }
    },
  };
}
