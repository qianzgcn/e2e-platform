// 异步队列：生产端 enqueue/finish，多个消费 worker 通过 next() 竞争消费，
// 每个元素只会被消费一次。需要在停止时摘出尚未执行的元素，用 remove。
export type AsyncQueueNext<T> = { value: T; done: false } | { done: true };

export class AsyncQueue<T> {
  private items: T[] = [];
  private finished = false;
  private waiters: Array<(next: AsyncQueueNext<T>) => void> = [];

  // 入队：有 worker 在等就直接交付，否则进缓冲队列。
  enqueue(item: T): void {
    if (this.waiters.length > 0) {
      this.waiters.shift()!({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  // 标记不再有新元素入队，并唤醒所有等待中的 worker（让它们收到 done 退出）。
  finish(): void {
    this.finished = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ done: true });
    }
  }

  // 取下一个元素；缓冲为空且未结束时挂起，直到 enqueue 或 finish。
  async next(): Promise<AsyncQueueNext<T>> {
    if (this.items.length > 0) {
      return { value: this.items.shift()!, done: false };
    }
    if (this.finished) {
      return { done: true };
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  // 移除所有满足条件的缓冲元素（已交付给 worker 执行中的不在内）。停止用例时调用。
  remove(predicate: (item: T) => boolean): T[] {
    const removed = this.items.filter(predicate);
    this.items = this.items.filter((item) => !predicate(item));
    return removed;
  }
}
