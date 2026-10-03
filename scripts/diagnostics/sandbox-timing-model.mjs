// Only retain diagnostic metadata. Pod argv/env and CR annotations can contain credentials.
export function compactResource(item) {
  const metadata = item.metadata ?? {}, spec = item.spec ?? {}, status = item.status ?? {};
  const base = { kind: item.kind, name: metadata.name, namespace: metadata.namespace,
    uid: metadata.uid, createdAt: metadata.creationTimestamp, deletedAt: metadata.deletionTimestamp };
  if (item.kind === 'Cellbox') return { ...base, boxId: metadata.labels?.['cellbox.local/box-id'],
    node: spec.nodeName, desiredState: spec.desiredState, cycle: status.cycle,
    phase: status.phase, message: status.message, since: status.since, podName: status.podName, podUID: status.podUID };
  return { ...base, ownerUID: metadata.ownerReferences?.find(ref => ref.kind === 'Cellbox' && ref.controller)?.uid,
    node: spec.nodeName, nodeSelector: spec.nodeSelector, gates: spec.schedulingGates ?? [],
    phase: status.phase, conditions: (status.conditions ?? []).map(({ type, status, reason, message, lastTransitionTime }) =>
      ({ type, status, reason, message, lastTransitionTime })),
    containers: (spec.containers ?? []).map(c => ({ name: c.name, image: c.image, resources: c.resources,
      readinessProbe: compactProbe(c.readinessProbe), startupProbe: compactProbe(c.startupProbe) })),
    containerStatuses: (status.containerStatuses ?? []).map(c => ({ name: c.name, restartCount: c.restartCount, state: c.state })) };
}

function compactProbe(probe) {
  if (!probe) return undefined;
  // exec commands and HTTP headers may contain secrets.
  return { initialDelaySeconds: probe.initialDelaySeconds, periodSeconds: probe.periodSeconds,
    timeoutSeconds: probe.timeoutSeconds, failureThreshold: probe.failureThreshold,
    successThreshold: probe.successThreshold, type: probe.exec ? 'exec' : probe.httpGet ? 'http' : probe.tcpSocket ? 'tcp' : 'grpc',
    port: probe.tcpSocket?.port ?? probe.httpGet?.port ?? probe.grpc?.port };
}

export function compactEvent(event) {
  const ref = event.involvedObject ?? event.regarding ?? {};
  return { uid: event.metadata?.uid, objectUID: ref.uid, name: ref.name, namespace: ref.namespace,
    reason: event.reason, type: event.type, message: event.message ?? event.note,
    firstAt: event.firstTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp,
    lastAt: event.series?.lastObservedTime ?? event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp,
    count: event.series?.count ?? event.count ?? 1 };
}

const time = value => value ? Date.parse(value) : NaN;
const condition = (pod, type) => pod.conditions?.find(c => c.type === type && c.status === 'True')?.lastTransitionTime;
const elapsed = (start, end) => Number.isFinite(time(start)) && Number.isFinite(time(end)) && time(end) >= time(start)
  ? time(end) - time(start) : null;

export function observePod(previous, pod, capturedAt) {
  const observed = { ...previous, firstSeenAt: previous?.firstSeenAt ?? capturedAt, lastSeenAt: capturedAt };
  if (pod.gates.length) {
    observed.gatedFirstSeenAt ??= capturedAt;
    observed.gatedLastSeenAt = capturedAt;
  } else observed.ungatedFirstSeenAt ??= capturedAt;
  // Preserve the first Ready timestamp seen during capture; current conditions can change later.
  observed.initiallyReady ??= Boolean(condition(pod, 'Ready'));
  if (!observed.readyAt && condition(pod, 'Ready')) {
    observed.readyAt = condition(pod, 'Ready');
    observed.readyObservedDuringCapture = Boolean(previous && !observed.initiallyReady);
  }
  return observed;
}

