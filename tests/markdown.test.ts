import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import Markdown from '../src/Markdown.js';
const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

test('renders GFM analysis tables, heading levels and paragraphs as semantic HTML', () => {
  const html = render('# 分析\n\n## 统计\n\n第一段。\n\n第二段。\n\n| 周期 | 数量 |\n| --- | ---: |\n| 24 小时 | **100** |\n| 7 天 | `700` |\n\n---');
  assert.match(html, /<h1>分析<\/h1>/); assert.match(html, /<h2>统计<\/h2>/);
  assert.match(html, /<p>第一段。<\/p>/); assert.match(html, /<p>第二段。<\/p>/);
  assert.match(html, /<table>/); assert.match(html, /<thead>/); assert.match(html, /<tbody>/);
  assert.match(html, /text-align:right/); assert.match(html, /<strong>100<\/strong>/); assert.match(html, /<code>700<\/code>/);
  assert.match(html, /<hr\/>/);
});

test('renders nested ordered lists, task lists, quotes and combined inline formatting', () => {
  const html = render('3. 第三项\n   - **重点和 *强调***\n4. 第四项\n\n- [x] 已完成\n- [ ] 待完成\n\n> ~~旧结论~~\n>\n> 新结论');
  assert.match(html, /<ol start="3">/); assert.match(html, /<ul>\n<li><strong>重点和 <em>强调<\/em><\/strong>/);
  assert.match(html, /type="checkbox"[^>]*disabled=""[^>]*checked=""/);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 2);
  assert.match(html, /<blockquote>/); assert.match(html, /<del>旧结论<\/del>/);
});

test('preserves code indentation and literal Markdown for fenced and unfinished streaming blocks', () => {
  for (const fence of ['```sql\nSELECT 1;\n  -- **literal**\n```', '~~~sql\nSELECT 1;\n  -- **literal**\n~~~', '```sql\nSELECT 1;\n  -- **literal**']) {
    const html = render(fence);
    assert.match(html, /<pre tabindex="0"><code class="language-sql">SELECT 1;\n  -- \*\*literal\*\*\n<\/code><\/pre>/);
    assert.match(html, /aria-label="复制代码"/);
    assert.ok(!html.includes('<strong>literal'));
  }
  assert.match(render('```\nplain\n```'), /<span>代码<\/span>/);
});

test('keeps HTML inert, filters unsafe URLs and renders safe formatted links', () => {
  const html = render('<script>alert(1)</script>\n\n[危险](javascript:alert%281%29)\n\n![图片](data:text/html,bad)\n\n[**官方**](https://example.com/path?a=1&b=2)\n\nhttps://example.com');
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('href="javascript:')); assert.ok(!html.includes('src="data:'));
  assert.match(html, /&lt;script&gt;/); assert.match(html, /<strong>官方<\/strong>/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});

test('uses distinct footnote anchors across multiple messages and supports hard line breaks', () => {
  const text = '第一行  \n第二行[^note]\n\n[^note]: 脚注';
  const html = renderToStaticMarkup(createElement('div', null, createElement(Markdown, { text }), createElement(Markdown, { text })));
  const ids = [...html.matchAll(/id="([^"]+-fn-note)"/g)].map(match => match[1]);
  assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
  assert.match(html, /第一行<br\/>\n第二行/);
});
