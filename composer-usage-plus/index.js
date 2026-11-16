/**
 * Host half: serves plan quota snapshots to the Web page over the authenticated
 * /api fetch bridge, so the browser never touches a credential.
 *
 * Two upstreams, picked by the page per channel:
 * - GLM Coding Plan (zai channels), fetched here with the configured API key.
 *   GET {gateway}/api/monitor/usage/quota/limit
 *   Authorization: <api key>   (no Bearer prefix)
 *   -> { success: true, data: { tokenUsage5Hour: 45.2, mcpUsage1Month: 12.3 } }
 * - Bailian Token Plan (qwen channels), delegated to the token-plan-quota skill's
 *   script, which owns the console protocol, the token file and the browser login.
 * Responses are cached briefly to stay well under the upstream rate limits.
 *
 * Kept dependency-free on purpose: this linked workspace bundle cannot resolve
 * shipped packages like @deepseek-ai/schemastery, so tunables are constants.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROUTE_PATH = "/api/composer-usage.quota";
const DAILY_ROUTE_PATH = "/api/composer-usage.daily";
const BAILIAN_ROUTE_PATH = "/api/composer-usage.bailian";
const LOGIN_ROUTE_PATH = "/api/composer-usage.login";
const CREDENTIAL_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const DEFAULT_GATEWAY = "https://open.bigmodel.cn/api/coding/paas/v4";
const API_KEY_ENV = "ZAI_CODING_CN_API_KEY";
const TTL_SECONDS = 30;
const DAILY_TTL_SECONDS = 60;

export const inject = ["connection", "credentials"];

export function apply(ctx) {
	const config = { gateway: DEFAULT_GATEWAY, apiKeyEnv: API_KEY_ENV, ttlSeconds: TTL_SECONDS };
	const cache = { at: 0, promise: null };
	const dailyCache = { at: 0, promise: null };

	ctx.effect(
		function () {
			const connection = Reflect.get(ctx, "connection");
			if (connection === void 0) return undefined;
			return connection.fetch.register({
				path: ROUTE_PATH,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: function () {
					return handle();
				}
			});
		},
		"composer-usage-plus: quota route"
	);

	ctx.effect(
		function () {
			const connection = Reflect.get(ctx, "connection");
			if (connection === void 0) return undefined;
			return connection.fetch.register({
				path: DAILY_ROUTE_PATH,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: function () {
					return handleDaily();
				}
			});
		},
		"composer-usage-plus: daily route"
	);

	ctx.effect(
		function () {
			const connection = Reflect.get(ctx, "connection");
			if (connection === void 0) return undefined;
			return connection.fetch.register({
				path: BAILIAN_ROUTE_PATH,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: function () {
					return handleBailian();
				}
			});
		},
		"composer-usage-plus: bailian quota route"
	);

	ctx.effect(
		function () {
			const connection = Reflect.get(ctx, "connection");
			if (connection === void 0) return undefined;
			return connection.fetch.register({
				path: LOGIN_ROUTE_PATH,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: function () {
					return handleLogin();
				}
			});
		},
		"composer-usage-plus: bailian login route"
	);

	async function resolveKey() {
		const name = config.apiKeyEnv;
		try {
			if (typeof name === "string" && CREDENTIAL_NAME_PATTERN.test(name)) {
				const credentials = Reflect.get(ctx, "credentials");
				if (credentials !== void 0) {
					const hit = await credentials.resolve(name);
					if (hit !== void 0 && typeof hit.value === "string" && hit.value.length > 0) return hit.value;
				}
			}
		} catch {
			// fall through to the launch environment
		}
		const fromEnv = process.env[name];
		return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : null;
	}

	async function upstream() {
		const key = await resolveKey();
		if (key === null) return { ok: false, reason: "missing-api-key", gateway: config.gateway, body: null };
		// The monitor endpoints live at the gateway's domain root — the official
		// plugin derives them from the base URL's origin, dropping the /api/coding/
		// paas/v4 prefix that only applies to chat-completion routes.
		const url = new URL("/api/monitor/usage/quota/limit", config.gateway).toString();
		const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(8000) : undefined;
		const response = await fetch(url, {
			headers: { Authorization: key, Accept: "application/json" },
			signal
		});
		const text = await response.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			body = { raw: text.slice(0, 400) };
		}
		return { ok: response.ok, status: response.status, gateway: config.gateway, body };
	}

	async function handle() {
		const ttl = Math.max(5, Number(config.ttlSeconds) || 30) * 1000;
		const now = Date.now();
		if (cache.promise === null || now - cache.at >= ttl) {
			cache.at = now;
			cache.promise = upstream().catch(function (error) {
				return { ok: false, reason: String((error && error.message) || error), gateway: config.gateway, body: null };
			});
		}
		const body = await cache.promise;
		return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
	}

	/** "YYYY-MM-DD HH:mm:ss" in the host's local time, the format the monitor API expects. */
	function monitorStamp(date, endOfDay) {
		const pad = function (value) {
			return String(value).padStart(2, "0");
		};
		return (
			date.getFullYear() +
			"-" +
			pad(date.getMonth() + 1) +
			"-" +
			pad(date.getDate()) +
			" " +
			(endOfDay === true ? "23:59:59" : "00:00:00")
		);
	}

	async function upstreamDaily() {
		const key = await resolveKey();
		if (key === null) return { ok: false, reason: "missing-api-key", body: null };
		const now = new Date();
		const query =
			"startTime=" +
			encodeURIComponent(monitorStamp(now, false)) +
			"&endTime=" +
			encodeURIComponent(monitorStamp(now, true));
		const url = new URL("/api/monitor/usage/model-usage?" + query, config.gateway).toString();
		const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(8000) : undefined;
		const response = await fetch(url, {
			headers: { Authorization: key, Accept: "application/json" },
			signal
		});
		const text = await response.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			body = { raw: text.slice(0, 400) };
		}
		return { ok: response.ok, status: response.status, body };
	}

	async function handleDaily() {
		const ttl = Math.max(30, DAILY_TTL_SECONDS) * 1000;
		const now = Date.now();
		if (dailyCache.promise === null || now - dailyCache.at >= ttl) {
			dailyCache.at = now;
			dailyCache.promise = upstreamDaily().catch(function (error) {
				return { ok: false, reason: String((error && error.message) || error), body: null };
			});
		}
		const body = await dailyCache.promise;
		return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
	}

	// Bailian Token Plan quota lives in the token-plan-quota skill, which already
	// owns the console protocol, the credential file and the browser login flow.
	// Running its script keeps that knowledge (and the endpoint) out of this repo.

	function skillScript() {
		const home =
			typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() !== ""
				? process.env.DSH_HOME.trim()
				: path.join(os.homedir(), ".dsh");
		return path.join(home, "skills", "token-plan-quota", "scripts", "quota.py");
	}

	function pythonBinary() {
		// Launched from Finder the app inherits a minimal PATH; prefer the system python.
		return existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
	}

	function runQuota(args, timeoutMs) {
		return new Promise(function (resolve) {
			const script = skillScript();
			if (!existsSync(script)) {
				resolve({ ok: false, reason: "no-skill" });
				return;
			}
			execFile(pythonBinary(), [script].concat(args), { timeout: timeoutMs, maxBuffer: 1 << 20 }, function (error, stdout) {
				if (error) {
					if (error.code === 2) resolve({ ok: false, reason: "no-token" });
					else if (error.code === 3) resolve({ ok: false, reason: "expired" });
					else resolve({ ok: false, reason: "script" });
					return;
				}
				let parsed = null;
				try {
					parsed = JSON.parse(String(stdout));
				} catch {
					parsed = null;
				}
				if (parsed === null || typeof parsed !== "object") {
					resolve({ ok: false, reason: "shape" });
					return;
				}
				resolve(Object.assign({ ok: true, kind: "bailian" }, parsed));
			});
		});
	}

	async function handleBailian() {
		const body = await runQuota(["--json"], 20000);
		return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
	}

	// One authorisation at a time: the script serves the 127.0.0.1 callback and
	// opens the console page, then writes the token file itself (0600).
	let loginChild = null;

	function startLogin() {
		if (loginChild !== null) return { ok: true, pending: true };
		const script = skillScript();
		if (!existsSync(script)) return { ok: false, reason: "no-skill" };
		try {
			const child = spawn(pythonBinary(), [script, "login"], { detached: true, stdio: "ignore" });
			child.on("exit", function () {
				loginChild = null;
			});
			child.on("error", function () {
				loginChild = null;
			});
			child.unref();
			loginChild = child;
		} catch {
			return { ok: false, reason: "spawn" };
		}
		return { ok: true, pending: false };
	}

	async function handleLogin() {
		const body = startLogin();
		return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
	}
}
