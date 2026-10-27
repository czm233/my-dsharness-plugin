// quote-selection — Codex 式划词引用:
// 1) 气泡里划词 → 「引用」按钮 → 弹出可选批注框;
// 2) 确认后,引用作为「批注卡」挂在输入框卡片(JZLxKW_card,column flex)的顶部第一行,
//    像放了张图片的附件;正文完全不动,从卡片下方开始输入;
// 3) 点发送(或 Enter)的瞬间,在 capture 阶段把「> 引用 + 〔批注〕」同步注入正文,随消息发出;
// 4) 批注卡可点开列表面板,逐条删除;发送后自动清空。
window.__ModuleLoader__.load({
  id: '@local/quote-selection',
  factory(require) {
    const CARD_ID = 'dsh-quote-annotation-card';
    const PANEL_ID = 'dsh-quote-annotation-panel';
    const POPOVER_ID = 'dsh-quote-comment-popover';
    const BUTTON_ID = 'dsh-quote-selection-button';
    // 2026-10-27 构建的哈希类名(升级会变,见 PITFALLS #12;均带启发式兜底)。
    const COMPOSER_CARD_CLASS = 'JZLxKW_card';
    const SEND_BUTTON_CLASS = 'JZLxKW_primary';

    function isVisible(el) {
      if (!el) return false;
      if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkVisibilityCSS: true });
      return el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
    }

    function findComposer() {
      const editors = document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"]');
      for (let i = editors.length - 1; i >= 0; i -= 1) {
        if (isVisible(editors[i])) return { kind: 'lexical', el: editors[i] };
      }
      const areas = document.querySelectorAll('textarea');
      for (let i = areas.length - 1; i >= 0; i -= 1) {
        if (isVisible(areas[i])) return { kind: 'textarea', el: areas[i] };
      }
      return null;
    }

    // 输入框的外层卡片容器:优先哈希类名,兜底用「圆角 + flex 容器」启发式。
    function findComposerCard() {
      const composer = findComposer();
      if (!composer) return null;
      const byClass = composer.el.closest(`.${COMPOSER_CARD_CLASS}`);
      if (byClass) return byClass;
      let el = composer.el.parentElement;
      for (let hops = 0; el && hops < 8; hops += 1, el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (parseFloat(cs.borderRadius) >= 8 && cs.display.includes('flex')) return el;
      }
      return composer.el.parentElement;
    }

    // 发送按钮:卡片容器内的圆形主按钮(哈希类名优先,兜底找最右边的圆形按钮)。
    function findSendButton(card) {
      if (!card) return null;
      const byClass = card.querySelector(`.${SEND_BUTTON_CLASS}`);
      if (byClass && isVisible(byClass)) return byClass;
      let best = null;
      for (const button of card.querySelectorAll('button')) {
        if (!isVisible(button)) continue;
        const cs = getComputedStyle(button);
        if (parseFloat(cs.borderRadius) < 12) continue;
        if (!best || button.getBoundingClientRect().left > best.getBoundingClientRect().left) best = button;
      }
      return best;
    }

    // 选区是否可引用:非空、有实际文字、不在输入框/可编辑区域内。
    function usableSelection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const text = sel.toString();
      if (!text || !text.trim()) return null;
      const anchor = sel.anchorNode;
      if (!anchor || !document.contains(anchor.nodeType === 1 ? anchor : anchor.parentElement)) return null;
      const startEl = anchor.nodeType === 1 ? anchor : anchor.parentElement;
      const focusEl = sel.focusNode && (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
      for (const el of [startEl, focusEl]) {
        if (!el) continue;
        if (el.closest('[data-lexical-editor], textarea, input, [contenteditable="true"], [contenteditable=""]')) return null;
        if (el.closest(`#${BUTTON_ID}, #${CARD_ID}, #${PANEL_ID}, #${POPOVER_ID}`)) return null;
      }
      return { text, rect: sel.getRangeAt(0).getBoundingClientRect() };
    }

    // 把文本插入输入框光标处(Lexical 走合成粘贴,textarea 走原生 setter)。
    // leadingNewline:光标前已有文字时先补一个换行,避免引用块和正文粘在一行。
    function insertIntoComposer(text, leadingNewline = false) {
      const composer = findComposer();
      if (!composer) return false;
      const el = composer.el;
      if (leadingNewline) {
        const current = (composer.kind === 'textarea' ? el.value : el.textContent) || '';
        const caret = composer.kind === 'textarea' ? (el.selectionStart ?? current.length) : current.length;
        const before = current.slice(0, caret);
        if (before.length > 0 && !before.endsWith('\n')) text = `\n${text}`;
      }
      if (composer.kind === 'textarea') {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        el.focus();
        const next = el.value.slice(0, start) + text + el.value.slice(end);
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, next);
        el.selectionStart = el.selectionEnd = start + text.length;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        el.dispatchEvent(event);
        if (event.defaultPrevented) return true;
      } catch (error) {
        console.warn('[quote-selection] synthetic paste failed, falling back:', error);
      }
      return document.execCommand('insertText', false, text);
    }

    return {
      inject: ['locale'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined;
          const t = {
            button: '引用', placeholder: '添加可选批注…', confirm: '确认', cancel: '取消',
            chip: (n) => `${n} 条批注`, remove: '删除',
          };

          const css = [
            `#${BUTTON_ID}, #${CARD_ID}, #${PANEL_ID}, #${POPOVER_ID} {`,
            '  position: fixed; z-index: 2147483000; box-sizing: border-box;',
            '  font-family: inherit;',
            '}',
            `#${BUTTON_ID} {`,
            '  appearance: none; border: 1px solid rgba(255,255,255,0.14); border-radius: 8px;',
            '  padding: 4px 12px; font-size: 12px; line-height: 18px; cursor: pointer;',
            '  color: #e8e8ea; background: #343439; box-shadow: 0 6px 18px rgba(0,0,0,0.22);',
            '  user-select: none;',
            '}',
            `#${BUTTON_ID}:hover { background: #3f3f46; }`,
            // 输入框内部的批注卡(附件样式;内容自适应宽度,不占满整行)
            `#${CARD_ID} {`,
            '  position: static;',
            '  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;',
            '  align-self: flex-start; width: fit-content; max-width: calc(100% - 24px);',
            '  margin: 0 12px;',
            '  border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;',
            '  padding: 5px 8px 5px 10px; font-size: 12px; line-height: 18px;',
            '  color: #cfcfd4; background: rgba(255,255,255,0.04);',
            '  user-select: none;',
            '}',
            `#${CARD_ID} .dsh-quote-dot {`,
            '  width: 14px; height: 14px; border-radius: 4px; flex: none;',
            '  background: rgba(76,139,245,0.25); color: #7aa7f8; font-size: 10px; line-height: 14px;',
            '  text-align: center;',
            '}',
            `#${CARD_ID} .dsh-quote-summary {`,
            '  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
            '  color: #cfcfd4;',
            '}',
            `#${CARD_ID} .dsh-quote-clear {`,
            '  appearance: none; border: none; background: transparent; color: #8a8a92;',
            '  cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 6px; flex: none;',
            '}',
            `#${CARD_ID} .dsh-quote-clear:hover { background: rgba(255,255,255,0.08); color: #e8e8ea; }`,
            // 批注列表面板(悬浮,不进输入框)
            `#${PANEL_ID} {`,
            '  width: 380px; max-height: 300px; overflow-y: auto;',
            '  border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 4px 14px;',
            '  color: #e8e8ea; background: #1f1f23; box-shadow: 0 16px 40px rgba(0,0,0,0.45);',
            '  font-size: 12px; line-height: 18px; user-select: text;',
            '}',
            `#${PANEL_ID} .dsh-quote-item { padding: 10px 0; }`,
            `#${PANEL_ID} .dsh-quote-item + .dsh-quote-item { border-top: 1px solid rgba(255,255,255,0.07); }`,
            `#${PANEL_ID} .dsh-quote-line { display: flex; align-items: center; gap: 8px; }`,
            `#${PANEL_ID} .dsh-quote-body { flex: 1; min-width: 0; }`,
            `#${PANEL_ID} .dsh-quote-head { color: #8f8f97; margin-bottom: 2px; }`,
            `#${PANEL_ID} .dsh-quote-excerpt { color: #e8e8ea; white-space: pre-wrap; word-break: break-word; }`,
            `#${PANEL_ID} .dsh-quote-comment-label { color: #8f8f97; margin-top: 6px; }`,
            `#${PANEL_ID} .dsh-quote-comment { color: #e8e8ea; white-space: pre-wrap; word-break: break-word; }`,
            `#${PANEL_ID} .dsh-quote-tools { display: flex; gap: 4px; flex: none; }`,
            `#${PANEL_ID} .dsh-quote-remove {`,
            '  appearance: none; border: none; background: transparent; color: #8a8a92;',
            '  cursor: pointer; font-size: 12px; padding: 0 4px; border-radius: 6px; flex: none;',
            '}',
            `#${PANEL_ID} .dsh-quote-remove:hover { color: #f28b82; }`,
            // 批注弹窗(引用确认框)
            `#${POPOVER_ID} {`,
            '  width: min(440px, calc(100vw - 32px));',
            '  border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 10px;',
            '  color: #e8e8ea; background: #2f2f34; box-shadow: 0 16px 40px rgba(0,0,0,0.4);',
            '  display: flex; flex-direction: column; gap: 8px; z-index: 2147483001;',
            '}',
            `#${POPOVER_ID} .dsh-quote-preview {`,
            '  max-height: 96px; overflow-y: auto; padding: 8px 10px;',
            '  border-radius: 8px; background: rgba(255,255,255,0.05); color: #b8b8c0;',
            '  font-size: 12px; line-height: 18px; white-space: pre-wrap; word-break: break-word;',
            '  user-select: text;',
            '}',
            `#${POPOVER_ID} textarea {`,
            '  resize: none; height: 44px; padding: 8px 10px; font-size: 13px; line-height: 18px;',
            '  border-radius: 10px; border: 1px solid rgba(255,255,255,0.12);',
            '  background: rgba(255,255,255,0.04); color: #e8e8ea; outline: none; font-family: inherit;',
            '}',
            `#${POPOVER_ID} textarea::placeholder { color: #8a8a92; }`,
            `#${POPOVER_ID} textarea:focus { border-color: rgba(76,139,245,0.6); }`,
            `#${POPOVER_ID} .dsh-quote-actions { display: flex; justify-content: flex-end; gap: 8px; }`,
            `#${POPOVER_ID} button {`,
            '  appearance: none; border: none; border-radius: 8px; padding: 4px 14px;',
            '  font-size: 12px; line-height: 20px; cursor: pointer;',
            '}',
            `#${POPOVER_ID} .dsh-quote-cancel { background: rgba(255,255,255,0.08); color: #cfcfd4; }`,
            `#${POPOVER_ID} .dsh-quote-confirm { background: #4c8bf5; color: #fff; font-weight: 600; }`,
          ].join('\n');
          const style = document.createElement('style');
          style.dataset.plugin = '@local/quote-selection';
          style.textContent = css;
          document.head.appendChild(style);

          // ---- 划词按钮 ----
          const button = document.createElement('button');
          button.type = 'button';
          button.id = BUTTON_ID;
          button.textContent = t.button;
          button.style.display = 'none';
          document.body.appendChild(button);

          // ---- 批注卡(插入输入框卡片顶行) ----
          const card = document.createElement('div');
          card.id = CARD_ID;
          card.style.display = 'none';
          document.body.appendChild(card); // 平时寄存在 body,ensureAnchor 时再搬进输入框

          // ---- 批注列表面板 ----
          const panel = document.createElement('div');
          panel.id = PANEL_ID;
          panel.style.display = 'none';
          document.body.appendChild(panel);

          // ---- 批注弹窗 ----
          const popover = document.createElement('div');
          popover.id = POPOVER_ID;
          popover.style.display = 'none';
          popover.innerHTML = [
            '<div class="dsh-quote-preview"></div>',
            '<textarea class="dsh-quote-input"></textarea>',
            '<div class="dsh-quote-actions">',
            `  <button type="button" class="dsh-quote-cancel">${t.cancel}</button>`,
            `  <button type="button" class="dsh-quote-confirm">${t.confirm}</button>`,
            '</div>',
          ].join('\n');
          document.body.appendChild(popover);
          const popoverInput = popover.querySelector('.dsh-quote-input');
          const popoverPreview = popover.querySelector('.dsh-quote-preview');

          // 批注仓库:确认一条存一条;发送瞬间统一注入正文后清空。
          const store = [];
          let currentText = null;
          let currentRect = null;
          let timer = 0;
          let lastInjectAt = 0;
          let editingIndex = -1; // >=0 时弹窗处于「修改」模式

          const hide = () => {
            currentText = null;
            currentRect = null;
            button.style.display = 'none';
          };
          const hidePopover = () => {
            popover.style.display = 'none';
            popoverInput.value = '';
            popoverPreview.textContent = '';
            editingIndex = -1;
          };

          // ---- 批注卡:持续锚定在输入框卡片第一行 ----
          let panelOpen = false;
          const ensureAnchor = () => {
            const composerCard = findComposerCard();
            if (!composerCard || store.length === 0) {
              if (card.style.display !== 'none') {
                card.style.display = 'none';
                document.body.appendChild(card); // 撤回寄存
                panelOpen = false;
                panel.style.display = 'none';
              }
              return;
            }
            if (card.parentElement !== composerCard || composerCard.firstElementChild !== card) {
              composerCard.insertBefore(card, composerCard.firstChild);
            }
            if (card.style.display === 'none') card.style.display = 'flex';
          };

          const renderCard = () => {
            card.innerHTML = '';
            const dot = document.createElement('span');
            dot.className = 'dsh-quote-dot';
            dot.textContent = '❝';
            const summary = document.createElement('span');
            summary.className = 'dsh-quote-summary';
            summary.textContent = t.chip(store.length);
            summary.title = store.map((item) => item.quote).join('\n---\n');
            const clear = document.createElement('button');
            clear.type = 'button';
            clear.className = 'dsh-quote-clear';
            clear.textContent = '✕';
            clear.title = '移除全部批注';
            clear.addEventListener('click', (event) => {
              event.stopPropagation();
              store.length = 0;
              renderCard();
              ensureAnchor();
              panelOpen = false;
              panel.style.display = 'none';
            });
            card.append(dot, summary, clear);
          };

          const renderPanel = () => {
            if (!panelOpen || store.length === 0) {
              panel.style.display = 'none';
              return;
            }
            panel.innerHTML = '';
            store.forEach((item, index) => {
              const row = document.createElement('div');
              row.className = 'dsh-quote-item';
              const line = document.createElement('div');
              line.className = 'dsh-quote-line';
              const body = document.createElement('div');
              body.className = 'dsh-quote-body';
              const head = document.createElement('div');
              head.className = 'dsh-quote-head';
              head.textContent = `${index + 1}. 选中文字：`;
              const ex = document.createElement('div');
              ex.className = 'dsh-quote-excerpt';
              ex.textContent = item.quote;
              body.append(head, ex);
              if (item.comment) {
                const label = document.createElement('div');
                label.className = 'dsh-quote-comment-label';
                label.textContent = '批注：';
                const cm = document.createElement('div');
                cm.className = 'dsh-quote-comment';
                cm.textContent = item.comment;
                body.append(label, cm);
              }
              const tools = document.createElement('div');
              tools.className = 'dsh-quote-tools';
              const edit = document.createElement('button');
              edit.type = 'button';
              edit.className = 'dsh-quote-remove';
              edit.textContent = '✎';
              edit.title = '修改';
              edit.addEventListener('click', (event) => {
                event.stopPropagation();
                editingIndex = index;
                openPopoverFor(item);
              });
              const remove = document.createElement('button');
              remove.type = 'button';
              remove.className = 'dsh-quote-remove';
              remove.textContent = '🗑';
              remove.title = t.remove;
              remove.addEventListener('click', (event) => {
                event.stopPropagation();
                store.splice(index, 1);
                renderCard();
                ensureAnchor();
                if (store.length === 0) {
                  panelOpen = false;
                  panel.style.display = 'none';
                } else {
                  renderPanel();
                }
              });
              tools.append(edit, remove);
              line.append(body, tools);
              row.appendChild(line);
              panel.appendChild(row);
            });
            // 先按卡片上方可用空间限高,再显示、量实际高度、贴上方定位。
            // (先 display 再量高度会量到 0,导致面板往下展开超出屏幕。)
            const cardRect = card.getBoundingClientRect();
            panel.style.maxHeight = `${Math.max(120, Math.round(cardRect.top - 16))}px`;
            panel.style.display = 'block';
            panel.style.left = `${Math.round(cardRect.left)}px`;
            panel.style.top = `${Math.max(8, Math.round(cardRect.top - panel.offsetHeight - 8))}px`;
          };

          card.addEventListener('click', () => {
            panelOpen = !panelOpen;
            if (panelOpen) renderPanel();
            else panel.style.display = 'none';
          });

          // ---- 发送拦截:capture 阶段同步注入,再放行原生发送 ----
          // 注入用紧凑单行摘要(类似 Codex 的气泡观感):被引文字本就在上方
          // 历史里,给模型一个可定位的片段 + 批注即可,不整段展开。
          const compactBlock = (item, index) => {
            const q = item.quote.replace(/\s+/g, ' ').trim();
            const excerpt = q.length > 16 ? `${q.slice(0, 16)}…` : q;
            return `〔引用批注 ${index + 1}「${excerpt}」${item.comment ? `：${item.comment}` : ''}〕`;
          };
          const flushBeforeSend = () => {
            if (store.length === 0) return false;
            const now = Date.now();
            if (now - lastInjectAt < 200) return false; // 防同一次发送双触发
            lastInjectAt = now;
            const payload = store.map(compactBlock).join('\n') + '\n';
            try {
              if (!insertIntoComposer(payload, true)) return false;
            } catch (error) {
              console.error('[quote-selection] flush failed:', error);
              return false;
            }
            store.length = 0;
            renderCard();
            ensureAnchor();
            panelOpen = false;
            panel.style.display = 'none';
            return true;
          };
          const tryFlush = () => {
            try { flushBeforeSend(); } catch (error) { console.error(error); }
          };

          document.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
            const target = event.target;
            if (!(target instanceof Element) || !target.closest('[data-lexical-editor], textarea')) return;
            tryFlush();
          }, true);
          document.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const composerCard = findComposerCard();
            const send = findSendButton(composerCard);
            if (send && (send === target || send.contains(target))) tryFlush();
          }, true);

          // ---- 划词检测 ----
          const show = () => {
            timer = 0;
            const found = usableSelection();
            if (!found) {
              hide();
              return;
            }
            currentText = found.text;
            currentRect = found.rect;
            const margin = 8;
            const width = Math.max(button.offsetWidth, 60);
            let left = found.rect.left + found.rect.width / 2 - width / 2;
            left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
            let top = found.rect.top - 36;
            if (top < margin) top = found.rect.bottom + margin;
            button.style.left = `${Math.round(left)}px`;
            button.style.top = `${Math.round(top)}px`;
            button.style.display = 'block';
          };
          const schedule = () => {
            if (timer !== 0) clearTimeout(timer);
            timer = setTimeout(show, 150);
          };

          // ---- 引用 → 批注弹窗(新增贴选区上方;修改贴输入框上方) ----
          const placePopover = (anchorRect) => {
            const width = popover.offsetWidth || 440;
            const height = popover.offsetHeight || 140;
            const margin = 8;
            let anchor = anchorRect;
            if (!anchor || (anchor.top === 0 && anchor.left === 0)) {
              anchor = findComposerCard()?.getBoundingClientRect()
                || findComposer().el.getBoundingClientRect();
            }
            let left = anchor.left + anchor.width / 2 - width / 2;
            left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
            // 默认弹在锚点上方;顶部放不下就挪到下方。
            let top = anchor.top - height - margin;
            if (top < margin) top = anchor.bottom + margin;
            popover.style.left = `${Math.round(left)}px`;
            popover.style.top = `${Math.round(Math.max(margin, top))}px`;
          };

          const openPopover = () => {
            if (!findComposer()) return;
            popoverPreview.textContent = currentText || '';
            popoverInput.value = '';
            popover.style.display = 'flex';
            placePopover(currentRect);
            popoverInput.focus();
          };

          // 面板「修改」入口:回填引用与批注,确认后原地更新。
          const openPopoverFor = (item) => {
            if (!findComposer()) return;
            popoverPreview.textContent = item.quote;
            popoverInput.value = item.comment || '';
            popover.style.display = 'flex';
            placePopover(findComposerCard()?.getBoundingClientRect());
            popoverInput.focus();
          };

          const confirmPopover = () => {
            const comment = popoverInput.value;
            const quote = popoverPreview.textContent;
            const target = editingIndex; // hidePopover 会重置 editingIndex,先存下来
            hidePopover();
            hide();
            if (!quote) return;
            if (target >= 0 && target < store.length) {
              store[target] = { quote, comment };
            } else {
              store.push({ quote, comment });
            }
            renderCard();
            ensureAnchor();
            if (panelOpen) renderPanel();
          };

          button.addEventListener('mousedown', (event) => event.preventDefault());
          button.addEventListener('click', () => {
            if (!currentText) return;
            window.getSelection()?.removeAllRanges();
            openPopover();
          });
          popover.querySelector('.dsh-quote-cancel').addEventListener('click', hidePopover);
          popover.querySelector('.dsh-quote-confirm').addEventListener('click', confirmPopover);
          popoverInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              confirmPopover();
            } else if (event.key === 'Escape') {
              event.stopPropagation();
              hidePopover();
            }
          });

          // 点弹窗/批注卡/面板以外的地方收起弹窗与面板。
          const onDocDown = (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest(`#${POPOVER_ID}, #${CARD_ID}, #${PANEL_ID}, #${BUTTON_ID}`)) return;
            hidePopover();
            panelOpen = false;
            panel.style.display = 'none';
          };
          document.addEventListener('mousedown', onDocDown, true);

          document.addEventListener('selectionchange', schedule);
          window.addEventListener('scroll', hide, true);
          window.addEventListener('resize', hide);

          // 持续纠位:宿主随时重建输入框 DOM(见 PITFALLS #2/#6)。
          const anchorTimer = setInterval(ensureAnchor, 500);
          const observer = new MutationObserver(ensureAnchor);
          observer.observe(document.body, { childList: true, subtree: true });
          ensureAnchor();

          return () => {
            clearInterval(anchorTimer);
            observer.disconnect();
            document.removeEventListener('selectionchange', schedule);
            document.removeEventListener('mousedown', onDocDown, true);
            if (timer !== 0) clearTimeout(timer);
            button.remove();
            card.remove();
            panel.remove();
            popover.remove();
            style.remove();
          };
        });
      },
    };
  },
});
