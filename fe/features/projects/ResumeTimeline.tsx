import type { ProjectResumeStage } from '../../../protocol/resume-types.js';
import type { ProjectResumeTimeline as Timeline } from './useProjects.js';
import './ResumeTimeline.css';

const stageLabels: Record<ProjectResumeStage, string> = {
  received: '收到恢复请求',
  preparing: '准备恢复',
  submitting: '提交恢复操作',
  accepted: '恢复操作已接受',
  running: '等待恢复端口',
  ports_listening: '等待端口已就绪',
  syncing: '同步项目状态',
  completed: '恢复完成',
};

function elapsed(value: number) {
  if (value < 1000) return `${Math.max(0, Math.round(value))} 毫秒`;
  return `${(value / 1000).toFixed(1)} 秒`;
}

const statusLabels = { running: '正在恢复', completed: '恢复完成', failed: '恢复失败', unknown: '结果未知' } as const;

export default function ResumeTimeline({ timeline }: { timeline?: Timeline }) {
  if (!timeline) return null;
  const recent = [...timeline.progress].reverse();
  const resumePath = recent.find(item => item.resumePath)?.resumePath;
  const resumePathLabel = resumePath === 'warm_pool' ? '本次命中预热池'
    : resumePath === 'standard' ? '常规恢复（未命中预热池）'
      : timeline.status === 'completed' ? '预热信息未上报' : undefined;
  const waitPorts = recent.find(item => item.waitPorts?.length)?.waitPorts;
  const operationId = recent.find(item => item.operationId)?.operationId;
  const remoteOperationId = recent.find(item => item.remoteOperationId)?.remoteOperationId;
  const remoteStatus = recent.find(item => item.remoteStatus)?.remoteStatus;
  const remoteStage = recent.find(item => item.remoteStage)?.remoteStage;
  const metadata = [
    resumePathLabel,
    waitPorts?.length ? `等待端口 ${waitPorts.join('、')}` : undefined,
    remoteStatus ? `Cellbox ${remoteStatus}` : undefined,
    remoteStage,
    operationId ? `操作 ${operationId}` : undefined,
    remoteOperationId ? `Cellbox 操作 ${remoteOperationId}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return <section className={`resume-timeline resume-timeline-${timeline.status}`} aria-label="恢复时间线" aria-live="polite">
    <details open={timeline.status === 'running'}>
      <summary>
        <span>{statusLabels[timeline.status]}</span>
        {timeline.status === 'running' && <span className="resume-timeline-spinner" aria-hidden="true" />}
        {timeline.progress.length > 0 && <span className="resume-timeline-elapsed">{elapsed(timeline.progress.at(-1)!.elapsedMs)}</span>}
      </summary>
      <ol>
        {timeline.progress.map((item, index) => <li key={item.sequence}>
          <span className="resume-timeline-stage">{stageLabels[item.stage] ?? item.stage}</span>
          <time dateTime={item.at} title={new Date(item.at).toLocaleString('zh-CN')}>+{elapsed(item.elapsedMs)}{index > 0 && ` · 阶段 ${elapsed(item.elapsedMs - timeline.progress[index - 1].elapsedMs)}`}</time>
        </li>)}
        {timeline.progress.length === 0 && timeline.status === 'running' && <li><span className="resume-timeline-stage">正在连接恢复服务</span></li>}
      </ol>
      {metadata.length > 0 && <p className="resume-timeline-metadata">{metadata.join(' · ')}</p>}
      {timeline.error && <p className="resume-timeline-error" role={timeline.status === 'unknown' ? 'status' : 'alert'}>
        {timeline.error.message}
        {timeline.status === 'unknown' && <span>请刷新项目状态确认结果；不会自动重试恢复请求。</span>}
        {timeline.error.code && <code>{timeline.error.code}</code>}
      </p>}
    </details>
  </section>;
}
