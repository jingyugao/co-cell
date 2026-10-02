import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ThreadItem } from '../../../protocol/agent-protocol';
import ReasoningSummary, { groupThreadItems } from './ReasoningSummary';

const reasoning = (id: string, text: string): Extract<ThreadItem, { type: 'reasoning' }> => ({ id, type: 'reasoning', text });

test('unavailable summaries preserve a compact record without an empty disclosure', () => {
  const entries = [{ item: reasoning('empty', ''), anchorId: 'anchor-empty' }, { item: reasoning('whitespace', ' \n\t ') }];
  const html = renderToStaticMarkup(<ReasoningSummary entries={entries} />);
  assert.match(html, /思考过程/);
  assert.match(html, /2 段/);
  assert.match(html, /模型未提供可显示的摘要/);
  assert.match(html, /id="anchor-empty"/);
  assert.doesNotMatch(html, /<details|<summary|已加密|正在思考/);
  const pending = renderToStaticMarkup(<ReasoningSummary entries={entries} pending />);
  assert.match(pending, /正在思考…/);
  assert.match(pending, /role="status"/);
  assert.equal(renderToStaticMarkup(<ReasoningSummary entries={[]} />), '');
});

test('consecutive reasoning previews the latest content and preserves full text and navigation anchors', () => {
  const html = renderToStaticMarkup(<ReasoningSummary entries={[
    { item: reasoning('empty', ''), anchorId: 'anchor-empty' },
    { item: reasoning('first', '先检查现有布局。'), anchorId: 'anchor-first' },
    { item: reasoning('latest', '**再检查输入区。**\n保留完整的第二行。'), anchorId: 'anchor-latest', highlighted: true },
  ]} />);
  assert.match(html, /2 段/);
  assert.match(html, /class="reasoning-preview">再检查输入区。 保留完整的第二行。/);
  assert.match(html, /先检查现有布局。/);
  assert.match(html, /<strong>再检查输入区。<\/strong>/);
  for (const anchor of ['empty', 'first', 'latest']) assert.match(html, new RegExp(`id="anchor-${anchor}"`));
  assert.match(html, /billing-item-selected/);
  assert.match(html, /另有 1 段未提供可显示的摘要/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|\s|>)/);
});

test('grouping never crosses tools, replies, compaction or child-work boundaries', () => {
  const items: ThreadItem[] = [reasoning('a', 'a'), reasoning('b', 'b'), reasoning('c', 'c'),
    { id: 'tool', type: 'command_execution', command: 'pwd', aggregated_output: '', status: 'completed', exit_code: 0 },
    reasoning('d', 'd'), reasoning('e', 'e'), { id: 'reply', type: 'agent_message', text: 'done' }, reasoning('f', 'f')];
  const groups = groupThreadItems(items, new Set([2, 5]));
  assert.deepEqual(groups.map(group => group.type === 'reasoning' ? group.items.map(item => item.id) : [group.item.id]),
    [['a', 'b'], ['c'], ['tool'], ['d'], ['e'], ['reply'], ['f']]);
  assert.deepEqual(groups.map(group => group.startIndex), [0, 2, 3, 4, 5, 6, 7]);
});
