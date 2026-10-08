import { test } from '../support/fixtures.mjs';
import { projectLifecycle } from './project-lifecycle.mjs';
import { conversationReads } from './conversation-reads.mjs';

test('project lifecycle with real model, files, process memory, backup and restore', async ({ environment }) => {
  await projectLifecycle(environment);
});

test('conversation reads with real nested subagents, isolation and latency guard', async ({ environment }) => {
  await conversationReads(environment);
});

test('asynchronous user input with real native tool and persisted reply', async ({ environment }) => {
  await projectLifecycle(environment, { userInputOnly: true });
});

test('project lifecycle: failed Sandbox rebuild retains mounted files and conversation newer than the archive', async ({ environment }) => {
  await projectLifecycle(environment, { homeRebuild: true });
});


test('disk image upgrade retains real conversation history and latest workspace files', async ({ environment }) => {
  test.skip(!process.env.COCELL_E2E_UPGRADE_FROM_VERSION_ID || !process.env.COCELL_E2E_UPGRADE_TO_VERSION_ID, 'Requires two admitted managed image versions');
  await projectLifecycle(environment, { diskUpgrade: true });
});
