import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary } from '../../../protocol/types';
import type { WorkflowRun, WorkflowSummary, WorkflowPlan, WorkflowJob } from '../../../protocol/workflow-types';
import { api, errorMessage } from '../../lib/api';
import Markdown from '../chat/Markdown';
import './workflow.css';

const labels: Record<string, string> = {
  designing: '调查与设计',
  reviewing: '独立评审',
  discussing: '交叉讨论',
  awaiting_human: '等待人工决定',
  awaiting_approval: '待审批',
  executing: '并行实施',
  integrating: '集成',
  verifying: '最终验证',
  paused: '已暂停',
  blocked: '受阻',
  cancelling: '正在取消',
  cancelled: '已取消',
  completed: '已完成',
  preparing: '准备中',
  sending: '正在提交',
  running: '运行中',
  unknown: '结果未知',
  checking: '验证中',
  succeeded: '通过',
  failed: '失败',
};
const label = (s: string) => labels[s] ?? s;
const base = '/api/workflow-runs';
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

function PlanView({ plan }: { plan: WorkflowPlan }) {
  const tasks = plan.plan.tasks;
  const graph = [
    'flowchart TD',
    ...tasks.map((t, i) => 'n' + i + '["' + t.key + '"]'),
    ...tasks.flatMap((t, i) =>
      t.dependsOn.map((key) => 'n' + tasks.findIndex((x) => x.key === key) + ' --> n' + i)
    ),
  ].join('\n');
  return (
    <article className="wf-plan">
      <h3>计划 v{plan.version}</h3>
      <code className="wf-hash">{plan.hash}</code>
      <Markdown text={plan.plan.design} />
      <h4>备选方案与评审意见</h4>
      <Markdown text={plan.plan.alternatives + '\n\n' + plan.plan.reviewDecisions} />
      <h4>风险与公共契约</h4>
      <Markdown text={plan.plan.risks} />
      <code>{plan.plan.publicContracts.join(', ') || '无公共契约变更'}</code>
      <details>
        <summary>任务依赖图</summary>
        <Markdown text={'```mermaid\n' + graph + '\n```'} />
      </details>
      {tasks.map((t) => (
        <section key={t.key}>
          <h4>
            {t.key} · {t.role}
          </h4>
          <p>{t.description}</p>
          <dl>
            <dt>依赖</dt>
            <dd>{t.dependsOn.join(', ') || '无'}</dd>
            <dt>写入</dt>
            <dd>{t.ownedPaths.join(', ') || '只读'}</dd>
            <dt>读取</dt>
            <dd>{t.readPaths.join(', ') || '—'}</dd>
            <dt>验收</dt>
            <dd>{t.acceptance}</dd>
            <dt>验证命令</dt>
            <dd>
              <code>{JSON.stringify(t.validation.argv)}</code>
            </dd>
            <dt>验证环境</dt>
            <dd>
              {t.validation.cwd} · {t.validation.timeoutMs / 1000} 秒 · 输出路径{' '}
              {t.validation.outputPaths.join(', ') || '无'}
            </dd>
          </dl>
        </section>
      ))}
    </article>
  );
}

function JobView({ j, run, retry }: { j: WorkflowJob; run: WorkflowRun; retry: (id: string) => void }) {
  const current = j.attempts.at(-1);
  return (
    <details className="wf-job">
      <summary>
        <span>{j.key}</span>
        <small>{current ? label(current.status) : '等待依赖'}</small>
      </summary>
      <p>{j.instruction}</p>
      {j.dependencies.length > 0 && (
        <p>依赖 {j.dependencies.map((id) => run.jobs.find((d) => d.id === id)?.key).join(', ')}</p>
      )}
      {j.attempts.map((a) => (
        <section key={a.id}>
          <h4>
            尝试 {a.ordinal} · {label(a.status)}
          </h4>
          <a href={'/sessions/' + a.sessionId}>查看会话</a>
          {a.error && <p role="status">{a.error}</p>}
          {a.validation && (
            <>
              <p>
                命令验证 · {label(a.validation.status)}
                {a.validation.exitCode != null ? ' · 退出码 ' + a.validation.exitCode : ''}
              </p>
              <pre>{a.validation.output}</pre>{a.validation.outputTruncated && <small>验证输出已截断</small>}
            </>
          )}
          {run.artifacts
            .filter((v) => v.id === a.artifactId)
            .map((v) => (
              <div key={v.id}>
                {'summary' in v.value ? (
                  <>
                    <Markdown text={v.value.summary} />
                    {v.value.evidence.map((e, i) => (
                      <p key={i}>{e}</p>
                    ))}
                    {v.value.concerns.map((e, i) => (
                      <p key={i}>分歧 · {e}</p>
                    ))}
                  </>
                ) : (
                  <Markdown text={v.value.design} />
                )}
              </div>
            ))}
        </section>
      ))}
      {current?.status === 'failed' && run.status === 'blocked' && j.version === run.version && (
        <button onClick={() => retry(j.id)}>重新尝试</button>
      )}
    </details>
  );
}

