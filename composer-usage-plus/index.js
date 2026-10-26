/**
 * Host half: serves the GLM Coding Plan quota snapshot to the Web page over the
 * authenticated /api fetch bridge, so the browser never touches the API key.
 *
 * Upstream endpoint (community-documented, unauthenticated-probe verified):
 *   GET {gateway}/api/monitor/usage/quota/limit
 *   Authorization: <api key>   (no Bearer prefix)
 *   -> { success: true, data: { tokenUsage5Hour: 45.2, mcpUsage1Month: 12.3 } }
 * Responses are cached briefly to stay well under the 60 req/min upstream limit.
 *
 * Kept dependency-free on purpose: this linked workspace bundle cannot resolve
 * shipped packages like @deepseek-ai/schemastery, so tunables are constants.
 */

const ROUTE_PATH = "/api/composer-usage.quota";
const CREDENTIAL_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const DEFAULT_GATEWAY = "https://open.bigmodel.cn/api/coding/paas/v4";
const API_KEY_ENV = "ZAI_CODING_CN_API_KEY";
const TTL_SECONDS = 30;

export const inject = ["connection", "credentials"];

export function apply(ctx) {
	const config = { gateway: DEFAULT_GATEWAY, apiKeyEnv: API_KEY_ENV, ttlSeconds: TTL_SECONDS };
	const cache = { at: 0, promise: null };

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
}
