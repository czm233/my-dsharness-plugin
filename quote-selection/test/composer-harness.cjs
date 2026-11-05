// 输入框状态回归脚手架:加载真实 client.js,在 jsdom 里复刻宿主输入框结构,
// 验证「引用确认后输入框算作有内容、发送按钮可点;移除/发完后回到原状」。
// 装机前必须跑通(结果全部 PASS)。
//
// 用法:node quote-selection/test/composer-harness.cjs
// 依赖:jsdom(测试专用,不随插件分发;可用 npm i jsdom 装在任意临时目录后设 QS_JSDOM 指向它)

const assert = require('node:assert');
const path = require('node:path');

const CLIENT = path.resolve(__dirname, '..', 'client.js');
const jsdomPath = process.env.QS_JSDOM || 'jsdom';
const { JSDOM } = require(jsdomPath);

const MARKER = '#dsh-quote-composer-marker';
const BUTTON = '#dsh-quote-selection-button';
const POPOVER = '#dsh-quote-comment-popover';
const CARD = '#dsh-quote-annotation-card';

const html = `<!doctype html><html><head></head><body>
<div data-conversation-content data-conversation-region="chat">
  <div>
    <div class="AkCqbG_userRow"><div class="AkCqbG_bubble">请帮我检查一下这个问题</div></div>
    <div data-composer-seat data-conversation-region="composer">
      <div class="JZLxKW_root"><div class="JZLxKW_card" data-composer-card>
        <div class="JZLxKW_overlayAnchor" data-composer-overlay></div>
        <div class="JZLxKW_scroll" data-input-scroll><div class="JZLxKW_grow">
          <div class="JZLxKW_input" data-composer-input contenteditable="true" data-lexical-editor="true"><p><br></p></div>
          <div class="JZLxKW_placeholder" data-composer-placeholder>发消息或创建任务</div>
        </div></div>
        <div class="JZLxKW_row">
          <div class="JZLxKW_tools"><button class="JZLxKW_add"></button></div>
          <div class="JZLxKW_trailing"><div class="JZLxKW_standardControls"></div>
            <button class="JZLxKW_primary" id="send" disabled></button></div>
        </div>
      </div></div>
    </div>
  </div>
</div></body></html>`;

const dom = new JSDOM(html, { pretendToBeVisual: true });
const w = dom.window;
const d = w.document;

for (const key of ['Element', 'Node', 'HTMLElement', 'NodeFilter', 'CSS', 'DataTransfer', 'ClipboardEvent',
  'Event', 'KeyboardEvent', 'MouseEvent', 'HTMLTextAreaElement', 'MutationObserver']) {
  globalThis[key] = w[key];
}
globalThis.window = w;
globalThis.document = d;
globalThis.getComputedStyle = w.getComputedStyle.bind(w);
globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w);
// jsdom 不做布局:补上插件用到的两个几何/可见性 API。
w.HTMLElement.prototype.checkVisibility = () => true;
w.Range.prototype.getBoundingClientRect = () => ({ x: 100, y: 100, left: 100, top: 100, right: 400, bottom: 120, width: 300, height: 20 });
Object.defineProperty(w, 'innerWidth', { value: 1200, configurable: true });
Object.defineProperty(w, 'innerHeight', { value: 800, configurable: true });

w.__ModuleLoader__ = { load: (mod) => { globalThis.__qsModule = mod; } };
require(CLIENT);
const plugin = globalThis.__qsModule.factory(() => { throw new Error('quote-selection: no runtime deps'); });
let dispose = () => {};
plugin.apply({ effect: (fn) => { dispose = fn() || (() => {}); return dispose; } });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const marker = () => d.querySelector(MARKER);
const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); } catch (error) { results.push(['FAIL', name + ' — ' + error.message]); }
}

async function quoteOnce() {
  const text = d.querySelector('.AkCqbG_bubble').firstChild;
  const range = d.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 4);
  const selection = w.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  d.dispatchEvent(new w.Event('selectionchange'));
  await sleep(250);
  d.querySelector(BUTTON).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  d.querySelector(`${POPOVER} input`).value = '这里写错了';
  d.querySelector(`${POPOVER} .dsh-quote-confirm`).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
}

(async () => {
  check('初始无标记节点', () => assert.strictEqual(marker(), null));

  await quoteOnce();
  check('确认批注后出现批注卡', () => {
    const card = d.querySelector(CARD);
    assert.ok(card && card.style.display === 'flex');
    assert.ok(card.parentElement.classList.contains('JZLxKW_card'));
  });
  check('确认批注后挂上输入框「有内容」标记', () => {
    const node = marker();
    assert.ok(node, '标记节点不存在');
    assert.ok(node.closest('.JZLxKW_grow'), '标记节点不在输入框内');
  });
  check('正文没有被塞入占位字符', () => {
    assert.strictEqual(d.querySelector('[data-composer-input]').textContent.trim(), '');
    assert.ok(d.querySelector('.JZLxKW_placeholder'), '占位层不应被删');
  });

  const node = marker();
  d.querySelector('.JZLxKW_grow').appendChild(d.createComment('react re-render'));
  await sleep(20);
  check('宿主重渲染后标记仍只有一个', () => {
    assert.strictEqual(d.querySelectorAll(MARKER).length, 1);
    assert.strictEqual(marker(), node);
  });

  d.querySelector(`${CARD} .dsh-quote-clear`).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  check('移除批注后摘掉标记', () => assert.strictEqual(marker(), null));
  check('移除批注后卡片隐藏', () => assert.strictEqual(d.querySelector(CARD).style.display, 'none'));

  await quoteOnce();
  d.querySelector(`${CARD} .dsh-quote-clear`).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await quoteOnce();
  check('再次引用仍只挂一个标记', () => assert.strictEqual(d.querySelectorAll(MARKER).length, 1));

  dispose();
  await sleep(20);
  check('卸载后标记与 DOM 一并清理', () => {
    assert.strictEqual(marker(), null);
    assert.strictEqual(d.querySelector(CARD), null);
  });

  for (const [status, line] of results) console.log(`${status}  ${line}`);
  const failed = results.filter(([status]) => status === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})();