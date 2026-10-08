import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from '../support/fixtures.mjs';
import { createConversation, fileURL, runAgent } from '../support/agent.mjs';

test('nightly: Git and Go build from a cloned repository subdirectory with VCS metadata', async ({ environment: env }) => {
  const project = await env.createProject('git-go');
  const ready = await env.waitProject(project.id, { kind: 'create', status: 'ready' });
  const session = await createConversation(env, project, 'Git and Go regression');
  const marker = randomUUID();
  await env.step('Agent creates a local Git fixture, clones it and builds from a subdirectory', async () => {
    const result = await runAgent(env, session, `This is a real Git and Go integration test. Do not install software, use subagents, credentials or external business systems. Only write under git-go-fixture/. Use the preinstalled native git and Go binaries.
Create a small local source Git repository under git-go-fixture/source, with go.mod (module example.com/ci-fixture, Go 1.22) and cmd/server/main.go. The main program must print JSON with marker=${marker} and vcs=<map of the runtime/debug.ReadBuildInfo Settings whose keys start with vcs.>. Use only Go standard libraries. Commit the files using identity configured only for this fixture repository. Clone source locally into git-go-fixture/clone.
From git-go-fixture/clone/cmd/server run git rev-parse --show-toplevel, git status --porcelain and the command "go build -o ../../server .". Do not use -buildvcs=false, global git config or safe.directory=*.
Run the built server and save its exact JSON stdout to git-go-fixture/result.json. Independently check that vcs.revision matches the clone's git rev-parse HEAD and vcs.modified is false. Save that commit SHA into git-go-fixture/revision.txt. Report the actual build result.`);
    assert(result.turn.items.some(item => item.type === 'command_execution'));
    const output = JSON.parse(await env.json(fileURL(ready, 'git-go-fixture/result.json')));
    const revision = (await env.json(fileURL(ready, 'git-go-fixture/revision.txt'))).trim();
    assert.equal(output.marker, marker);
    assert.match(revision, /^[a-f0-9]{40}$/);
    assert.equal(output.vcs['vcs'], 'git');
    assert.equal(output.vcs['vcs.revision'], revision);
    assert.equal(output.vcs['vcs.modified'], 'false');
    return { revision, vcs: output.vcs };
  });
});