export function analyzeCapture(capture, boxId) {
  const reports = [];
  for (const cr of capture.cellboxes.filter(cr => !boxId || cr.boxId === boxId || cr.name === boxId)) {
    const pods = capture.pods.filter(p => p.ownerUID === cr.uid || p.uid === cr.podUID);
    if (!pods.length) reports.push({ boxId: cr.boxId, cr: cr.name, phase: cr.phase, node: cr.node,
      stages: [], warnings: [cr.message || '没有可用 Pod 历史；请在操作前启动 --watch。'],
      events: capture.events.filter(e => e.objectUID === cr.podUID) });
    for (const pod of pods) {
      const observed = capture.observations?.[pod.uid] ?? {};
      const events = capture.events.filter(e => e.objectUID === pod.uid).sort((a, b) => time(a.firstAt) - time(b.firstAt));
      const scheduled = condition(pod, 'PodScheduled') ?? events.find(e => e.reason === 'Scheduled')?.firstAt;
      const starts = (pod.containerStatuses ?? []).map(c => c.state?.running?.startedAt ?? c.state?.terminated?.startedAt).filter(Boolean);
      // Startup duration ends when all regular containers have started.
      const started = starts.length === pod.containers.length && starts.length ? starts.sort((a, b) => time(a) - time(b)).at(-1) : undefined;
      const ready = observed.readyAt ?? condition(pod, 'Ready');
      const warnings = [];
      const stages = [];
      function stage(name, from, to, note) {
        stages.push({ name, from, to, durationMs: elapsed(from, to), ...(note ? { note } : {}) });
      }
      if (cr.cycle === 1) stage('Cellbox 创建 → Pod 创建', cr.createdAt, pod.createdAt);
      else warnings.push('恢复运行的 CR 创建时间属于旧周期，不能当作本次操作起点。');
      stage('Pod 创建 → 分配节点（含 scheduling gate）', pod.createdAt, scheduled);
      if (observed.gatedLastSeenAt && observed.ungatedFirstSeenAt && scheduled) {
        const lowerMs = Math.max(0, time(scheduled) - time(observed.ungatedFirstSeenAt));
        const upperMs = Math.max(0, time(scheduled) - time(observed.gatedLastSeenAt));
        stages.push({ name: 'gate 放行 → 分配节点', lowerMs, upperMs,
          note: '放行时间位于最后一次 gated 与首次 ungated 采样之间，包含采样及请求延迟。' });
      } else warnings.push('gate 放行时间未知；Pod 创建到分配节点不能全归因于调度器。');
      const restarted = pod.containerStatuses?.some(c => c.restartCount > 0);
      stage('分配节点 → 容器启动（镜像/网络/runtime）', scheduled, restarted ? undefined : started);
      const readyLabel = observed.readyObservedDuringCapture ? '首次采到 Pod Ready' : '最近 Pod Ready（可能抖动）';
      stage(`容器启动 → ${readyLabel}`, restarted ? undefined : started, ready);
      stage(`Pod 创建 → ${readyLabel}`, pod.createdAt, ready);
      if (cr.phase === 'Running' && pod.uid === cr.podUID) {
        stage('Pod 创建 → Controller Running 记录', pod.createdAt, cr.since);
        if (time(cr.since) >= time(ready)) stage('Pod Ready → Controller Running', ready, cr.since);
        else if (ready) warnings.push('Controller Running 早于最近 Ready，存在就绪抖动或时钟差；最近 Ready 不能代表初次启动完成。');
      }
      if (restarted) warnings.push('容器发生过重启，当前 startedAt 无法还原初次启动耗时。');
      if (!observed.readyObservedDuringCapture) warnings.push('未采到初次 Ready 转换；当前 condition 只能说明最近的就绪时间。');
      if (!ready) warnings.push(`尚未 Ready：${pod.conditions?.find(c => c.type === 'PodScheduled' && c.status !== 'True')?.message ?? pod.containerStatuses?.find(c => c.state?.waiting)?.state.waiting.reason ?? pod.phase}`);
      if (pod.gates.length) warnings.push(`尚未放行 scheduling gate：${pod.gates.map(g => g.name).join(', ')}`);
      for (const reason of ['FailedScheduling', 'Unhealthy', 'FailedMount', 'FailedCreatePodSandBox', 'Failed', 'BackOff']) {
        if (events.some(e => e.reason === reason)) warnings.push(`${reason}：见事件时间线。`);
      }
      reports.push({ boxId: cr.boxId, cr: cr.name, phase: cr.phase, pod: pod.name, podUID: pod.uid,
        node: pod.node || cr.node, podPhase: pod.phase, stages, warnings, events,
        containers: pod.containers });
    }
  }
  return reports;
}

