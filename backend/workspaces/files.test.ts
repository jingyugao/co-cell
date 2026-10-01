import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceFileResult } from './files.js';

test('native bytes preserve binary downloads and only safe content is previewed', () => {
  const binary = Buffer.from([0, 0xff, 0xfe, 0x80]);
  const output = workspaceFileResult('/workspace/file.bin', binary);
  assert.deepEqual(output.data, binary);
  assert.equal(output.file.kind, 'binary');
  assert.equal(output.file.size, binary.length);
  assert.equal(output.file.text, undefined);
  const text = workspaceFileResult('/workspace/main.go', Buffer.from('package main\n'));
  assert.equal(text.file.text, 'package main\n');
  assert.equal(text.file.kind, 'text');
  const image = workspaceFileResult('/workspace/image.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(image.file.kind, 'image');
  assert.equal(image.file.mimeType, 'image/png');
  const svg = workspaceFileResult('/workspace/image.svg', Buffer.from('<svg onload="alert(1)"></svg>'));
  assert.equal(svg.file.kind, 'text', 'active image formats must not be served inline');
});
