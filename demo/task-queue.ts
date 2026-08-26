import { EventEmitter } from 'node:events';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Task<T> {
  id: string;
  payload: T;
  status: TaskStatus;
  attempts: number;
  createdAt: number;
  lastError?: unknown;
}

export interface QueueOptions {
  concurrency: number;
  maxAttempts: number;
  timeoutMs: number;
  backoffMs: number;
  backoffFactor: number;
}

const DEFAULT_OPTIONS: QueueOptions = {
  concurrency: 4,
  maxAttempts: 3,
  timeoutMs: 30_000,
  backoffMs: 500,
  backoffFactor: 2,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 順番待ちのタスクを一定数ずつ処理するだけの素朴なキュー。
 * 失敗したタスクは maxAttempts まで積み直す。
 *
 * 積み直しは指数バックオフで待つ。失敗が続くタスクが即座に
 * 並び直して、他のタスクの実行枠を奪い続けるのを防ぐため。
 */
export class TaskQueue<T> extends EventEmitter {
  private readonly options: QueueOptions;
  private readonly waiting: Task<T>[] = [];
  private readonly running = new Map<string, Task<T>>();
  private readonly idleWaiters: Array<() => void> = [];
  private seq = 0;

  constructor(
    private readonly handler: (payload: T) => Promise<void>,
    options: Partial<QueueOptions> = {},
  ) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get size(): number {
    return this.waiting.length + this.running.size;
  }

  push(payload: T): Task<T> {
    const task: Task<T> = {
      id: `task-${++this.seq}`,
      payload,
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
    };
    this.waiting.push(task);
    this.emit('push', task);
    this.pump();
    return task;
  }

  private pump(): void {
    while (this.running.size < this.options.concurrency) {
      const task = this.waiting.shift();
      if (!task) {
        if (this.running.size === 0) this.releaseIdleWaiters();
        return;
      }
      void this.run(task);
    }
  }

  /** timeoutMs を超えたハンドラは打ち切って失敗扱いにする */
  private async callHandler(task: Task<T>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`task ${task.id} timed out after ${this.options.timeoutMs}ms`)),
        this.options.timeoutMs,
      );
    });

    try {
      await Promise.race([this.handler(task.payload), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private backoffFor(attempts: number): number {
    return this.options.backoffMs * this.options.backoffFactor ** (attempts - 1);
  }

  private async run(task: Task<T>): Promise<void> {
    task.status = 'running';
    task.attempts += 1;
    this.running.set(task.id, task);
    this.emit('start', task);

    try {
      await this.callHandler(task);
      task.status = 'done';
      this.emit('done', task);
    } catch (error) {
      task.lastError = error;
      if (task.attempts < this.options.maxAttempts) {
        const wait = this.backoffFor(task.attempts);
        this.emit('retry', task, wait);
        task.status = 'pending';
        await sleep(wait);
        this.waiting.push(task);
      } else {
        task.status = 'failed';
        this.emit('failed', task, error);
      }
    } finally {
      this.running.delete(task.id);
      this.pump();
    }
  }

  private releaseIdleWaiters(): void {
    while (this.idleWaiters.length) {
      const resolve = this.idleWaiters.shift();
      resolve?.();
    }
  }

  async drain(): Promise<void> {
    if (this.size === 0) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }
}