export function compactRuntimeRecord(record) {
  if (!['sandbox.operation_started', 'sandbox.operation_phase', 'sandbox.operation_candidate', 'sandbox.runtime_stage'].includes(record.event)) return null;
  const keys = ['event', 'timestamp', 'operationId', 'projectId', 'operation', 'phase', 'status',
    'startedAt', 'finishedAt', 'durationMs', 'totalDurationMs', 'sandboxId'];
  return Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
}

export function runtimeOperations(records, boxId) {
  const groups = new Map();
  for (const record of records) {
    if (!record.operationId) continue;
    const group = groups.get(record.operationId) ?? { operationId: record.operationId, projectId: record.projectId,
      operation: record.operation, sandboxIds: [], phases: [] };
    if (record.sandboxId && !group.sandboxIds.includes(record.sandboxId)) group.sandboxIds.push(record.sandboxId);
    if (record.event === 'sandbox.operation_phase') group.phases.push(record);
    if (record.event === 'sandbox.operation_started') group.startedAt = record.startedAt;
    groups.set(record.operationId, group);
  }
  return [...groups.values()].filter(group => !boxId || group.sandboxIds.includes(boxId));
}

export const seconds = ms => ms === null || ms === undefined ? '未知/未完成' : `${(ms / 1000).toFixed(3)}s`;
export function renderReport(capture, boxId) {
  const reports = analyzeCapture(capture, boxId);
  const lines = [`采样：${capture.capturedAt}  context=${capture.context ?? 'offline'} namespace=${capture.namespace ?? ''}`];
  for (const r of reports) {
    lines.push(`\n${r.boxId}  ${r.phase}  Pod=${r.pod ?? '不可用'}  node=${r.node ?? '未分配'}`);
    for (const s of r.stages) lines.push(`  ${s.name}: ${s.lowerMs !== undefined ? `${seconds(s.lowerMs)}–${seconds(s.upperMs)}` : seconds(s.durationMs)}`);
    for (const w of r.warnings) lines.push(`  提示：${w}`);
    for (const e of r.events) lines.push(`  ${e.firstAt} ${e.reason} ×${e.count}${e.count > 1 ? `（最近 ${e.lastAt}）` : ''} ${e.message}`);
  }
  if (!reports.length) lines.push('未找到匹配的 Cellbox。');
  for (const op of runtimeOperations(capture.runtimeRecords ?? [], boxId?.replace(/^cellbox-/, ''))) {
    lines.push(`\nCoCell ${op.operation} ${op.operationId} project=${op.projectId}`);
    for (const p of op.phases) lines.push(`  ${p.startedAt} ${p.phase}: ${seconds(p.durationMs)} (${p.status})`);
    const final = op.phases.at(-1);
    if (final) lines.push(`  总耗时：${seconds(final.totalDurationMs)}`);
  }
  const runtimeStages = (capture.runtimeRecords ?? []).filter(r => r.event === 'sandbox.runtime_stage' && (!boxId || r.sandboxId === boxId?.replace(/^cellbox-/, '')));
  if (runtimeStages.length) lines.push('\nRuntime 阶段（与 CoCell 阶段及彼此可能嵌套，不能相加）：');
  for (const r of runtimeStages) lines.push(`  ${r.startedAt} ${r.sandboxId ?? ''} ${r.phase}: ${seconds(r.durationMs)} (${r.status})`);
  for (const warning of capture.warnings ?? []) lines.push(`\n采集提示：${warning}`);
  return lines.join('\n');
}
