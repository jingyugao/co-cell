import { useEffect, useState } from 'react';
import type { AgentProfile, RemoteSkill } from '../../../protocol/agent-profile-types';
import type { ProjectSummary } from '../../../protocol/types';
import { api } from '../../lib/api';
import FileEditor from './SharedFilesPage';

export default function AgentManagement({
  onMenu,
  onDirtyChange,
  projects,
}: {
  onMenu: () => void;
  onDirtyChange: (dirty: boolean) => void;
  projects: ProjectSummary[];
}) {
  const [agents, setAgents] = useState<AgentProfile[]>([]),
    [id, setId] = useState('default');
  const [mode, setMode] = useState<'' | 'create' | 'rename' | 'import'>('');
  const [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [copy, setCopy] = useState(false);
  const [repository, setRepo] = useState(''),
    [directory, setDir] = useState(''),
    [ref, setRef] = useState('HEAD');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [dirty, setDirty] = useState(false);
  const [generation, reloadEditor] = useState(0);
  const agent = agents.find((a) => a.id === id);
  const used = projects.filter((p) => (p.agentProfileId ?? 'default') === id);
  async function refresh() {
    setAgents(await api<AgentProfile[]>('/api/agents'));
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    onDirtyChange(dirty || mode !== '');
    return () => onDirtyChange(false);
  }, [dirty, mode, onDirtyChange]);
  function discard() {
    return !(dirty || mode) || window.confirm('放弃未保存的修改？');
  }
  function start(next: typeof mode) {
    if (!discard()) return;
    if (dirty) reloadEditor((n) => n + 1);
    setMode(next);
    setError('');
    setName(next === 'rename' ? agent!.name : '');
    setDescription(next === 'rename' ? agent!.description : '');
    setRepo('');
    setDir('');
    setRef('HEAD');
    setCopy(false);
  }
  async function mutate(action: () => Promise<AgentProfile>) {
    setBusy(true);
    setError('');
    try {
      const saved = await action();
      setAgents((old) => [...old.filter((a) => a.id !== saved.id), saved]);
      setId(saved.id);
      setMode('');
      reloadEditor((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  function importSkill(source: Omit<RemoteSkill, 'commit'>) {
    return api<AgentProfile>('/api/agents/' + id + '/remote-skills', {
      method: 'POST',
      body: JSON.stringify({ ...source, expectedRevision: agent!.revision }),
    });
  }
  return (
    <main className="main-pane shared-files-page">
      <header className="topbar">
        <button className="icon-button mobile-only" aria-label="打开导航" onClick={onMenu}>
          ☰
        </button>
        <div className="breadcrumbs">
          <span>工作空间</span>
          <span>/</span>
          <strong>Agent 管理</strong>
        </div>
      </header>
      <div className="shared-files-scroll">
        <div className="shared-files-heading">
          <h1>Agent 管理</h1>
          <button className="primary-button" disabled={busy} onClick={() => start('create')}>
            新建 Agent
          </button>
        </div>
        <div className="agent-toolbar">
          <label>
            当前 Agent
            <select
              value={id}
              disabled={busy}
              onChange={(e) => {
                if (discard()) {
                  setId(e.target.value);
                  setMode('');
                  setError('');
                }
              }}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          {agent && (
            <>
              <button className="secondary-button" disabled={busy} onClick={() => start('rename')}>
                编辑名称与说明
              </button>
              <button className="secondary-button" disabled={busy} onClick={() => start('import')}>
                导入 GitHub skill
              </button>
            </>
          )}
        </div>
        {agent?.description && <p>{agent.description}</p>}
        {agent && <p className="agent-usage">使用项目 · {used.map((p) => p.name).join('、') || '暂无'}</p>}
        {error && (
          <p className="shared-files-error" role="alert">
            {error}{' '}
            <button
              onClick={() =>
                void refresh()
                  .then(() => setError(''))
                  .catch((e) => setError(e.message))
              }
            >
              刷新
            </button>
          </p>
        )}
        {mode && (
          <form
            className="agent-config-form"
            onSubmit={(e) => {
              e.preventDefault();
              void mutate(() =>
                mode === 'import'
                  ? importSkill({ name, repository, directory, ref })
                  : api<AgentProfile>(mode === 'create' ? '/api/agents' : '/api/agents/' + id, {
                      method: mode === 'create' ? 'POST' : 'PATCH',
                      body: JSON.stringify({
                        name,
                        description,
                        ...(mode === 'create' && copy ? { copyFrom: id } : {}),
                      }),
                    }),
              );
            }}
          >
            <label>
              {mode === 'import' ? 'Skill 名称' : 'Agent 名称'}
              <input
                value={name}
                required
                maxLength={mode === 'import' ? 64 : 100}
                pattern={mode === 'import' ? '[a-z0-9][a-z0-9\\-]{0,63}' : undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {mode === 'import' ? (
              <>
                <label>
                  GitHub 仓库
                  <input
                    required
                    type="url"
                    placeholder="https://github.com/owner/repo"
                    value={repository}
                    onChange={(e) => setRepo(e.target.value)}
                  />
                </label>
                <label>
                  Skill 子目录
                  <input
                    placeholder="含 SKILL.md 的目录，仓库根目录可留空"
                    value={directory}
                    onChange={(e) => setDir(e.target.value)}
                  />
                </label>
                <label>
                  分支、标签或 commit
                  <input required value={ref} onChange={(e) => setRef(e.target.value)} />
                </label>
              </>
            ) : (
              <>
                <label>
                  说明
                  <input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
                </label>
                {mode === 'create' && agent && (
                  <label>
                    <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
                    复制「{agent.name}」的规则与 skills
                  </label>
                )}
              </>
            )}
            <div>
              <button disabled={busy} className="primary-button">
                {busy ? '处理中…' : mode === 'import' ? '导入' : '保存'}
              </button>{' '}
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setMode('')}>
                取消
              </button>
            </div>
          </form>
        )}
        {agent && !mode && (
          <>
            {agent.remoteSkills.length > 0 && (
              <section aria-label="远程 skills">
                <h3>远程 skills</h3>
                {agent.remoteSkills.map((s) => (
                  <div className="agent-source" key={s.name}>
                    <strong>{s.name}</strong>{' '}
                    <a
                      href={
                        s.repository +
                        '/tree/' +
                        s.commit +
                        '/' +
                        s.directory.split('/').map(encodeURIComponent).join('/')
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      {s.repository.replace('https://github.com/', '')} · {s.commit.slice(0, 8)}
                    </a>{' '}
                    <button
                      disabled={busy}
                      className="secondary-button"
                      onClick={() => {
                        if (discard())
                          void mutate(() =>
                            importSkill({ name: s.name, repository: s.repository, ref: s.ref, directory: s.directory }),
                          );
                      }}
                    >
                      从远程更新
                    </button>
                  </div>
                ))}
              </section>
            )}
            <FileEditor
              key={id + ':' + generation}
              profileId={id}
              onDirtyChange={setDirty}
              onSaved={refresh}
              onDeleteSkill={async (name) => {
                const saved = await api<AgentProfile>('/api/agents/' + id + '/skills/' + encodeURIComponent(name), {
                  method: 'DELETE',
                  body: JSON.stringify({ expectedRevision: agent.revision }),
                });
                setAgents((old) => old.map((a) => (a.id === id ? saved : a)));
                reloadEditor((n) => n + 1);
              }}
            />
          </>
        )}
      </div>
    </main>
  );
}
