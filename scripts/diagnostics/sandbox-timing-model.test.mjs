import assert from 'node:assert/strict';
import test from 'node:test';
import { compactResource, observePod, analyzeCapture, runtimeOperations } from './sandbox-timing-model.mjs';

const at = seconds => new Date(Date.UTC(2026, 9, 3, 0, 0, seconds)).toISOString();
const cr = { uid: 'cr', name: 'cellbox-box-a', boxId: 'box-a', cycle: 1, createdAt: at(0), phase: 'Running', podUID: 'pod', since: at(3) };
const pod = { uid: 'pod', ownerUID: 'cr', name: 'cb-a-1', createdAt: at(1), gates: [], containers: [{ name: 'cellbox' }],
  containerStatuses: [{ name: 'cellbox', restartCount: 0, state: { running: { startedAt: at(3) } } }],
  conditions: [{ type: 'PodScheduled', status: 'True', lastTransitionTime: at(2) },
    { type: 'Ready', status: 'True', lastTransitionTime: at(54) }] };
const capture = { cellboxes: [cr], pods: [pod], events: [] };

test('gate sampling bounds separate runtime preparation from scheduler waiting', () => {
  let observed = observePod(undefined, { ...pod, gates: [{ name: 'prepared' }], conditions: [] }, at(1));
  observed = observePod(observed, { ...pod, conditions: [] }, at(2));
  observed = observePod(observed, pod, at(55));
  const r = analyzeCapture({ ...capture, observations: { pod: observed } })[0];
  const gate = r.stages.find(s => s.name === 'gate 放行 → 分配节点');
  assert.equal(gate.lowerMs, 0);
  assert.equal(gate.upperMs, 1000);
  assert.equal(observed.readyObservedDuringCapture, true);
});

test('a later Ready transition is flagged instead of presented as first startup, and old resume CR age is excluded', () => {
  const r = analyzeCapture(capture)[0];
  assert.ok(r.warnings.some(w => w.includes('存在就绪抖动')));
  assert.ok(r.warnings.some(w => w.includes('未采到初次 Ready')));
  assert.equal(r.stages.find(s => s.name === 'Pod 创建 → Controller Running 记录').durationMs, 2000);
  assert.equal(r.stages.find(s => s.name === '分配节点 → 容器启动（镜像/网络/runtime）').durationMs, 1000);
  const resumed = analyzeCapture({ ...capture, cellboxes: [{ ...cr, cycle: 2 }] })[0];
  assert.ok(!resumed.stages.some(s => s.name === 'Cellbox 创建 → Pod 创建'));
});

test('captures omit secret-bearing Pod fields and correlate restore candidate phases with the replacement box', () => {
  const result = compactResource({ kind: 'Pod', metadata: { uid: 'pod', annotations: { secret: 'annotation-secret' } },
    spec: { containers: [{ name: 'cellbox', args: ['argv-secret'], env: [{ name: 'TOKEN', value: 'env-secret' }],
      readinessProbe: { exec: { command: ['probe-secret'] }, periodSeconds: 2 } }] }, status: {} });
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(result.containers[0].readinessProbe.type, 'exec');
  const records = [
    { event: 'sandbox.operation_started', operationId: 'op', operation: 'restore', projectId: 'project', sandboxId: 'old' },
    { event: 'sandbox.operation_candidate', operationId: 'op', sandboxId: 'new' },
    { event: 'sandbox.operation_phase', operationId: 'op', sandboxId: 'old', phase: '恢复数据', durationMs: 1000 }
  ];
  assert.equal(runtimeOperations(records, 'new')[0].phases.length, 1);
  assert.equal(runtimeOperations(records, 'unrelated').length, 0);
});
