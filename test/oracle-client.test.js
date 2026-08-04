import { test } from "node:test";
import assert from "node:assert/strict";
import { searchAgents, getReputation, sendFeedback, contactAgent, clearAgentCardCache, ORACLE_URL } from "../src/oracle-client.js";

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
		assert.equal(body.audience, "personal");
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

test("contactAgent — copies free-text `query` into `prompt` (real agents branch on prompt)", async () => {
	// Verified live 2026-08-04: MeshKore partner agents (roomrover, aerocast,
	// ticketlumen, ebay-finder) read `body.prompt`, ignore `query`, and 400
	// with `missing_fields` otherwise. contactAgent must send both.
	let sentBody;
	const restore = mockFetch(async (url, opts) => {
		sentBody = JSON.parse(opts.body);
		return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
	});
	try {
		await contactAgent({ endpoint: "https://agent.example.com", body: { query: "flight from Barcelona to Berlin" } });
		assert.equal(sentBody.prompt, "flight from Barcelona to Berlin", "query must be copied into prompt");
		assert.equal(sentBody.query, "flight from Barcelona to Berlin", "query is still sent for agents expecting that shape");
	} finally {
		restore();
	}
});

test("contactAgent — never overwrites a `prompt` the caller already set", async () => {
	let sentBody;
	const restore = mockFetch(async (url, opts) => {
		sentBody = JSON.parse(opts.body);
		return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
	});
	try {
		await contactAgent({ endpoint: "https://agent.example.com", body: { prompt: "explicit prompt", query: "different query" } });
		assert.equal(sentBody.prompt, "explicit prompt", "an existing prompt must be left untouched");
		assert.equal(sentBody.query, "different query");
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
	const seen = [];
	const restore = mockFetch(async (url) => {
		seen.push(url);
		if (url === `${ORACLE_URL}/v1/search`) {
			return {
				ok: true,
				status: 200,
				text: async () =>
					JSON.stringify({
						agents: [{ agent_id: "food-vision", agent_card: { contact: { http: "https://food-vision.example.com" } } }]
					})
			};
		}
		// The card lookup on the way to the skill call: no card here, so the
		// default path must still be used.
		if (url.endsWith("/.well-known/agent.json")) return { ok: false, status: 404, text: async () => "" };
		return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
	});
	try {
		clearAgentCardCache();
		const r = await contactAgent({ agentId: "food-vision" });
		assert.equal(r.ok, true);
		assert.deepEqual(seen, [
			`${ORACLE_URL}/v1/search`,
			"https://food-vision.example.com/.well-known/agent.json",
			"https://food-vision.example.com/v1/search"
		]);
	} finally {
		restore();
	}
});

test("contactAgent — resolves a top-level `endpoint` field, not just nested agent_card.endpoint", async () => {
	// Found live 2026-07-23: the real API puts `endpoint` directly on the
	// search result for some agents (e.g. roomrover), not nested under
	// agent_card at all — the retired skill's CLI type only checked the
	// nested shape, which would have failed silently against real data.
	let skillUrl;
	const restore = mockFetch(async (url) => {
		if (url === `${ORACLE_URL}/v1/search`) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ agents: [{ agent_id: "roomrover", endpoint: "https://roomrover.rjj.workers.dev" }] })
			};
		}
		if (url.endsWith("/.well-known/agent.json")) return { ok: false, status: 404, text: async () => "" };
		skillUrl = url;
		return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
	});
	try {
		clearAgentCardCache();
		const r = await contactAgent({ agentId: "roomrover" });
		assert.equal(r.ok, true);
		assert.equal(skillUrl, "https://roomrover.rjj.workers.dev/v1/search");
	} finally {
		restore();
	}
});

test("contactAgent — takes the skill path off the agent card when the caller pins none", async () => {
	// The bug this closes: the Oracle search result carries a bare origin and
	// an EMPTY agent_card (verified live 2026-08-04), so every call landed on
	// the /v1/search default. Agents whose skill lives elsewhere — foodlens
	// (/v1/analyze), lucid (/v1/text-to-image) — were discoverable by the
	// Oracle and permanently uncallable: 404, every time.
	let skillUrl;
	const restore = mockFetch(async (url) => {
		if (url === `${ORACLE_URL}/v1/search`) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ agents: [{ agent_id: "foodlens", endpoint: "https://foodlens.example.com" }] })
			};
		}
		if (url.endsWith("/.well-known/agent.json")) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ contact: { http: "https://food-vision.example.com/v1/analyze" } })
			};
		}
		skillUrl = url;
		return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
	});
	try {
		clearAgentCardCache();
		await contactAgent({ agentId: "foodlens" });
		// The PATH comes from the card; the HOST never does. foodlens really
		// advertises food-vision.agent.meshkore.com, a hostname with no DNS
		// record — trusting it would swap a 404 for a resolution failure.
		assert.equal(skillUrl, "https://foodlens.example.com/v1/analyze");
	} finally {
		restore();
	}
});

test("contactAgent — an explicit path always beats the card", async () => {
	let skillUrl, cardFetched = false;
	const restore = mockFetch(async (url) => {
		if (url.endsWith("/.well-known/agent.json")) {
			cardFetched = true;
			return { ok: true, status: 200, text: async () => JSON.stringify({ contact: { http: "https://a.example.com/v1/from-card" } }) };
		}
		skillUrl = url;
		return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
	});
	try {
		clearAgentCardCache();
		await contactAgent({ endpoint: "https://a.example.com", path: "/v1/pinned" });
		assert.equal(skillUrl, "https://a.example.com/v1/pinned");
		assert.equal(cardFetched, false, "a pinned path must not cost a card lookup");
	} finally {
		restore();
	}
});

test("contactAgent — an endpoint that already carries a path costs no card lookup", async () => {
	let cardFetched = false, skillUrl;
	const restore = mockFetch(async (url) => {
		if (url.endsWith("/.well-known/agent.json")) {
			cardFetched = true;
			return { ok: true, status: 200, text: async () => JSON.stringify({ contact: { http: "https://b.example.com/v1/other" } }) };
		}
		skillUrl = url;
		return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
	});
	try {
		clearAgentCardCache();
		await contactAgent({ endpoint: "https://b.example.com/v1/already-here" });
		assert.equal(skillUrl, "https://b.example.com/v1/already-here");
		assert.equal(cardFetched, false);
	} finally {
		restore();
	}
});

test("contactAgent — an unreachable card never breaks a reachable agent", async () => {
	// Path resolution is an optimisation. If the card 500s, times out, or comes
	// back as garbage, the call must still go out on the default path.
	let skillUrl;
	const restore = mockFetch(async (url) => {
		if (url.endsWith("/.well-known/agent.json")) throw new Error("network down");
		skillUrl = url;
		return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
	});
	try {
		clearAgentCardCache();
		const r = await contactAgent({ endpoint: "https://c.example.com" });
		assert.equal(r.ok, true);
		assert.equal(skillUrl, "https://c.example.com/v1/search");
	} finally {
		restore();
	}
});

test("contactAgent — the card is fetched once per origin, not once per call", async () => {
	let cardFetches = 0;
	const restore = mockFetch(async (url) => {
		if (url.endsWith("/.well-known/agent.json")) {
			cardFetches += 1;
			return { ok: true, status: 200, text: async () => JSON.stringify({ contact: { http: "https://d.example.com/v1/analyze" } }) };
		}
		return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
	});
	try {
		clearAgentCardCache();
		await contactAgent({ endpoint: "https://d.example.com" });
		await contactAgent({ endpoint: "https://d.example.com" });
		assert.equal(cardFetches, 1);
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
