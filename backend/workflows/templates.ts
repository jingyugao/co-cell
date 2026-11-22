import { guidance, constraints, modulePlanningGuidance } from '../../packages/workflow/src/templates.js';
import { createHash, randomUUID } from 'node:crypto';
import manifest from '../../packages/workflow/third-party/superpowers/manifest.json' with { type: 'json' };
import { resultSchema, planSchema, modulePlanSchema } from '../../packages/workflow/src/index.js';
import { z } from 'zod';
import type { WorkflowJob, WorkflowRun, WorkflowRole, WorkflowPlanningMode } from '../../protocol/workflow-types.js';

// MySQL JSON normalizes object key order. A resumed attempt must reconstruct
// exactly the same prompt bytes and plan digest on a different API process.
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, v[key]])
        )
      : v
  );
}
export const digest = (v: string) => createHash('sha256').update(v).digest('hex');
export const version = manifest.commit;
export const outputSchema = (role: WorkflowRole, mode?: WorkflowPlanningMode) =>
  z.toJSONSchema(role !== 'plan' ? resultSchema : mode === 'modules' ? modulePlanSchema : planSchema, { target: 'draft-7' });
export const templateDigest = digest(
  canonical({ manifest, guidance, constraints, result: outputSchema('worker'), plan: outputSchema('plan') })
);
const moduleDigest = digest(canonical({ templateDigest, modulePlanningGuidance, plan: outputSchema('plan', 'modules') }));
export const digestForMode = (mode?: WorkflowPlanningMode) => mode === 'modules' ? moduleDigest : templateDigest;
export function job(
  run: WorkflowRun,
  role: WorkflowRole,
  key: string,
  instruction: string,
  dependencies: string[] = []
): WorkflowJob {
  return { id: randomUUID(), version: run.version, key, role, instruction, dependencies, attempts: [] };
}
export function designJobs(run: WorkflowRun, feedback: string) {
  if (run.planningMode === 'modules')
    return [job(run, 'plan', 'module-plan', feedback || '检查项目并拆解可交付的功能模块')];
  const lead = job(run, 'lead', 'baseline', feedback || '根据原始需求建立基线');
  const scouts = ['代码和协议', '测试和约束'].map((s, i) =>
    job(run, 'scout', 'scout-' + i, s + '\n' + feedback, [lead.id])
  );
  const designs = ['从现有架构演进', '独立评估替代设计'].map((s, i) =>
    job(
      run,
      'design',
      'design-' + i,
      s,
      [lead, ...scouts].map((j) => j.id)
    )
  );
  const reviews = ['架构和依赖', '权限、数据与恢复', '实施、测试与交付'].map((s, i) =>
    job(
      run,
      'review',
      'review-' + i,
      s,
      designs.map((j) => j.id)
    )
  );
  return [lead, ...scouts, ...designs, ...reviews];
}
export function promptFor(run: WorkflowRun, j: WorkflowJob, marker: string) {
  const inputs = j.dependencies.map((id) => {
    const d = run.jobs.find((x) => x.id === id)!;
    const attempt = d.attempts.at(-1);
    return {
      key: d.key,
      title: d.spec?.title,
      result: run.artifacts.find((a) => a.id === attempt?.artifactId)?.value,
      validation: attempt?.validation,
    };
  });
  const previous = j.attempts.filter((a) => a.id !== marker).at(-1);
  const retryFeedback = previous?.error ? '上一次尝试的校验反馈：' + previous.error : '';
  const plan = j.spec ? run.plans.at(-1) : undefined;
  return [
    `[workflow-attempt ${marker}]`,
    run.planningMode === 'modules' && j.role === 'plan' ? modulePlanningGuidance : guidance[j.role],
    run.requirement,
    j.instruction,
    retryFeedback,
    canonical({
      task: j.spec,
      planHash: plan?.hash,
      design: plan?.plan.design,
      contracts: plan?.plan.publicContracts,
      inputs,
    }),
    '使用指定的结构化输出。',
    constraints,
  ].join('\n\n');
}
