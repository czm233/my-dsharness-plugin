// quote-selection — 划词引用:在聊天气泡里选中一段文字,浮出「引用」按钮,
// 点击后以 Markdown 引用格式(> 前缀)插入底部输入框。
window.__ModuleLoader__.load({
  id: '@local/quote-selection',
  factory(require) {
    const BUTTON_ID = 'dsh-quote-selection-button';

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
        if (el.closest(`#${BUTTON_ID}`)) return null;
      }
      return { text, rect: sel.getRangeAt(0).getBoundingClientRect() };
    }

    function quoteText(text) {
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
      return lines.map((line) => `> ${line}`).join('\n') + '\n\n';
    }

    function insertIntoComposer(text) {
      const composer = findComposer();
      if (!composer) return false;
      const payload = quoteText(text);
      const el = composer.el;
      if (composer.kind === 'textarea') {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        el.focus();
        const next = el.value.slice(0, start) + payload + el.value.slice(end);
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, next);
        el.selectionStart = el.selectionEnd = start + payload.length;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      // Lexical:把光标挪到编辑器末尾,再合成一次粘贴,让 Lexical 自己消化文本。
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', payload);
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        el.dispatchEvent(event);
        if (event.defaultPrevented) return true;
      } catch (error) {
        console.warn('[quote-selection] synthetic paste failed, falling back:', error);
      }
      // 兜底:execCommand 的 insertText 会派发 beforeinput,Lexical 同样能接住。
      return document.execCommand('insertText', false, payload);
    }

    return {
      inject: ['locale'],
      apply(ctx) {
        ctx.locale.register('quoteSelection', {
          zh: { button: '引用' },
          en: { button: 'Quote' },
        });
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined;
          const label = '引用'; // 界面主语言为中文;保留 locale 注册以便日后接翻译。

          const style = document.createElement('style');
          style.dataset.plugin = '@local/quote-selection';
          style.textContent = [
            `#${BUTTON_ID} {`,
            '  position: fixed;',
            '  z-index: 2147483000;',
            '  appearance: none;',
            '  border: 1px solid rgba(255,255,255,0.14);',
            '  border-radius: 8px;',
            '  padding: 4px 12px;',
            '  font-size: 12px;',
            '  line-height: 18px;',
            '  cursor: pointer;',
            '  color: #e8e8ea;',
            '  background: #343439;',
            '  box-shadow: 0 6px 18px rgba(0,0,0,0.22);',
            '  user-select: none;',
            '}',
            `#${BUTTON_ID}:hover { background: #3f3f46; }`,
          ].join('\n');
          document.head.appendChild(style);

          const button = document.createElement('button');
          button.type = 'button';
          button.id = BUTTON_ID;
          button.textContent = label;
          button.style.display = 'none';
          document.body.appendChild(button);

          let currentText = null;
          let timer = 0;

          const hide = () => {
            currentText = null;
            button.style.display = 'none';
          };

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

          // mousedown 上抢先阻止默认行为,保住选区不被点击抹掉。
          button.addEventListener('mousedown', (event) => event.preventDefault());
          button.addEventListener('click', () => {
            const text = currentText;
            hide();
            if (!text) return;
            try {
              if (!insertIntoComposer(text)) console.warn('[quote-selection] no composer found');
            } catch (error) {
              console.error('[quote-selection] insert failed:', error);
            }
          });

          document.addEventListener('selectionchange', schedule);
          window.addEventListener('scroll', hide, true);
          window.addEventListener('resize', hide);

          return () => {
            document.removeEventListener('selectionchange', schedule);
            window.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
            if (timer !== 0) clearTimeout(timer);
            button.remove();
            style.remove();
          };
        });
      },
    };
  },
});
