import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncQueue } from "../../src/infra/asyncQueue.js";

test("AsyncQueue: 多 worker 并发消费，每个元素只被消费一次", async () => {
  const queue = new AsyncQueue<number>();

  async function worker(sink: number[]) {
    while (true) {
      const next = await queue.next();
      if (next.done) {
        return;
      }
      sink.push(next.value);
    }
  }

  const consumed: number[] = [];
  const workers = Promise.all([worker(consumed), worker(consumed), worker(consumed)]);

  for (let i = 1; i <= 100; i += 1) {
    queue.enqueue(i);
  }
  queue.finish();
  await workers;

  consumed.sort((a, b) => a - b);
  assert.equal(consumed.length, 100);
  assert.deepEqual(consumed, Array.from({ length: 100 }, (_, index) => index + 1));
});

test("AsyncQueue: finish 唤醒等待中的 worker", async () => {
  const queue = new AsyncQueue<number>();

  const worker = (async () => {
    while (true) {
      const next = await queue.next();
      if (next.done) {
        return "done";
      }
    }
  })();

  queue.finish();
  assert.equal(await worker, "done");
});

test("AsyncQueue: 在 worker 等待前入队的元素按顺序消费", async () => {
  const queue = new AsyncQueue<number>();
  queue.enqueue(1);
  queue.enqueue(2);
  queue.finish();

  const first = await queue.next();
  const second = await queue.next();
  const third = await queue.next();

  assert.equal(first.done, false);
  assert.equal(second.done, false);
  assert.equal(third.done, true);
  if (!first.done) {
    assert.equal(first.value, 1);
  }
  if (!second.done) {
    assert.equal(second.value, 2);
  }
});

test("AsyncQueue: remove 只摘出仍在缓冲中的元素", async () => {
  const queue = new AsyncQueue<number>();
  queue.enqueue(1);
  queue.enqueue(2);
  queue.enqueue(3);

  const removed = queue.remove((n) => n === 2);
  assert.deepEqual(removed, [2]);

  const first = await queue.next();
  const second = await queue.next();

  if (!first.done) {
    assert.equal(first.value, 1);
  }
  if (!second.done) {
    assert.equal(second.value, 3);
  }
});
