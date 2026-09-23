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
    onRebuildSandbox={async () => project()} onBackup={async () => project()} onSwitchSandbox={async () => project()}
    onOpenProject={() => {}} onMenu={() => {}} onBack={() => {}}
  />);
}

test('outdated ready sandbox offers switching only when the project is idle and active', () => {
  const currentImage = { reference: 'cellbox:latest', id: 'sha256:old', repoDigests: [], version: '1.0' };
  const latestImage = { reference: 'cellbox:latest', id: 'sha256:new', repoDigests: [], version: '2.0' };
  const config = { sandbox: { enabled: true, image: 'cellbox:latest', imageIdentity: latestImage } } as unknown as AppConfig;
  const sandbox = { id: 'current', status: 'ready' as const, template: 'default', workingDirectory: '/workspace', image: currentImage };
  const outdated = page([project({ sandbox })], undefined, config);
  assert.match(outdated, /切换到最新版本/);

  assert.doesNotMatch(page([project({ sandbox: { ...sandbox, image: latestImage } })], undefined, config), /切换到最新版本/);
  assert.doesNotMatch(page([project({ sandbox, activeSessionId: 'session-1' })], undefined, config), /切换到最新版本/);
  assert.doesNotMatch(page([project({ sandbox, status: 'archived', archivedAt: now })], 'archived', config), /切换到最新版本/);
  assert.doesNotMatch(page([project({ sandbox, sandboxOperation: { kind: 'backup', phase: '处理中', status: 'running', updatedAt: now } })], undefined, config), /切换到最新版本/);
});

test('normal sandbox exposes backup and archive, with only the latest backup', () => {
  const html = page([project({ sandbox: { id: 'current', status: 'ready', template: 'default', workingDirectory: '/workspace' }, latestBackup: backup })]);
  assert.match(html, /正常/);
  assert.match(html, /立即备份/);
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
  assert.match(broken, /恢复环境/);
  assert.doesNotMatch(broken, /立即备份/);

  const missing = page([project()]);
  assert.match(missing, /无 Sandbox/);
  assert.match(missing, /进入项目/);
  assert.doesNotMatch(missing, /恢复环境/);
});

test('archived project restores from its latest backup and running operations disable actions', () => {
  const archived = page([project({ status: 'archived', archivedAt: now, latestBackup: backup })], 'archived');
  assert.match(archived, /恢复项目/);

  const running = page([project({
    sandbox: { id: 'current', status: 'ready', template: 'default', workingDirectory: '/workspace' },
    sandboxOperation: { kind: 'backup', phase: '上传中', status: 'running', updatedAt: now },
  })]);
  assert.match(running, /备份：上传中/);
  assert.match(running, /disabled=""/);
});

test('a completed backup operation is not shown on the project card', () => {
  const html = page([project({ sandboxOperation: { kind: 'backup', phase: '上传中', status: 'succeeded', updatedAt: now } })]);
  assert.doesNotMatch(html, /备份：已完成/);
});
