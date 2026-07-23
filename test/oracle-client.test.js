import { test } from "node:test";
import assert from "node:assert/strict";
import { searchAgents, getReputation, sendFeedback, contactAgent, ORACLE_URL } from "../src/oracle-client.js";

function mockFetch(handler) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = handler;
	return () => {
		globalThis.fetch = originalFetch;
	};
}

test("searchAgents — posts to /v1/search with query + filters", async () => {
	let calledUrl, calledOpts;
	const restore = mockFetch(async (url, opts) => {
		calledUrl = url;
		calledOpts = opts;
		return { ok: true, status: 200, text: async () => JSON.stringify({ agents: [], count: 0 }) };
	});
	try {
		await searchAgents("vuelo a Roma", { limit: 3 });
		assert.equal(calledUrl, `${ORACLE_URL}/v1/search`);
		const body = JSON.parse(calledOpts.body);
		assert.equal(body.query, "vuelo a Roma");
		assert.equal(body.filters.limit, 3);
	} finally {
		restore();
	}
});

test("getReputation — GETs the encoded agent id path", async () => {
	let calledUrl, calledOpts;
	const restore = mockFetch(async (url, opts) => {
		calledUrl = url;
		calledOpts = opts;
		return { ok: true, status: 200, text: async () => JSON.stringify({ agent_id: "food vision", score: 0.8 }) };
	});
	try {
		const r = await getReputation("food vision");
		assert.equal(calledUrl, `${ORACLE_URL}/v1/reputation/food%20vision`);
		assert.equal(calledOpts.method, "GET");
		assert.equal(r.score, 0.8);
	} finally {
		restore();
	}
});

test("sendFeedback — posts requester/agent_id/kind", async () => {
	let calledOpts;
	const restore = mockFetch(async (_url, opts) => {
		calledOpts = opts;
		return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok" }) };
	});
	try {
		await sendFeedback({ requester: "me", agentId: "food-vision" });
		const body = JSON.parse(calledOpts.body);
		assert.equal(body.requester, "me");
		assert.equal(body.agent_id, "food-vision");
		assert.equal(body.kind, "message_through");
	} finally {
		restore();
	}
});

test("oracleRequest — non-2xx throws with status + body", async () => {
	const restore = mockFetch(async () => ({
		ok: false,
		status: 404,
		text: async () => JSON.stringify({ error: "not_found" })
	}));
	try {
		await assert.rejects(() => getReputation("ghost"), (err) => {
			assert.equal(err.status, 404);
			assert.deepEqual(err.body, { error: "not_found" });
			return true;
		});
	} finally {
		restore();
	}
});

test("contactAgent — direct endpoint, success", async () => {
	let calledUrl;
	const restore = mockFetch(async (url) => {
		calledUrl = url;
		return { ok: true, status: 200, text: async () => JSON.stringify({ hello: "world" }) };
	});
	try {
		const r = await contactAgent({ endpoint: "https://agent.example.com", path: "/v1/do-thing", body: { x: 1 } });
		assert.equal(calledUrl, "https://agent.example.com/v1/do-thing");
		assert.equal(r.ok, true);
		assert.deepEqual(r.data, { hello: "world" });
	} finally {
		restore();
	}
});

test("contactAgent — 402 returns the challenge, never auto-pays", async () => {
	const restore = mockFetch(async () => ({
		ok: false,
		status: 402,
		text: async () => JSON.stringify({ amount: 1000, currency: "USDC", network: "base", address: "0xabc" })
	}));
	try {
		const r = await contactAgent({ endpoint: "https://agent.example.com" });
		assert.equal(r.ok, false);
		assert.equal(r.paymentRequired, true);
		assert.equal(r.challenge.amount, 1000);
	} finally {
		restore();
	}
});

test("contactAgent — resolves agent_id via the Oracle when no endpoint given", async () => {
	let calls = 0;
	const restore = mockFetch(async (url) => {
		calls += 1;
		if (calls === 1) {
			assert.equal(url, `${ORACLE_URL}/v1/search`);
			return {
				ok: true,
				status: 200,
				text: async () =>
					JSON.stringify({
						agents: [{ agent_id: "food-vision", agent_card: { contact: { http: "https://food-vision.example.com" } } }]
					})
			};
		}
		assert.equal(url, "https://food-vision.example.com/v1/search");
		return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
	});
	try {
		const r = await contactAgent({ agentId: "food-vision" });
		assert.equal(r.ok, true);
		assert.equal(calls, 2);
	} finally {
		restore();
	}
});

test("contactAgent — unknown agent_id fails clearly, no silent fallback", async () => {
	const restore = mockFetch(async () => ({
		ok: true,
		status: 200,
		text: async () => JSON.stringify({ agents: [] })
	}));
	try {
		await assert.rejects(() => contactAgent({ agentId: "ghost-agent" }), /not found on the Oracle/);
	} finally {
		restore();
	}
});
