import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppConfig, ProjectSummary } from '../../../protocol/types.js';
import ProjectsPage from './ProjectsPage.js';

const now = '2026-09-20T10:00:00.000Z';
const backup = { createdAt: now, sizeBytes: 42, sha256: 'a'.repeat(64) };

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'project-1', name: '项目', requirementUrl: null, executionMode: 'sandbox', workingDirectory: '/workspace',
    createdAt: now, updatedAt: now, sessionCount: 0, activeSessionId: null,
    ...overrides,
  };
}

function page(projects: ProjectSummary[], initialView?: 'active' | 'completed' | 'archived', config: AppConfig | null = null) {
  return renderToStaticMarkup(<ProjectsPage
    projects={projects} config={config} loading={false} initialView={initialView}
    onRefresh={async () => projects} onCreate={async () => project()} onUpdate={async () => project()}
    onCreateSandbox={async () => project()} onRestoreSandbox={async () => project()} onReleaseSandbox={async () => project()} onResumeSandbox={async () => project()} onCheckpointSandbox={async () => project()} onBackupSandbox={async () => project()} onArchiveProject={async () => project()}
    onOpenProject={() => {}} onMenu={() => {}} onBack={() => {}}
  />);
}

test('ready sandbox offers a Checkpoint without starting a disk backup', () => {
  const html = page([project({ sandbox: { id: 'current', status: 'ready', template: 'default', workingDirectory: '/workspace' }, latestBackup: backup })]);
  assert.match(html, /就绪/);
  assert.match(html, /Checkpoint · 暂停/);
  assert.match(html, /aria-label="项目操作"/);
  assert.match(html, /aria-label="Sandbox 操作"/);
  assert.doesNotMatch(html, /立即备份/);
  assert.doesNotMatch(html, /归档项目/);
  assert.match(html, /最新备份/);
  assert.doesNotMatch(html, /查看归档|备份记录|历史备份/);
});

test('a backup from within the past hour is shown in minutes', () => {
  const recentBackup = { ...backup, createdAt: new Date(Date.now() - 23 * 60 * 1000).toISOString() };
  const html = page([project({ latestBackup: recentBackup })]);
  assert.match(html, /最新备份[\s\S]*23 分前/);
  assert.doesNotMatch(html, /归档时间|尚未归档/);
});

test('abnormal and missing sandboxes use the recovery-or-first-create paths', () => {
  const broken = page([project({ sandbox: { id: 'broken', status: 'unavailable', template: 'default', workingDirectory: '/workspace' }, latestBackup: backup })]);
  assert.match(broken, /异常/);
  assert.match(broken, /从备份恢复/);
  assert.doesNotMatch(broken, /立即备份/);

  const unknown = page([project({ sandbox: { id: 'query-failed', status: 'unknown', template: 'default', workingDirectory: '/workspace' }, latestBackup: backup })]);
  assert.match(unknown, /状态未知/);
  assert.match(unknown, /状态查询失败/);
  assert.doesNotMatch(unknown, /<button class="primary-button" disabled="">进入项目/);
  assert.doesNotMatch(unknown, /恢复环境|重建 Sandbox|立即备份|>异常</);

  const missing = page([project()]);
  assert.match(missing, /无 Sandbox/);
  assert.match(missing, /进入项目/);
  assert.doesNotMatch(missing, /<button class="primary-button" disabled="">进入项目/);
  assert.match(missing, /新建 Sandbox/);
  assert.doesNotMatch(missing, /<button[^>]*>恢复环境<\/button>/);
});

test('a released project offers new Sandbox and explicit backup restore independently', () => {
  const html = page([project({
    latestBackup: backup,
    sandboxMounts: [{ volumeId: 'project-volume', mountPath: '/workspace' }],
  })]);
  assert.match(html, /新建 Sandbox/);
  assert.match(html, /从备份恢复/);
  assert.match(html, /保留的挂载盘[\s\S]*\/workspace[\s\S]*project-volume/);
});

test('paused sandbox shows its state and resumes the same environment', () => {
  const html = page([project({ sandbox: { id: 'paused-box', status: 'paused', template: 'default', workingDirectory: '/workspace' }, latestBackup: backup })]);
  assert.match(html, /已暂停/);
  assert.match(html, /恢复运行/);
  assert.doesNotMatch(html, /<button class="primary-button" disabled="">进入项目/);
  assert.doesNotMatch(html, /恢复环境|立即备份|>异常</);
});

test('archived project restores from its latest backup and running operations disable actions', () => {
  const archived = page([project({ status: 'archived', archivedAt: now, latestBackup: backup })], 'archived');
  assert.match(archived, /恢复项目/);

  const running = page([project({
    sandbox: { id: 'current', status: 'ready', template: 'default', workingDirectory: '/workspace' },
    sandboxOperation: { kind: 'checkpoint', phase: '暂停中', status: 'running', updatedAt: now },
  })]);
  assert.match(running, /Checkpoint：暂停中/);
  assert.match(running, /disabled=""/);
});

test('checkpoint only pauses; disk backup is separate and backup state never blocks resume', () => {
  const paused = page([project({
    sandbox: { id: 'paused-box', status: 'paused', template: 'default', workingDirectory: '/workspace' },
    sandboxOperation: { kind: 'checkpoint', status: 'succeeded', phase: '已暂停', updatedAt: now },
  })]);
  assert.match(paused, /<button class="secondary-button"[^>]*>恢复运行<\/button>/);
  assert.doesNotMatch(paused, /<button[^>]*disabled[^>]*>恢复运行<\/button>/);
  assert.match(paused, /<button class="secondary-button"[^>]*>磁盘备份<\/button>/);
  assert.doesNotMatch(paused, /磁盘备份：/);
  assert.match(paused, /<button class="primary-button"[^>]*>进入项目/);
  assert.match(paused, /<button class="project-archive-button"[^>]*>标记已完成<\/button>/);

  for (const status of ['running', 'unknown', 'failed', 'succeeded'] as const) {
    const existingBackup = page([project({
      sandbox: { id: 'paused-box', status: 'paused', template: 'default', workingDirectory: '/workspace' },
      sandboxBackup: { id: `backup-${status}`, sandboxId: 'paused-box', status, phase: '上传中', updatedAt: now },
    })]);
    assert.match(existingBackup, /<button class="secondary-button"[^>]*>恢复运行<\/button>/);
    assert.doesNotMatch(existingBackup, /<button[^>]*disabled[^>]*>恢复运行<\/button>/);
  }

  const oldSandboxBackup = page([project({
    sandbox: { id: 'new-paused-box', status: 'paused', template: 'default', workingDirectory: '/workspace' },
    sandboxBackup: { id: 'backup-old', sandboxId: 'retired-box', status: 'running', phase: '上传中', updatedAt: now },
  })]);
  assert.match(oldSandboxBackup, /<button class="secondary-button"[^>]*>恢复运行<\/button>/);
  assert.doesNotMatch(oldSandboxBackup, /<button[^>]*disabled[^>]*>恢复运行<\/button>/);
});

test('a completed backup operation is not shown on the project card', () => {
  const html = page([project({ sandboxOperation: { kind: 'backup', phase: '上传中', status: 'succeeded', updatedAt: now } })]);
  assert.doesNotMatch(html, /备份：已完成/);
});
