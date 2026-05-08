import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_GENERATION_BATCH_SIZE, chunkByAgentGenerationBatchSize } from "../../src/services/runBatch.js";

test("chunkByAgentGenerationBatchSize limits Claude generation batches to 10 cases", () => {
  const items = Array.from({ length: 23 }, (_item, index) => `case-${index + 1}`);
  const chunks = chunkByAgentGenerationBatchSize(items);

  assert.equal(AGENT_GENERATION_BATCH_SIZE, 10);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [10, 10, 3],
  );
});
