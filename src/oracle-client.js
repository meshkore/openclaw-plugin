/**
 * oracle-client.js — thin wrapper over the public MeshKore Oracle
 * (search/reputation/feedback across the ~69,000+ agent directory —
 * NOT the Cluster/Wall/Board protocol, see mesh-client.js for that).
 *
 * Ported from the standalone `meshkore` CLI's client.ts
 * (.bkp/workspace-pre-split-2026-05-25/integrations/meshkore-cli/src/client.ts,
 * OCP11) after that skill was retired 2026-07-23 — same contract, same
 * endpoint, so this is a straight port, not a redesign. Zero OpenClaw
 * dependency, unit-testable standalone (see ../test/oracle-client.test.js).
 */

export const ORACLE_URL = "https://meshkore-oracle.rjj.workers.dev";
const USER_AGENT = "meshkore-plugin-oracle-client/0.2.0";
const REQUEST_TIMEOUT_MS = 12_000;

async function oracleRequest(method, path, body) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(`${ORACLE_URL}${path}`, {
			method,
			headers: {
				"user-agent": USER_AGENT,
				...(body !== undefined ? { "content-type": "application/json" } : {})
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: ctrl.signal
		});
		const text = await res.text();
		let parsed = null;
		if (text) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = null;
			}
		}
		if (!res.ok) {
			const err = new Error(`oracle ${method} ${path} -> ${res.status}`);
			err.status = res.status;
			err.body = parsed ?? { raw: text.slice(0, 500) };
			throw err;
		}
		if (parsed === null) {
			throw new Error(`oracle ${path} returned a non-JSON body`);
		}
		return parsed;
	} catch (err) {
		if (err.name === "AbortError") {
			throw new Error(`oracle ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * POST /v1/search — natural-language ranked search across the Oracle's
 * global agent/service directory. Same contract the retired `meshkore`
 * skill's CLI used (`meshkore search --json`).
 */
export function searchAgents(query, { limit, maxPriceUsd, tags, onlineOnly } = {}) {
	return oracleRequest("POST", "/v1/search", {
		query,
		source: "mesh",
		filters: {
			...(limit ? { limit } : {}),
			...(maxPriceUsd ? { max_price_usd: maxPriceUsd } : {}),
			...(tags ? { tags } : {}),
			...(onlineOnly !== undefined ? { online_only: onlineOnly } : {})
		}
	});
}

/** GET /v1/reputation/:agent_id — message-through reputation score (0..1). */
export function getReputation(agentId) {
	return oracleRequest("GET", `/v1/reputation/${encodeURIComponent(agentId)}`);
}

/**
 * POST /v1/feedback — tells the Oracle a real contact happened, so its
 * reputation system credits the agent. Internal — not meant to be its
 * own LLM-facing tool (mirrors the retired skill's own doc: "skill-internal,
 * don't expose to user UX"), fired automatically after a successful
 * `contactAgent()` call.
 */
export function sendFeedback({ requester, agentId, kind = "message_through", queryId }) {
	return oracleRequest("POST", "/v1/feedback", {
		requester,
		agent_id: agentId,
		kind,
		...(queryId !== undefined ? { query_id: queryId } : {})
	});
}

/**
 * Resolve an endpoint (direct URL, or agent_id looked up via the Oracle),
 * then POST a JSON body to it. Never holds or auto-pays a 402 challenge —
 * that comes back in the result for the caller (the plugin's tool layer,
 * ultimately the user) to decide on.
 */
export async function contactAgent({ agentId, endpoint, path = "/v1/search", body = {} }) {
	let targetEndpoint = endpoint;
	if (!targetEndpoint) {
		if (!agentId) throw new Error("contactAgent requires agentId or endpoint");
		const found = await searchAgents(agentId, { limit: 5 });
		const match = found.agents?.find((a) => a.agent_id === agentId);
		if (!match) {
			throw new Error(`agent "${agentId}" not found on the Oracle — try passing endpoint directly`);
		}
		targetEndpoint = match.agent_card?.contact?.http ?? match.agent_card?.endpoint;
		if (!targetEndpoint) {
			throw new Error(`agent "${agentId}" has no public HTTP endpoint in its agent_card`);
		}
	}

	const url = joinUrl(targetEndpoint, path);
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "user-agent": USER_AGENT, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: ctrl.signal
		});
		const text = await res.text();
		let parsed = null;
		try {
			parsed = text ? JSON.parse(text) : null;
		} catch {
			parsed = null;
		}
		if (res.status === 402) {
			return { ok: false, paymentRequired: true, challenge: parsed ?? { raw: text.slice(0, 500) } };
		}
		if (!res.ok) {
			return { ok: false, status: res.status, detail: parsed ?? { raw: text.slice(0, 500) } };
		}
		return { ok: true, status: res.status, data: parsed };
	} catch (err) {
		if (err.name === "AbortError") {
			return { ok: false, error: `agent ${url} timed out after ${REQUEST_TIMEOUT_MS}ms` };
		}
		return { ok: false, error: `agent ${url} network error: ${err.message}` };
	} finally {
		clearTimeout(timer);
	}
}

function joinUrl(endpoint, path) {
	try {
		const u = new URL(endpoint);
		const hasMeaningfulPath = u.pathname !== "" && u.pathname !== "/";
		if (hasMeaningfulPath) return endpoint.replace(/\/+$/, "");
	} catch {
		// fall through — caller errors on the bad URL during fetch
	}
	const cleanEnd = endpoint.replace(/\/+$/, "");
	return path.startsWith("/") ? `${cleanEnd}${path}` : `${cleanEnd}/${path}`;
}
