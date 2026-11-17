/** A single FIFO lane for writes made by the dashboard and each automation entry point. */
export interface ProfileWriteLease {
  release(): void;
}

type Waiter = { grant(): void; cancel(): void };

export class ProfileWrites {
  private readonly held = new Set<string>();
  private readonly waiting = new Map<string, Waiter[]>();

  busy(profileId: string): boolean { return this.held.has(profileId); }

  tryAcquire(profileId: string): ProfileWriteLease | undefined {
    if (this.held.has(profileId)) return;
    this.held.add(profileId);
    return this.lease(profileId);
  }

  async acquire(profileId: string, signal?: AbortSignal): Promise<ProfileWriteLease> {
    signal?.throwIfAborted();
    const lease = this.tryAcquire(profileId);
    if (lease) return lease;
    const queue = this.waiting.get(profileId) ?? [];
    this.waiting.set(profileId, queue);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener("abort", waiter.cancel);
          resolve(this.lease(profileId));
        },
        cancel: () => {
          const index = queue.indexOf(waiter);
          if (index < 0) return;
          queue.splice(index, 1);
          if (!queue.length) this.waiting.delete(profileId);
          reject(signal?.reason);
        },
      };
      queue.push(waiter);
      signal?.addEventListener("abort", waiter.cancel, { once: true });
    });
  }

  async run<T>(profileId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lease = await this.acquire(profileId, signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      lease.release();
    }
  }

  private lease(profileId: string): ProfileWriteLease {
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      const queue = this.waiting.get(profileId);
      const next = queue?.shift();
      if (!queue?.length) this.waiting.delete(profileId);
      if (next) next.grant();
      else this.held.delete(profileId);
    } };
  }
}
