/**
 * Small generic FIFO write barrier used by SessionContext. Captured jobs are
 * never recomputed after a failure: the failed head remains pending, later
 * jobs cannot leapfrog it, and waitForIdle blocks session replacement until
 * every captured mutation commits.
 */
export class FifoPersistenceQueue<State, Job> {
  private committed: State;
  private readonly entries: Array<{ job: Job; resolve: () => void }> = [];
  private readonly idleWaiters: Array<() => void> = [];
  private writing = false;

  constructor(
    initialState: State,
    private readonly commit: (job: Job, committedBefore: State) => Promise<State>,
    private readonly onError: (error: unknown | null) => void,
  ) {
    this.committed = initialState;
  }

  get pendingCount(): number {
    return this.entries.length;
  }

  /** Safe only between sessions, after waitForIdle has resolved. */
  resetCommitted(state: State): void {
    if (this.entries.length > 0 || this.writing) {
      throw new Error('Cannot reset persistence state while writes are pending');
    }
    this.committed = state;
  }

  enqueue(job: Job): Promise<void> {
    return new Promise<void>((resolve) => {
      this.entries.push({ job, resolve });
      void this.drain();
    });
  }

  retry(): void {
    this.onError(null);
    void this.drain();
  }

  waitForIdle(): Promise<void> {
    if (this.entries.length === 0 && !this.writing) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.entries.length > 0) {
        const entry = this.entries[0];
        try {
          this.committed = await this.commit(entry.job, this.committed);
          this.entries.shift();
          entry.resolve();
          this.onError(null);
          if (this.entries.length === 0) {
            for (const resolveIdle of this.idleWaiters.splice(0)) resolveIdle();
          }
        } catch (error) {
          this.onError(error);
          break;
        }
      }
    } finally {
      this.writing = false;
    }
  }
}
