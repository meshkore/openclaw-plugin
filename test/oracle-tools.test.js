import { test } from "node:test";
import assert from "node:assert/strict";
import { createOracleTools } from "../src/oracle-tools.js";
import { ORACLE_URL } from "../src/oracle-client.js";

function mockFetch(handler) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = handler;
	return () => {
		globalThis.fetch = originalFetch;
	};
}

function getState() {
	return { handle: "test-agent", ready: Promise.resolve() };
}

function jsonResponse(status, body) {
	return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test("request_service — never exposes agent_id/score, returns a plain quote", async () => {
	const restore = mockFetch(async (url) => {
		if (url === `${ORACLE_URL}/v1/search`) {
			return jsonResponse(200, {
				agents: [
					{ agent_id: "roomrover", description: "Hotel booking", oracle_score: 0.93, online: true, pricing: { amount: 120, currency: "USD" } }
				]
			});
		}
		if (String(url).startsWith(`${ORACLE_URL}/v1/reputation/`)) {
			return jsonResponse(200, { agent_id: "roomrover", score: 0, message_through_count: 0 });
		}
		throw new Error(`unexpected fetch: ${url}`);
	});
	try {
		const tools = createOracleTools(getState);
		const request = tools.find((t) => t.name === "request_service");
		const result = await request.execute({ request: "hotel en Barcelona" });
		assert.equal(result.found, true);
		assert.equal(result.confidence, "high");
		assert.equal(result.description, "Hotel booking");
		assert.ok(result.quote_id);
		assert.equal(result.agent_id, undefined);
		assert.equal(result.oracle_score, undefined);
	} finally {
		restore();
	}
});

test("request_service — low oracle_score AND not_yet_rated reputation yields low confidence, not hidden", async () => {
	const restore = mockFetch(async (url) => {
		if (url === `${ORACLE_URL}/v1/search`) {
			return jsonResponse(200, { agents: [{ agent_id: "unrelated-rag", description: "Some RAG repo", oracle_score: 0.7 }] });
		}
		if (String(url).startsWith(`${ORACLE_URL}/v1/reputation/`)) {
			return jsonResponse(200, { score: 0, message_through_count: 0 });
		}
		throw new Error(`unexpected fetch: ${url}`);
	});
	try {
		const tools = createOracleTools(getState);
		const request = tools.find((t) => t.name === "request_service");
		const result = await request.execute({ request: "vuelo a Roma" });
		assert.equal(result.found, true);
		assert.equal(result.confidence, "low");
	} finally {
		restore();
	}
});

test("request_service — no candidates found returns found:false", async () => {
	const restore = mockFetch(async () => jsonResponse(200, { agents: [] }));
	try {
		const tools = createOracleTools(getState);
		const request = tools.find((t) => t.name === "request_service");
		const result = await request.execute({ request: "comprar zapatos" });
		assert.equal(result.found, false);
	} finally {
		restore();
	}
});

test("request_service — an offline result is never high-confidence, even with a high raw score", async () => {
	// Verified live 2026-07-24: the Oracle's audience:personal filter falls
	// back to its full (mostly scraped, offline) pool when nothing genuinely
	// operational matches — that fallback is correct, but this tool must not
	// then call a high-scoring offline scraped repo "high confidence."
	const restore = mockFetch(async (url) => {
		if (url === `${ORACLE_URL}/v1/search`) {
			return jsonResponse(200, {
				agents: [{ agent_id: "offline-repo", description: "Some repo", oracle_score: 0.95, online: false }]
			});
		}
		if (String(url).startsWith(`${ORACLE_URL}/v1/reputation/`)) return jsonResponse(200, { score: 0, message_through_count: 0 });
		throw new Error(`unexpected fetch: ${url}`);
	});
	try {
		const tools = createOracleTools(getState);
		const request = tools.find((t) => t.name === "request_service");
		const result = await request.execute({ request: "anything" });
		assert.equal(result.confidence, "low");
	} finally {
		restore();
	}
});

// Shape of a real 2026-09 Oracle result (tablescout, verified live 2026-09-27).
const TABLESCOUT = {
	agent_id: "tablescout",
	description: "Restaurant search and booking",
	oracle_score: 1.39,
	online: true,
	operational: true,
	domain_match: true,
	free: true,
	pricing: { unit: "request", amount: 0, currency: "free" },
	endpoint: "https://dining.example.com",
	invoke: [
		{ skill: "search-restaurants", url: "https://dining.example.com/v1/search-restaurants" },
		{ skill: "book", url: "https://dining.example.com/v1/book" }
	]
};

test("request_service — an operational agent outranks a higher-ranked one that cannot answer", async () => {
	const restore = mockFetch(async (url) => {
		if (url === `${ORACLE_URL}/v1/search`) {
			return jsonResponse(200, {
				agents: [
					{ agent_id: "heartbeat-only", description: "Flashy", oracle_score: 1.5, online: true, operational: false, domain_match: true },
					{ ...TABLESCOUT, description: "Solid" }
				]
			});
		}
		throw new Error(`unexpected fetch: ${url}`);
	});
	try {
		const tools = createOracleTools(getState);
		const request = tools.find((t) => t.name === "request_service");
		const result = await request.execute({ request: "italian dinner in Barcelona" });
		assert.equal(result.description, "Solid");
		assert.equal(result.confidence, "high");
	} finally {
		restore();
	}
});

test("request_service — `online` alone is not operational, and a domain miss is low confidence", async () => {
	for (const agent of [
		{ agent_id: "a", oracle_score: 1.4, online: true, operational: false, domain_match: true },
		{ agent_id: "b", oracle_score: 1.4, online: true, operational: true, domain_match: false }
	]) {
		const restore = mockFetch(async () => jsonResponse(200, { agents: [agent] }));
		try {
			const request = createOracleTools(getState).find((t) => t.name === "request_service");
			const result = await request.execute({ request: "coffee near Plaza Catalunya" });
			assert.equal(result.confidence, "low", `agent ${agent.agent_id}`);
		} finally {
			restore();
		}
	}
});

test("request_service — surfaces free + actions, and free_only reaches the Oracle filter", async () => {
	let searchBody;
	const restore = mockFetch(async (url, opts) => {
		searchBody = JSON.parse(opts.body);
		return jsonResponse(200, { agents: [TABLESCOUT] });
	});
	try {
		const request = createOracleTools(getState).find((t) => t.name === "request_service");
		const result = await request.execute({ request: "cena italiana en Barcelona", free_only: true });
		assert.equal(searchBody.filters.free, true);
		assert.equal(searchBody.prompt, "cena italiana en Barcelona");
		assert.equal(result.free, true);
		assert.deepEqual(result.actions, ["search-restaurants", "book"]);
	} finally {
		restore();
	}
});

test("request_service — an empty result passes the Oracle's hint through", async () => {
	const restore = mockFetch(async () => jsonResponse(200, { agents: [], hint: "Try broader terms." }));
	try {
		const request = createOracleTools(getState).find((t) => t.name === "request_service");
		const result = await request.execute({ request: "traductor jurado barato" });
		assert.equal(result.found, false);
		assert.equal(result.hint, "Try broader terms.");
	} finally {
		restore();
	}
});

test("confirm_service — calls the verified invoke URL for the chosen action, no second lookup", async () => {
	const calledUrls = [];
	const restore = mockFetch(async (url) => {
		calledUrls.push(url);
		if (url === `${ORACLE_URL}/v1/search`) return jsonResponse(200, { agents: [TABLESCOUT] });
		if (url === "https://dining.example.com/v1/book") return jsonResponse(200, { status: "CONFIRMED_VENUE" });
		if (url === `${ORACLE_URL}/v1/feedback`) return jsonResponse(200, { status: "ok" });
		throw new Error(`unexpected fetch: ${url}`);
	});
	try {
		const tools = createOracleTools(getState);
		const quote = await tools.find((t) => t.name === "request_service").execute({ request: "dinner for two" });
		const result = await tools.find((t) => t.name === "confirm_service").execute({ quote_id: quote.quote_id, action: "book" });
		assert.equal(result.ok, true);
		assert.equal(calledUrls.filter((u) => u === `${ORACLE_URL}/v1/search`).length, 1, "the Oracle is searched once, not again on confirm");
		assert.ok(!calledUrls.some((u) => String(u).endsWith("/.well-known/agent.json")), "no card fetch when invoke is known");
	} finally {
		restore();
	}
});

test("confirm_service — an unknown action is refused, never silently swapped for another", async () => {
	const restore = mockFetch(async (url) => {
		if (url === `${ORACLE_URL}/v1/search`) return jsonResponse(200, { agents: [TABLESCOUT] });
		throw new Error(`no agent call expected: ${url}`);
	});
	try {
		const tools = createOracleTools(getState);
		const quote = await tools.find((t) => t.name === "request_service").execute({ request: "dinner for two" });
		const result = await tools.find((t) => t.name === "confirm_service").execute({ quote_id: quote.quote_id, action: "boook" });
		assert.equal(result.ok, false);
		assert.deepEqual(result.actions, ["search-restaurants", "book"]);
	} finally {
		restore();
	}
});

test("confirm_service — a quote from before a restart re-resolves through the Oracle's invoke[]", async () => {
	const calledUrls = [];
	const restore = mockFetch(async (url) => {
		calledUrls.push(url);
		if (url === `${ORACLE_URL}/v1/search`) return jsonResponse(200, { agents: [TABLESCOUT] });
		if (url === "https://dining.example.com/v1/book") return jsonResponse(200, { status: "CONFIRMED_VENUE" });
		if (url === `${ORACLE_URL}/v1/feedback`) return jsonResponse(200, { status: "ok" });
		throw new Error(`unexpected fetch: ${url}`);
	});
	try {
		// A fresh tool set knows no quotes — same as a restarted gateway.
		const quoteId = Buffer.from(JSON.stringify({ agentId: "tablescout", request: "dinner" })).toString("base64url");
		const result = await createOracleTools(getState).find((t) => t.name === "confirm_service").execute({ quote_id: quoteId, action: "book" });
		assert.equal(result.ok, true);
		assert.ok(calledUrls.includes("https://dining.example.com/v1/book"));
	} finally {
		restore();
	}
});

test("confirm_service — decodes the quote_id and contacts the right agent, fires feedback on success", async () => {
	const calledUrls = [];
	const restore = mockFetch(async (url) => {
		calledUrls.push(url);
		if (url === `${ORACLE_URL}/v1/search`) {
			return jsonResponse(200, {
				agents: [{ agent_id: "roomrover", description: "Hotel", oracle_score: 0.9, agent_card: { contact: { http: "https://roomrover.example.com" } } }]
			});
		}
		if (url === "https://roomrover.example.com/v1/search") return jsonResponse(200, { booked: true });
		if (url === `${ORACLE_URL}/v1/feedback`) return jsonResponse(200, { status: "ok" });
		if (String(url).startsWith(`${ORACLE_URL}/v1/reputation/`)) return jsonResponse(200, { score: 0, message_through_count: 0 });
		throw new Error(`unexpected fetch: ${url}`);
	});
	try {
		const tools = createOracleTools(getState);
		const request = tools.find((t) => t.name === "request_service");
		const confirm = tools.find((t) => t.name === "confirm_service");
		const quote = await request.execute({ request: "hotel en Barcelona" });
		const result = await confirm.execute({ quote_id: quote.quote_id });
		assert.equal(result.ok, true);
		await new Promise((r) => setTimeout(r, 0));
		assert.ok(calledUrls.includes(`${ORACLE_URL}/v1/feedback`));
	} finally {
		restore();
	}
});

test("confirm_service — a 402 surfaces the challenge and never fires feedback", async () => {
	const restore = mockFetch(async (url) => {
		if (url === `${ORACLE_URL}/v1/search`) {
			return jsonResponse(200, {
				agents: [{ agent_id: "paid-agent", description: "Paid service", oracle_score: 0.9, agent_card: { contact: { http: "https://paid.example.com" } } }]
			});
		}
		if (url === "https://paid.example.com/v1/search") return jsonResponse(402, { amount: 5, currency: "USDC" });
		if (String(url).startsWith(`${ORACLE_URL}/v1/reputation/`)) return jsonResponse(200, { score: 0, message_through_count: 0 });
		if (url === `${ORACLE_URL}/v1/feedback`) throw new Error("feedback must not be called on 402");
		throw new Error(`unexpected fetch: ${url}`);
	});
	try {
		const tools = createOracleTools(getState);
		const request = tools.find((t) => t.name === "request_service");
		const confirm = tools.find((t) => t.name === "confirm_service");
		const quote = await request.execute({ request: "paid thing" });
		const result = await confirm.execute({ quote_id: quote.quote_id });
		assert.equal(result.paymentRequired, true);
	} finally {
		restore();
	}
});

test("confirm_service — a 400 that explains itself in prose still becomes needs_info", async () => {
	// Not every agent names its missing fields in an array. foodlens answers
	// `{error:"bad_request", detail:'json body missing "image_base64"'}` — real
	// and actionable, but it used to fall through as a raw failure the model
	// could do nothing with. Verified live 2026-08-04 once the plugin could
	// reach that agent's path at all.
	const restore = mockFetch(async (url) => {
		if (url === `${ORACLE_URL}/v1/search`) {
			return jsonResponse(200, {
				agents: [{ agent_id: "foodlens", description: "Food analysis", oracle_score: 0.9, agent_card: { contact: { http: "https://foodlens.example.com" } } }]
			});
		}
		if (String(url).endsWith("/.well-known/agent.json")) return jsonResponse(404, {});
		if (String(url).startsWith(`${ORACLE_URL}/v1/reputation/`)) return jsonResponse(200, { score: 0, message_through_count: 0 });
		if (url === `${ORACLE_URL}/v1/feedback`) throw new Error("feedback must not fire on a 400");
		return jsonResponse(400, { error: "bad_request", detail: 'json body missing "image_base64"' });
	});
	try {
		const tools = createOracleTools(getState);
		const request = tools.find((t) => t.name === "request_service");
		const confirm = tools.find((t) => t.name === "confirm_service");
		const quote = await request.execute({ request: "what is in this food photo" });
		const result = await confirm.execute({ quote_id: quote.quote_id });
		assert.equal(result.needs_info, true);
		assert.match(result.hint, /image_base64/);
		// It must NOT invent field names out of a sentence.
		assert.equal(result.missing_fields, undefined);
	} finally {
		restore();
	}
});

test("confirm_service — an invalid quote_id fails clearly instead of throwing an opaque error", async () => {
	const tools = createOracleTools(getState);
	const confirm = tools.find((t) => t.name === "confirm_service");
	await assert.rejects(() => confirm.execute({ quote_id: "not-a-real-quote" }), /invalid or expired quote_id/);
});
