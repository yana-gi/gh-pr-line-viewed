import { EventEmitter } from 'node:events';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Task<T> {
  id: string;
  payload: T;
  status: TaskStatus;
  attempts: number;
  createdAt: number;
}

export interface QueueOptions {
  concurrency: number;
  maxAttempts: number;
  timeoutMs: number;
}

const DEFAULT_OPTIONS: QueueOptions = {
  concurrency: 4,
  maxAttempts: 3,
  timeoutMs: 30_000,
};

/**
 * 順番待ちのタスクを一定数ずつ処理するだけの素朴なキュー。
 * 失敗したタスクは maxAttempts まで積み直す。
 */
export class TaskQueue<T> extends EventEmitter {
  private readonly options: QueueOptions;
  private readonly waiting: Task<T>[] = [];
  private readonly running = new Map<string, Task<T>>();
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
      if (!task) return;
      void this.run(task);
    }
  }

  private async run(task: Task<T>): Promise<void> {
    task.status = 'running';
    task.attempts += 1;
    this.running.set(task.id, task);
    console.log(`[queue] start ${task.id} (attempt ${task.attempts})`);

    try {
      await this.handler(task.payload);
      task.status = 'done';
      this.emit('done', task);
      console.log(`[queue] done ${task.id}`);
    } catch (error) {
      console.log(`[queue] failed ${task.id}`, error);
      if (task.attempts < this.options.maxAttempts) {
        task.status = 'pending';
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

  async drain(): Promise<void> {
    while (this.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
