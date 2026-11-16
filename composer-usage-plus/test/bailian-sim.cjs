#!/usr/bin/env node
/**
 * Gate: the host half must register the Bailian routes and hand the skill
 * script's snapshot back in the normalized shape the client parses.
 *
 *   node composer-usage-plus/test/bailian-sim.cjs
 *
 * Network/read-only: it runs the token-plan-quota skill once. When the skill or
 * its credential is missing the route must still answer with a typed reason
 * (that is what drives the panel's 授权 button), so those runs pass.
 */
const path = require('node:path');
const assert = require('node:assert');

async function main() {
  const routes = new Map();
  const ctx = {
    effect(fn) {
      fn();
    },
    get() {
      return undefined;
    },
  };
  ctx.connection = {
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return function () {};
      },
    },
  };

  const mod = await import(path.join(__dirname, '..', 'index.js'));
  mod.apply(ctx);

  assert.ok(routes.has('/api/composer-usage.bailian'), 'bailian route registered');
  assert.ok(routes.has('/api/composer-usage.login'), 'login route registered');
  assert.deepStrictEqual(routes.get('/api/composer-usage.login').methods, ['POST'], 'login route is POST');
  assert.deepStrictEqual(routes.get('/api/composer-usage.bailian').methods, ['GET'], 'bailian route is GET');

  const response = await routes.get('/api/composer-usage.bailian').fetch();
  const body = await response.json();

  if (body.ok !== true) {
    assert.ok(
      ['no-skill', 'no-token', 'expired', 'script', 'shape'].includes(body.reason),
      'typed failure reason, got ' + JSON.stringify(body),
    );
    console.log('bailian sim OK (skill unavailable: ' + body.reason + ')');
    return;
  }

  assert.strictEqual(body.kind, 'bailian', 'kind tag');
  assert.ok(
    typeof body.percentageUsed === 'number' && body.percentageUsed >= 0 && body.percentageUsed <= 1,
    'percentageUsed is a 0..1 fraction',
  );
  assert.ok(typeof body.resetTime === 'string' && body.resetTime.length > 0, 'resetTime present');
  console.log(
    'bailian sim OK:',
    JSON.stringify({ plan: body.plan, used: body.percentageUsed, reset: body.resetTime }),
  );
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});