export default function WorkflowPage({ runId, projectId }: { runId?: string; projectId?: string }) {
  const [run, setRun] = useState<WorkflowRun>(),
    [rows, setRows] = useState<WorkflowSummary[]>([]),
    [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [requirement, setRequirement] = useState(''),
    [parallelism, setParallelism] = useState(2),
    [reason, setReason] = useState('');
  const [tab, setTab] = useState('任务'),
    [error, setError] = useState(''),
    [readError, setReadError] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [selectedProject, setSelectedProject] = useState(projectId ?? '');
  const mutation = useRef(false),
    createKey = useRef<{ input: string; id: string } | null>(null),
    generation = useRef(0);
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function load() {
      const at = ++generation.current;
      let finished = false;
      try {
        if (runId) {
          const value = await api<WorkflowRun>(base + '/' + runId, { signal: controller.signal });
          finished = ['completed', 'cancelled'].includes(value.status);
          if (live && at === generation.current) setRun((r) => (!r || value.revision >= r.revision ? value : r));
        } else {
          const list = await api<WorkflowSummary[]>(base + (projectId ? '?projectId=' + projectId : ''), {
            signal: controller.signal,
          });
          if (live) setRows(list);
        }
        if (live) setReadError('');
      } catch (e) {
        if (live) setReadError(errorMessage(e));
      } finally {
        if (live) {
          setLoading(false);
          if (!finished) timer = setTimeout(load, document.hidden ? 15000 : 3000);
        }
      }
    }
    void load();
    if (!runId)
      void api<ProjectSummary[]>('/api/projects', { signal: controller.signal })
        .then((ps) => {
          if (live) setProjects(ps.filter((p) => p.executionMode === 'sandbox' && p.status === 'active'));
        })
        .catch((e) => {
          if (live) setReadError(errorMessage(e));
        });
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId, projectId]);
  async function submit(path: string, body: Record<string, unknown>, create = false) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    try {
      const signature = JSON.stringify(body);
      if (create && createKey.current?.input !== signature)
        createKey.current = { input: signature, id: crypto.randomUUID() };
      const receipt = await api<{ id: string; revision: number }>(
        path,
        post({ ...body, clientRequestId: create ? createKey.current!.id : crypto.randomUUID() })
      );
      if (create) location.assign('/workflows/' + receipt.id);
      else {
        ++generation.current;
        const value = await api<WorkflowRun>(base + '/' + runId);
        setRun((r) => (!r || value.revision >= r.revision ? value : r));
        setReason('');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  const act = (path: string, data: Record<string, unknown> = {}) =>
    run && void submit(base + '/' + run.id + '/' + path, { expectedRevision: run.revision, ...data });
  const plan = run?.plans.at(-1);
  const finished = run && ['completed', 'cancelled'].includes(run.status);
  return (
    <main className="workflow-page">
      <div className="wf-wrap">
        <nav>
          <a href="/#projects">项目</a>
          <span>/</span>
          <a href="/workflows">多 agent 工作台</a>
        </nav>
        <header>
          <h1>{run ? '工作流详情' : projectId ? '创建项目工作流' : '多 agent 工作台'}</h1>
          {run && <span className="wf-state">{label(run.status)}</span>}
        </header>
        {(error || readError) && (
          <p role="alert" className="wf-alert">
            {error || readError}
          </p>
        )}
        {!runId && (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit(
                  base,
                  { requirement: requirement.trim(), projectId: selectedProject, parallelism },
                  true
                );
              }}
            >
              <label>
                项目
                <select required value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
                  <option value="">选择 Sandbox 项目</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                需求
                <textarea
                  required
                  maxLength={12000}
                  value={requirement}
                  onChange={(e) => setRequirement(e.target.value)}
                  rows={4}
                />
              </label>
              <div className="wf-controls">
                <label>
                  并行会话
                  <select value={parallelism} onChange={(e) => setParallelism(Number(e.target.value))}>
                    {[1, 2, 3, 4].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <button className="primary-button" disabled={busy || !selectedProject || !requirement.trim()}>
                  开始只读设计
                </button>
              </div>
            </form>
            <h2>工作流</h2>
            {!loading && !rows.length && <p>暂无工作流</p>}
            {rows.map((r) => (
              <a className="wf-row" href={'/workflows/' + r.id} key={r.id}>
                <strong>{r.requirement}</strong>
                <small>{label(r.status)}</small>
              </a>
            ))}
          </>
        )}
        {loading && <p role="status">加载中…</p>}
        {run && (
          <>
            <p className="wf-requirement">{run.requirement}</p>
            <p className="wf-meta">
              计划 v{run.version} · {run.model} · 最多 {run.parallelism} 个并行会话 ·{' '}
              <a href={'/projects/' + run.projectId + '/files'}>项目文件</a>
            </p>
            {run.attention && <p className="wf-alert">{run.attention}</p>}
            <p className="wf-note">会话共享项目工作区。其他会话的文件改动可能触发所有权冲突。</p>
            <div className="wf-tabs" aria-label="工作流视图">
              {['任务', '计划与审批', '时间线'].map((v) => (
                <button key={v} aria-pressed={v === tab} onClick={() => setTab(v)}>
                  {v}
                </button>
              ))}
            </div>
            {tab === '任务' && (
              <>
                <h2>任务与会话</h2>
                {run.jobs.map((j) => (
                  <JobView key={j.id} j={j} run={run} retry={(id) => act('tasks/' + id + '/retry')} />
                ))}
              </>
            )}
            {tab === '计划与审批' && (
              <>
                {!run.plans.length && <p>方案评审结束后，冻结的计划会显示在这里。</p>}
                {run.plans.map((p) => (
                  <PlanView key={p.id} plan={p} />
                ))}
                {run.decisions.map((d) => (
                  <p key={d.id}>
                    {d.actor} · {d.decision} · {d.reason} · {d.at}
                  </p>
                ))}
              </>
            )}
            {tab === '时间线' && (
              <ol className="wf-timeline">
                {run.events.map((e) => (
                  <li key={e.sequence}>
                    <time>{new Date(e.at).toLocaleString()}</time>
                    {e.message}
                  </li>
                ))}
              </ol>
            )}
            {!finished && (
              <section className="wf-actions">
                <h2>{run.status === 'awaiting_approval' ? '计划审批' : '工作流操作'}</h2>
                <label>
                  决定或修改意见
                  <textarea rows={2} maxLength={6000} value={reason} onChange={(e) => setReason(e.target.value)} />
                </label>
                <fieldset disabled={busy}>
                  {run.status === 'awaiting_approval' &&
                    plan &&
                    (tab !== '计划与审批' ? (
                      <button onClick={() => setTab('计划与审批')}>查看计划并审批</button>
                    ) : (
                      (['approve', 'request-changes', 'reject'] as const).map((decision, i) => (
                        <button
                          key={decision}
                          onClick={() =>
                            act('approvals/' + plan.approvalId + '/decisions', {
                              planId: plan.id,
                              planHash: plan.hash,
                              approvalRevision: plan.approvalRevision,
                              decision,
                              reason,
                            })
                          }
                        >
                          {['批准 v' + plan.version, '要求修改', '驳回'][i]}
                        </button>
                      ))
                    ))}
                  {['designing', 'reviewing', 'discussing', 'executing', 'integrating', 'verifying'].includes(
                    run.status
                  ) && <button onClick={() => act('pause')}>暂停调度</button>}
                  {['paused', 'awaiting_human', 'blocked'].includes(run.status) && (
                    <button
                      disabled={run.status === 'awaiting_human' && !reason.trim()}
                      onClick={() => act(run.status === 'blocked' ? 'reconcile' : 'resume', { reason })}
                    >
                      {run.status === 'blocked' ? '重新核对状态' : '继续调度'}
                    </button>
                  )}
                  {run.status !== 'cancelling' && (
                    <>
                      <button disabled={!reason.trim()} onClick={() => act('design/revise', { reason })}>
                        修订计划
                      </button>
                      <button onClick={() => act('cancel')}>取消工作流</button>
                    </>
                  )}
                </fieldset>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
