export const AGENT_GENERATION_BATCH_SIZE = 10;

export function chunkByAgentGenerationBatchSize<T>(items: T[]) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += AGENT_GENERATION_BATCH_SIZE) {
    chunks.push(items.slice(index, index + AGENT_GENERATION_BATCH_SIZE));
  }

  return chunks;
}
