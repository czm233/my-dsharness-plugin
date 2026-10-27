// quote-selection — Codex 式划词引用:
// 1) 在聊天气泡里选中文字 → 浮出「引用」按钮;
// 2) 点击弹出小批注框(可选填想法),确认后以「> 引用 + 〔批注:…〕」插入输入框;
// 3) 输入框上方悬浮「N 条批注」胶囊,点击展开批注列表;正文里的批注被手动删掉时计数自动回落。
window.__ModuleLoader__.load({
  id: '@local/quote-selection',
  factory(require) {
    const BUTTON_ID = 'dsh-quote-selection-button';
    const CHIP_ID = 'dsh-quote-annotation-chip';
    const PANEL_ID = 'dsh-quote-annotation-panel';
    const POPOVER_ID = 'dsh-quote-comment-popover';
    const MARK_RE = /〔批注：([\s\S]*?)〕/g;

    function isVisible(el) {
      if (!el) return false;
      if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkVisibilityCSS: true });
      return el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
    }

    // 当前页面里可见的输入框(Lexical contenteditable 根,或兜底 textarea)。
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

    function composerText() {
      const composer = findComposer();
      return composer ? (composer.kind === 'textarea' ? composer.el.value : composer.el.textContent) || '' : '';
    }

    // 从输入框正文里解析批注:取每个批注标记及其前面的一段被引用文字。
    function parseAnnotations() {
      const text = composerText();
      const items = [];
      MARK_RE.lastIndex = 0;
      let match;
      while ((match = MARK_RE.exec(text)) !== null) {
        const before = text.slice(Math.max(0, match.index - 160), match.index);
        const quoteLines = before.split('\n').filter((line) => line.trim() !== '');
        const excerpt = (quoteLines[quoteLines.length - 1] || '').replace(/^>\s?/, '').trim();
        items.push({
          comment: match[1].trim(),
          excerpt: excerpt || '(引用文字)',
        });
      }
      return items;
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
        if (el.closest(`#${BUTTON_ID}, #${CHIP_ID}, #${PANEL_ID}, #${POPOVER_ID}`)) return null;
      }
      return { text, rect: sel.getRangeAt(0).getBoundingClientRect() };
    }

    function buildPayload(quote, comment) {
      const lines = quote.replace(/\r\n?/g, '\n').split('\n');
      while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
      let out = lines.map((line) => `> ${line}`).join('\n');
      if (comment && comment.trim()) out += `\n〔批注：${comment.trim()}〕`;
      return out + '\n\n';
    }

    // 把文本插入输入框光标处(Lexical 走合成粘贴,textarea 走原生 setter)。
    function insertIntoComposer(text) {
      const composer = findComposer();
      if (!composer) return false;
      const el = composer.el;
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
            button: '引用', placeholder: '添加可选批注…', confirm: '确认', cancel: '取消', empty: '输入框里还没有批注',
          };
          const chipLabel = (n) => `${n} 条批注`;

          const css = [
            `#${BUTTON_ID}, #${CHIP_ID}, #${PANEL_ID}, #${POPOVER_ID} {`,
            '  position: fixed; z-index: 2147483000; box-sizing: border-box;',
            '  font-family: inherit; user-select: none;',
            '}',
            `#${BUTTON_ID} {`,
            '  appearance: none; border: 1px solid rgba(255,255,255,0.14); border-radius: 8px;',
            '  padding: 4px 12px; font-size: 12px; line-height: 18px; cursor: pointer;',
            '  color: #e8e8ea; background: #343439; box-shadow: 0 6px 18px rgba(0,0,0,0.22);',
            '}',
            `#${BUTTON_ID}:hover { background: #3f3f46; }`,
            // 输入框上方的批注胶囊
            `#${CHIP_ID} {`,
            '  display: flex; align-items: center; gap: 6px;',
            '  border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;',
            '  padding: 4px 10px; font-size: 12px; line-height: 18px; cursor: pointer;',
            '  color: #cfcfd4; background: rgba(52,52,57,0.92); backdrop-filter: blur(6px);',
            '  box-shadow: 0 4px 14px rgba(0,0,0,0.25);',
            '}',
            `#${CHIP_ID}:hover { background: rgba(63,63,70,0.95); }`,
            `#${CHIP_ID} .dsh-quote-dot {`,
            '  width: 6px; height: 6px; border-radius: 999px; background: #4c8bf5; flex: none;',
            '}',
            // 批注列表面板
            `#${PANEL_ID} {`,
            '  width: 340px; max-height: 260px; overflow-y: auto;',
            '  border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 8px;',
            '  color: #e8e8ea; background: #2a2a2e; box-shadow: 0 12px 32px rgba(0,0,0,0.35);',
            '  font-size: 12px; line-height: 18px; user-select: text;',
            '}',
            `#${PANEL_ID} .dsh-quote-item { padding: 6px 8px; border-radius: 8px; }`,
            `#${PANEL_ID} .dsh-quote-item + .dsh-quote-item { margin-top: 2px; }`,
            `#${PANEL_ID} .dsh-quote-item:hover { background: rgba(255,255,255,0.06); }`,
            `#${PANEL_ID} .dsh-quote-excerpt { color: #9a9aa2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`,
            `#${PANEL_ID} .dsh-quote-comment { margin-top: 2px; color: #e8e8ea; }`,
            `#${PANEL_ID} .dsh-quote-empty { color: #9a9aa2; padding: 6px 8px; }`,
            // 批注弹窗(引用确认框)
            `#${POPOVER_ID} {`,
            '  width: min(440px, calc(100vw - 32px));',
            '  border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 10px;',
            '  color: #e8e8ea; background: #2f2f34; box-shadow: 0 16px 40px rgba(0,0,0,0.4);',
            '  display: flex; flex-direction: column; gap: 8px;',
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

          // ---- 批注胶囊 + 列表面板 ----
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.id = CHIP_ID;
          chip.style.display = 'none';
          chip.innerHTML = '<span class="dsh-quote-dot"></span><span class="dsh-quote-count"></span>';
          document.body.appendChild(chip);

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

          let currentText = null;
          let timer = 0;

          const hide = () => {
            currentText = null;
            button.style.display = 'none';
          };
          const hidePopover = () => {
            popover.style.display = 'none';
            popoverInput.value = '';
            popoverPreview.textContent = '';
          };
          const hideChipUi = () => {
            panel.style.display = 'none';
          };

          // ---- 胶囊:计数 + 定位 + 列表 ----
          let panelOpen = false;
          const refreshChip = () => {
            const items = parseAnnotations();
            const composer = findComposer();
            if (!composer || items.length === 0) {
              chip.style.display = 'none';
              hideChipUi();
              panelOpen = false;
              return;
            }
            chip.querySelector('.dsh-quote-count').textContent = chipLabel(items.length);
            chip.style.display = 'flex';
            const rect = composer.el.getBoundingClientRect();
            chip.style.left = `${Math.round(rect.left + 12)}px`;
            chip.style.top = `${Math.round(rect.top - 30)}px`;
            if (panelOpen) {
              panel.innerHTML = '';
              for (const item of items) {
                const row = document.createElement('div');
                row.className = 'dsh-quote-item';
                const ex = document.createElement('div');
                ex.className = 'dsh-quote-excerpt';
                ex.textContent = item.excerpt;
                const cm = document.createElement('div');
                cm.className = 'dsh-quote-comment';
                cm.textContent = item.comment ? `〔${item.comment}〕` : '(无批注文字)';
                row.append(ex, cm);
                panel.appendChild(row);
              }
              const prect = chip.getBoundingClientRect();
              panel.style.left = `${Math.round(prect.left)}px`;
              panel.style.top = `${Math.max(8, Math.round(prect.top - panel.offsetHeight - 8))}px`;
              panel.style.display = 'block';
            }
          };

          chip.addEventListener('click', () => {
            panelOpen = !panelOpen;
            if (!panelOpen) hideChipUi();
            else refreshChip();
          });

          // ---- 划词检测 ----
          const show = () => {
            timer = 0;
            const found = usableSelection();
            if (!found) {
              hide();
              return;
            }
            currentText = found.text;
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

          // ---- 引用 → 批注弹窗 ----
          const openPopover = () => {
            const composer = findComposer();
            if (!composer) return;
            popoverPreview.textContent = currentText || '';
            popover.style.display = 'flex';
            const rect = composer.el.getBoundingClientRect();
            const width = popover.offsetWidth || 440;
            let left = rect.left + rect.width / 2 - width / 2;
            left = Math.min(Math.max(left, 8), window.innerWidth - width - 8);
            popover.style.left = `${Math.round(left)}px`;
            popover.style.top = `${Math.round(Math.max(8, rect.top - popover.offsetHeight - 12))}px`;
            popoverInput.focus();
          };

          const confirmPopover = () => {
            const comment = popoverInput.value;
            const quote = popoverPreview.textContent;
            hidePopover();
            hide();
            if (!quote) return;
            try {
              if (!insertIntoComposer(buildPayload(quote, comment))) {
                console.warn('[quote-selection] no composer found');
              }
            } catch (error) {
              console.error('[quote-selection] insert failed:', error);
            }
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

          // 点击弹窗/胶囊/面板以外的地方收起。
          const onDocDown = (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest(`#${POPOVER_ID}, #${CHIP_ID}, #${PANEL_ID}, #${BUTTON_ID}`)) return;
            hidePopover();
            panelOpen = false;
            hideChipUi();
          };
          document.addEventListener('mousedown', onDocDown, true);

          document.addEventListener('selectionchange', schedule);
          window.addEventListener('scroll', () => { hide(); hideChipUi(); panelOpen = false; }, true);
          window.addEventListener('resize', hide);

          // 胶囊计数与位置持续纠位(输入框高度/位置随时会变)。
          const anchorTimer = setInterval(refreshChip, 500);
          refreshChip();

          return () => {
            clearInterval(anchorTimer);
            document.removeEventListener('selectionchange', schedule);
            document.removeEventListener('mousedown', onDocDown, true);
            if (timer !== 0) clearTimeout(timer);
            button.remove();
            chip.remove();
            panel.remove();
            popover.remove();
            style.remove();
          };
        });
      },
    };
  },
});
