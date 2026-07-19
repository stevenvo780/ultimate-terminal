interface PendingItem<T> {
  value: T;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface RelayState<T> {
  pending: PendingItem<T>[];
  running: boolean;
}

/**
 * Serializes async relay work per key while batching items that arrive during
 * the same authorization check. Different keys remain independent.
 */
export class OrderedRelayQueue<T> {
  private readonly states = new Map<string, RelayState<T>>();

  enqueue(key: string, value: T, consume: (batch: T[]) => Promise<void>): Promise<void> {
    let state = this.states.get(key);
    if (!state) {
      state = { pending: [], running: false };
      this.states.set(key, state);
    }

    const completion = new Promise<void>((resolve, reject) => {
      state!.pending.push({ value, resolve, reject });
    });

    if (!state.running) {
      state.running = true;
      queueMicrotask(() => { void this.drain(key, state!, consume); });
    }
    return completion;
  }

  private async drain(
    key: string,
    state: RelayState<T>,
    consume: (batch: T[]) => Promise<void>
  ): Promise<void> {
    while (state.pending.length > 0) {
      const batch = state.pending.splice(0);
      try {
        await consume(batch.map((item) => item.value));
        batch.forEach((item) => item.resolve());
      } catch (error) {
        batch.forEach((item) => item.reject(error));
      }
    }
    state.running = false;
    if (state.pending.length === 0) {
      this.states.delete(key);
      return;
    }
    state.running = true;
    queueMicrotask(() => { void this.drain(key, state, consume); });
  }
}
