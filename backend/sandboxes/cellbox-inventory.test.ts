import assert from 'node:assert/strict';
import test from 'node:test';
import type { CellboxSandboxProvider } from '../../packages/sandbox/src/providers/cellbox/index.js';
import { CellboxSandboxInventory } from './cellbox-inventory.js';
import { sandboxInventoryLabel } from '../../util/sandbox-inventory.js';

test('inventory keeps each Kubernetes and OSS resource and displays intermediate phases', async () => {
  const phases = ['creating', 'checkpointing', 'suspending', 'suspended', 'resuming', 'restoring', 'staged', 'failed', 'deleting', 'deleted'];
  const rows = phases.map(phase => ({ id: `box-${phase}`, profileId: 'k8s', phase, image: 'image', createdAt: '2026-10-01T00:00:00Z' }));
  const provider = { listInventory: async () => ({ boxes: rows, checkpoints: rows }) } as unknown as CellboxSandboxProvider;
  const data = await new CellboxSandboxInventory(provider).read([]);
  assert.equal(data.sandboxes.length, phases.length * 2);
  assert.deepEqual(data.sandboxes.filter(box => box.inventorySource === 'kubernetes').map(box => box.phase), phases);
  assert.deepEqual(data.sandboxes.filter(box => box.inventorySource === 'oss').map(box => box.phase), phases);
  assert.equal(sandboxInventoryLabel(data.sandboxes[1]), '保存快照中');
  assert.equal(sandboxInventoryLabel(data.sandboxes[4]), '恢复中');
  assert.equal(sandboxInventoryLabel(data.sandboxes[8]), '删除中');
});
