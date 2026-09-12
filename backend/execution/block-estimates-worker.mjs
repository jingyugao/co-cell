import { parentPort, workerData } from 'node:worker_threads';
import { getEncoding } from 'js-tiktoken';
const encoding = getEncoding('o200k_base');
const counts = new Map();
parentPort.postMessage(workerData.map(turn => ({ ...turn, contextUsage: turn.contextUsage?.map(({ blockTexts, ...usage }) => ({
  ...usage, blockTokenizer: 'js-tiktoken/o200k_base@1.0.21',
  blockEstimates: blockTexts?.map(block => {
    let tokens = counts.get(block.id);
    if (tokens === undefined) { tokens = encoding.encode(block.text, [], []).length; counts.set(block.id, tokens); }
    return { id: block.id, label: block.label, turnId: block.turnId, itemId: block.text === workerData.find(value => value.id === block.turnId)?.prompt ? 'user-input' : block.itemId, inputTokens: block.direction === 'input' ? tokens : 0, outputTokens: block.direction === 'output' ? tokens : 0 };
  }),
})) })));
