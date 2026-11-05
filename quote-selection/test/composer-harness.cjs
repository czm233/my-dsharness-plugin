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
            <button class="JZLxKW_primary" id="send" aria-label="发送消息" disabled></button></div>
        </div>
      </div></div>
    </div>
  </div>
</div></body></html>`;

const dom = new JSDOM(html, { pretendToBeVisual: true });
const w = dom.window;
const d = w.document;

for (const key of ['Element', 'Node', 'HTMLElement', 'NodeFilter', 'CSS', 'PointerEvent',
  'Event', 'KeyboardEvent', 'MouseEvent', 'HTMLTextAreaElement', 'MutationObserver']) {
  globalThis[key] = w[key];
}
globalThis.window = w;
globalThis.document = d;
globalThis.getComputedStyle = w.getComputedStyle.bind(w);
globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w);
// jsdom 不做布局:补上插件用到的两个几何/可见性 API。
// 真实浏览器里合成粘贴由 Lexical 接收(event.defaultPrevented);jsdom 没有编辑器,
// 这里把「粘贴被接收」近似成宿主收到这段文字。
class FakeDataTransfer {
  constructor() { this.data = {}; }
  setData(type, value) { this.data[type] = value; }
  getData(type) { return this.data[type] || ''; }
}
class FakeClipboardEvent extends w.Event {
  constructor(type, init = {}) {
    super(type, init);
    this.clipboardData = init.clipboardData || new FakeDataTransfer();
    this.__qsSynthetic = true;
  }
}
w.DataTransfer = FakeDataTransfer;
w.ClipboardEvent = FakeClipboardEvent;
globalThis.DataTransfer = FakeDataTransfer;
globalThis.ClipboardEvent = FakeClipboardEvent;
// jsdom 没有编辑器:合成粘贴在这里等价于宿主把它写进输入框。
w.Element.prototype.dispatchEvent = (() => {
  const orig = w.EventTarget.prototype.dispatchEvent;
  return function dispatchEvent(event) {
    if (event && event.type === 'paste' && !event.__qsDelivered) event.__qsDelivered = true;
    return orig.call(this, event);
  };
})();
w.HTMLElement.prototype.checkVisibility = () => true;
// jsdom 没实现 execCommand:输入框里的 insertText 当插入文字处理。
d.execCommand = (command, _ui, value) => {
  if (command !== 'insertText' || typeof value !== 'string') return false;
  const sel = w.getSelection();
  const node = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode) : null;
  const host = node && node.closest ? node.closest('[data-lexical-editor]') : null;
  if (!host) return false;
  host.appendChild(d.createTextNode(value));
  return true;
};
w.Range.prototype.getBoundingClientRect = () => ({ x: 100, y: 100, left: 100, top: 100, right: 400, bottom: 120, width: 300, height: 20 });
Object.defineProperty(w, 'innerWidth', { value: 1200, configurable: true });
Object.defineProperty(w, 'innerHeight', { value: 800, configurable: true });

w.__ModuleLoader__ = { load: (mod) => { globalThis.__qsModule = mod; } };
require(CLIENT);
const plugin = globalThis.__qsModule.factory(() => { throw new Error('quote-selection: no runtime deps'); });
let dispose = () => {};
plugin.apply({ effect: (fn) => { dispose = fn() || (() => {}); return dispose; } });

// 宿主行为的近似:按钮点击只在有正文时提交(提交 = 清空正文,批注卡跟着消失)。
let hostSubmits = 0;
let lastSubmitText = '';
const sendButton = () => d.querySelector('[aria-label="发送消息"]');
const composerText = () => d.querySelector('[data-composer-input]').textContent;
sendButton().addEventListener('click', () => {
  if (composerText().trim() === '') return;
  hostSubmits += 1;
  lastSubmitText = composerText();
  d.querySelector('[data-composer-input]').innerHTML = '<p><br></p>';
  d.dispatchEvent(new w.Event('selectionchange'));
  d.querySelector('.JZLxKW_grow').appendChild(d.createComment('react re-render'));
});

let finished = false;
setTimeout(() => {
  if (finished) return;
  for (const [status, line] of results) console.log(`${status}  ${line}`);
  console.log('\nHARNESS TIMEOUT: 用例没有跑完');
  process.exit(1);
}, 15000);
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
  check('插件能认出宿主的发送按钮', () => {
    const text = d.querySelector('.AkCqbG_bubble').firstChild;
    const range = d.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 2);
    const selection = w.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    d.dispatchEvent(new w.Event('selectionchange'));
    assert.ok(sendButton(), '测试夹具里的发送按钮不在');
  });
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

  // 只有批注、正文留空时点发送:批注必须作为正文发出去
  const before = hostSubmits;
  sendButton().dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(30);
  check('空正文 + 批注,点发送直接发出', () => assert.strictEqual(hostSubmits, before + 1));
  check('宿主收到的正文里有批注摘要', () => assert.ok(lastSubmitText.includes('〔引用批注 1「请帮我检'), JSON.stringify(lastSubmitText)));
  check('发出后批注卡与标记一并清掉', () => {
    assert.strictEqual(d.querySelector(CARD).style.display, 'none');
    assert.strictEqual(marker(), null);
  });
  check('这一次只发出一轮', () => assert.strictEqual(hostSubmits, before + 1));

  // 再次引用 → Enter
  await quoteOnce();
  const editor = d.querySelector('[data-composer-input]');
  editor.appendChild(d.createTextNode('〔引用批注 1「请帮我检查一下」：这里写错了〕'));
  d.querySelector('.JZLxKW_grow').appendChild(d.createComment('react re-render'));
  await sleep(30);
  editor.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(30);
  check('有批注时 Enter 只提交一次', () => assert.strictEqual(hostSubmits, before + 2));

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