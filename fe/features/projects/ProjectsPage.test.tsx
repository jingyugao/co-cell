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
    onDelete={async () => {}} onCreateSandbox={async () => project()} onRestoreSandbox={async () => project()} onReleaseSandbox={async () => project()} onResumeSandbox={async () => project()} onCheckpointSandbox={async () => project()} onBackupSandbox={async () => project()} onArchiveProject={async () => project()}
    onOpenProject={() => {}} onViewBackup={() => {}} onMenu={() => {}} onBack={() => {}}
  />);
}

test('ready sandbox offers a Checkpoint without starting a disk backup', () => {
  const html = page([project({ sandbox: { id: 'current', status: 'ready', template: 'default', workingDirectory: '/workspace' }, latestBackup: backup })]);
  assert.match(html, /运行中/);
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
  assert.match(missing, /尚未创建/);
  assert.match(missing, /进入项目/);
  assert.doesNotMatch(missing, /<button class="primary-button" disabled="">进入项目/);
  assert.match(missing, /新建 Sandbox/);
  assert.doesNotMatch(missing, /<button[^>]*>恢复环境<\/button>/);
});

test('a released project with retained mounts can back them up without creating a Sandbox', () => {
  const html = page([project({
    imageSelection: { imageId: 'node', imageName: 'Node Runtime', category: 'Node', versionId: 'old-entry', version: '1.0', templateId: 'node-template', revisionId: 'old-entry', image: 'registry.example/node:1.0' },
    latestBackup: backup,
    sandboxMounts: [{ volumeId: 'project-volume', mountPath: '/workspace' }],
  })]);
  assert.match(html, /新建 Sandbox/);
  assert.match(html, /从备份恢复/);
  assert.match(html, /Node Runtime · Cellbox stable/);
  assert.doesNotMatch(html, /Node Runtime · 1\.0/);
  assert.match(html, /保留的挂载盘[\s\S]*\/workspace[\s\S]*project-volume/);
  const sandboxActions = html.match(/aria-label="Sandbox 操作"[\s\S]*?<\/section>/)![0];
  assert.match(sandboxActions, /<button[^>]*>磁盘备份<\/button>/);
  assert.doesNotMatch(sandboxActions, /disabled=""[^>]*>磁盘备份/);
  assert.doesNotMatch(html, /Cellbox 暂不支持直接备份已释放环境的挂载盘/);
  assert.match(html, /可直接备份保留的挂载盘/);
});

test('a released project without retained mounts cannot request a disk backup', () => {
  const html = page([project({ sandboxReclaimedAt: now })]);
  assert.match(html, /<button[^>]*disabled=""[^>]*>磁盘备份<\/button>/);
  assert.doesNotMatch(html, /可直接备份保留的挂载盘/);
});

test('a running Sandbox stays ineligible for archive even when mounts are recorded', () => {
  const html = page([project({ sandbox: { id: 'running-box', template: 'default', status: 'ready', phase: 'running', workingDirectory: '/workspace' },
    sandboxMounts: [{ volumeId: 'project-volume', mountPath: '/workspace' }] })]);
  assert.match(html, /<button class="secondary-button" disabled="" title="请先暂停后归档，或明确选择使用已有备份">手动归档<\/button>/);
});

test('processing only offers read-only status refresh while unknown Box still offers explicit release', () => {
  const processing = page([project({ sandbox: { id: 'box', template: 'default', status: 'ready', phase: 'suspending', workingDirectory: '/workspace' } })]);
  const actions = processing.match(/aria-label="Sandbox 操作"[\s\S]*?<\/section>/)![0];
  assert.match(actions, />刷新状态<\/button>/);
  assert.doesNotMatch(actions, />释放运行环境<\/button>|>恢复运行<\/button>|>Checkpoint · 暂停<\/button>/);
  const unknown = page([project({ sandbox: { id: 'box', template: 'default', status: 'unknown', workingDirectory: '/workspace' } })]);
  assert.match(unknown, />释放运行环境<\/button>/);
  assert.match(unknown, />刷新状态<\/button>/);
  assert.doesNotMatch(unknown, />新建 Sandbox<\/button>/);
});

