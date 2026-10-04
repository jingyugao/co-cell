import assert from 'node:assert/strict';
import { meegleFixture } from './fixtures/meegle-credentials.mjs';
import test from 'node:test';
import { openMeegleBundle, rebindMeegleBundle, validateFileBundle } from '../../util/credential-files.mjs';

test('native Meegle encrypted files rebind across identities without dropping refresh data', () => {
  const source = meegleFixture(), targetIdentity = { hostname: 'sandbox-host', username: 'unknown' };
  const target = rebindMeegleBundle(source, targetIdentity);
  assert.deepEqual(openMeegleBundle(target), openMeegleBundle(source));
  assert.deepEqual(target.identity, targetIdentity);
  assert.notEqual(target.files[1].content, source.files[1].content);
  assert.notEqual(target.files[2].content, source.files[2].content);
  assert.ok(!JSON.stringify(target).includes('refresh-original'));
  assert.deepEqual(rebindMeegleBundle(target, targetIdentity), target);
  const restored = rebindMeegleBundle(target, { hostname: 'restored-host', username: 'unknown' });
  assert.deepEqual(openMeegleBundle(restored), openMeegleBundle(source));
  assert.throws(() => openMeegleBundle({ ...source, identity: targetIdentity }), /无法解密/);
  assert.throws(() => validateFileBundle({ files: [{ path: '../secret', content: 'x' }] }), /路径/);
  assert.throws(() => validateFileBundle({ files: [{ path: 'auth', content: 'x' }, { path: 'auth/key', content: 'y' }] }), /目录冲突/);
});
