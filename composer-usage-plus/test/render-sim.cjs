#!/usr/bin/env node
/**
 * Gate: the panel must render the channel-appropriate quota section from the
 * envelope the host route returns, without a browser.
 *
 *   node composer-usage-plus/test/render-sim.cjs
 *
 * Loads the real client.js, runs its component against a minimal React double
 * (hooks are positional; effects are not executed, they only fetch), and reads
 * the resulting element tree.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

function loadModule(seedStates) {
  const hooks = { order: 0, states: seedStates };
  const React = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2);
      return { type: type, props: props || {}, children: children };
    },
    useState(initial) {
      const index = hooks.order++;
      if (!(index in hooks.states)) hooks.states[index] = initial;
      return [
        hooks.states[index],
        function (next) {
          hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next;
        },
      ];
    },
    useEffect() {},
    useLayoutEffect() {},
    useRef(value) {
      return { current: value };
    },
    useCallback(fn) {
      return fn;
    },
  };
  const ReactDOM = { createPortal(node) { return node; } };
  const element = { style: {}, dataset: {}, remove() {} };
  const document = {
    createElement() { return element; },
    head: { appendChild() {} },
    body: {},
    addEventListener() {},
    removeEventListener() {},
  };
  const captured = {};
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          captured.definition = definition;
        },
      },
      addEventListener() {},
      removeEventListener() {},
      innerWidth: 1280,
      innerHeight: 800,
    },
    document: document,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  const requireStub = function (name) {
    if (name === 'react') return React;
    if (name === 'react-dom') return ReactDOM;
    throw new Error('unexpected require: ' + name);
  };
  const module = captured.definition.factory(requireStub);

  let Component = null;
  const ctx = {
    effect(fn) {
      fn();
    },
    locale: { register() {} },
    slots: {
      inject(_slot, fn) { fn(); },
      register(_definition, component) {
        Component = component;
      },
    },
  };
  module.apply(ctx);
  assert.ok(typeof Component === 'function', 'component registered');
  return Component;
}

function render(provider, envelope) {
  const Component = loadModule([true, null, { at: Date.now(), envelope: envelope }, null, false]);
  const t = function (key, params) {
    return params === undefined ? key : key + '(' + JSON.stringify(params) + ')';
  };
  const useProjection = function (name) {
    if (name === 'tokenUsage') return { uncachedInputTokens: 1200, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };
    if (name === 'modelSelection') return { next: { provider: provider, model: 'deepseek-v4-pro' } };
    return undefined;
  };
  const tree = Component({ useProjection: useProjection, t: t });
  const strings = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') {
      strings.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      if (node.props && typeof node.props.title === 'string') strings.push(node.props.title);
      (node.children || []).forEach(walk);
    }
  })(tree);
  return strings.join(' | ');
}

function expect(text, needle, label) {
  assert.ok(text.indexOf(needle) >= 0, label + ': expected "' + needle + '" in\n' + text);
}

// Bailian (qwen channel): one monthly bar, credits in the tooltip, no 5h/7d badges.
const bailian = render('qwen-token-plan-cn', {
  ok: true,
  kind: 'bailian',
  plan: 'pro',
  percentageUsed: 0.25,
  resetTime: '2026-11-30 00:00',
  creditsTotal: 200000,
  creditsUsed: 50000,
  subscriptionEnds: '2026-12-01',
});
expect(bailian, 'usage.quotaMonth', 'bailian bar label');
expect(bailian, 'usage.quotaLeft({"left":"75.0"})', 'bailian remaining percent');
expect(bailian, '50,000 / 200,000 Credits', 'bailian credits tooltip');
expect(bailian, '2026-11-30 00:00', 'bailian reset time');
assert.ok(bailian.indexOf('usage.quota5h') < 0, 'bailian has no 5-hour bar');

// Bailian without a local token: keep the error text and offer the login button.
const needsAuth = render('qwen-token-plan-cn', { ok: false, reason: 'no-token' });
expect(needsAuth, 'usage.quotaNoToken', 'auth reason text');
expect(needsAuth, 'usage.auth', 'authorize button');

// Expired token behaves the same.
const expired = render('qwen-token-plan-cn', { ok: false, reason: 'expired' });
expect(expired, 'usage.quotaExpired', 'expired reason text');
expect(expired, 'usage.auth', 'authorize button after expiry');

// GLM channel keeps its own three bars and must never show the login button.
const zai = render('zai-coding-cn', {
  ok: true,
  body: {
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 40, nextResetTime: Date.now() + 3600000 },
        { type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: Date.now() + 86400000 },
      ],
    },
  },
});
expect(zai, 'usage.quota5h', 'zai 5-hour bar');
expect(zai, 'usage.quotaWeek', 'zai weekly bar');
assert.ok(zai.indexOf('usage.auth') < 0, 'zai never offers the bailian login');
assert.ok(zai.indexOf('usage.quotaMonth') < 0, 'zai has no monthly bar');

console.log('render sim OK: bailian bar + auth button + zai bars');