test('a running sandbox card shows the observed image version and revision instead of the saved template entry', () => {
  const html = page([project({
    imageSelection: { imageId: 'node', imageName: 'Node Runtime', category: 'Node', versionId: 'old-entry', version: '1.0', templateId: 'node-template', revisionId: 'old-entry', image: 'registry.example/node:1.0' },
    sandbox: { id: 'current', status: 'ready', template: 'default', workingDirectory: '/workspace', image: {
      reference: 'registry.example/node@sha256:current', id: 'sha256:current', repoDigests: [],
      templateId: 'node-template', revisionId: 'stable-current', version: '2.0',
    } },
  })]);
  assert.match(html, /项目镜像[\s\S]*2\.0 · revision stable-current/);
  assert.doesNotMatch(html, /Node Runtime · 1\.0/);
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

test('completed project exposes only restore and delete actions without backup preview entry points', () => {
  const html = page([project({ status: 'completed', latestBackup: backup, archiveVersions: [{ id: 'v1', version: 1, createdAt: now, sizeBytes: 42, bytesAdded: 42, label: '备份' }] })], 'completed');
  const card = html.match(/<article class="project-card[\s\S]*?<\/article>/)![0];
  const actions = card.match(/aria-label="项目操作"[\s\S]*?<\/section>/)![0];
  assert.match(actions, />恢复<\/button>/);
  assert.match(actions, />删除<\/button>/);
  assert.doesNotMatch(actions, /工具权限|归档|进入项目|Sandbox|备份/);
  assert.doesNotMatch(card, /archive-badge|查看归档|重建 Sandbox|Checkpoint|恢复运行|磁盘备份/);
});

test('volume snapshots show available metadata without opening the archive file browser', () => {
  const unknownSize = page([project({ archiveVersions: [{ id: 'vol-snapshot', version: 1, createdAt: now,
    label: '版本 1', browsable: false, storageType: 'cellbox-volume' }] })]);
  assert.match(unknownSize, /磁盘备份/);
  assert.match(unknownSize, /暂不支持文件浏览/);
  assert.doesNotMatch(unknownSize, /undefined|NaN/);
  assert.doesNotMatch(unknownSize, /<button class="archive-badge-entry/);
  assert.match(unknownSize, /<span class="archive-badge-entry/);

  const zero = page([project({ archiveVersions: [{ id: 'vol-snapshot-zero', version: 1, createdAt: now,
    sizeBytes: 0, bytesAdded: 0, label: '版本 1', browsable: false, storageType: 'cellbox-volume' }] })]);
  assert.match(zero, /0 B · \+0 B/);
  assert.doesNotMatch(zero, /<button class="archive-badge-entry/);

  const legacy = page([project({ archiveVersions: [{ id: 'legacy-archive', version: 1, createdAt: now,
    sizeBytes: 42, label: '版本 1', browsable: true, storageType: 'cellbox' }] })]);
  assert.match(legacy, /<button class="archive-badge-entry/);
});

test('backup retention failure is surfaced as an alert without hiding the completed backup', () => {
  const html = page([project({ sandboxBackup: { id: 'volume-snapshot', status: 'succeeded', phase: '完成',
    volumeId: 'volume-1', retentionError: '旧快照清理失败', updatedAt: now },
    backupPolicy: { enabled: true, engine: 'restic', scope: 'volume', keepLast: 2 } })]);
  assert.match(html, /备份已完成，但旧快照清理失败/);
  assert.match(html, /旧快照清理失败/);
  assert.match(html, /每个磁盘保留最近 2 版/);
  assert.doesNotMatch(html, /保留最近 3 版/);
});

test('Cellbox backup policy lookup errors are shown without inventing a retention count', () => {
  const html = page([project({ backupPolicyError: 'Cellbox 查询暂不可用' })]);
  assert.match(html, /无法读取磁盘备份保留策略/);
  assert.match(html, /Cellbox 查询暂不可用/);
  assert.doesNotMatch(html, /每个磁盘保留最近 \d+ 版/);
});

test('catalog refresh errors say the disk backup succeeded and do not suggest retrying it', () => {
  const backupError = page([project({ sandboxBackup: { id: 'volume-snapshot', volumeId: 'volume-1', status: 'succeeded',
    phase: '完成', catalogError: 'Cellbox 目录暂不可用', updatedAt: now } })]);
  assert.match(backupError, /磁盘备份已完成，但目录刷新失败/);
  assert.match(backupError, /Cellbox 目录暂不可用/);
  assert.match(backupError, /无需重试备份/);
  assert.doesNotMatch(backupError, /磁盘备份失败|重试磁盘备份/);

  const operationError = page([project({ sandboxOperation: { kind: 'backup', status: 'succeeded', phase: '完成',
    catalogError: '目录刷新失败', updatedAt: now } })]);
  assert.match(operationError, /磁盘备份已完成，但目录刷新失败/);
  assert.match(operationError, /无需重试备份/);

  const catalogOnlyFailure = page([project({
    sandboxBackup: { id: 'snapshot', status: 'succeeded', phase: '完成', catalogError: '目录刷新失败', updatedAt: now },
    sandboxOperation: { kind: 'backup', status: 'failed', phase: '目录刷新', error: '目录刷新失败', updatedAt: now },
  })]);
  assert.match(catalogOnlyFailure, /磁盘备份已完成，但目录刷新失败/);
  assert.doesNotMatch(catalogOnlyFailure, /备份：失败|磁盘备份失败/);
});
