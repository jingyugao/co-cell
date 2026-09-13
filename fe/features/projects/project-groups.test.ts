import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectSummary } from '../../../protocol/types.js';
import { groupArchivedProjectsByWeek } from './project-groups.js';

function project(id: string, archivedAt: Date): ProjectSummary {
  return {
    id, name: id, requirementUrl: null, executionMode: 'sandbox', workingDirectory: '/home/user/workspace',
    archivedAt: archivedAt.toISOString(), createdAt: archivedAt.toISOString(), updatedAt: archivedAt.toISOString(),
    sessionCount: 0, activeSessionId: null,
  };
}

test('archived projects are grouped by local Monday and sorted newest first', () => {
  const monday = project('monday', new Date(2026, 8, 7, 9));
  const sunday = project('sunday', new Date(2026, 8, 13, 18));
  const nextMonday = project('next-monday', new Date(2026, 8, 14, 8));

  const groups = groupArchivedProjectsByWeek([monday, nextMonday, sunday]);

  assert.deepEqual(groups.map(group => group.key), ['2026-09-14', '2026-09-07']);
  assert.deepEqual(groups[0].projects.map(item => item.id), ['next-monday']);
  assert.deepEqual(groups[1].projects.map(item => item.id), ['sunday', 'monday']);
});
