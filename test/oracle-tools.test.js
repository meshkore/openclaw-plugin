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

test("request_service — reputation picks the better-rated candidate over a higher raw score", async () => {
	const restore = mockFetch(async (url, opts) => {
		if (url === `${ORACLE_URL}/v1/search`) {
			return jsonResponse(200, {
				agents: [
					{ agent_id: "flashy-but-unrated", description: "Flashy", oracle_score: 0.85 },
					{ agent_id: "solid-reputation", description: "Solid", oracle_score: 0.8 }
				]
			});
		}
		if (String(url).includes("/v1/reputation/flashy-but-unrated")) return jsonResponse(200, { score: 0, message_through_count: 0 });
		if (String(url).includes("/v1/reputation/solid-reputation")) return jsonResponse(200, { score: 0.99, message_through_count: 12 });
		throw new Error(`unexpected fetch: ${url} ${JSON.stringify(opts)}`);
	});
	try {
		const tools = createOracleTools(getState);
		const request = tools.find((t) => t.name === "request_service");
		// flashy: 0.85 (no rep data, unpenalized) vs solid: 0.8*0.7 + 0.99*0.3 = 0.857 — solid should win.
		const result = await request.execute({ request: "anything" });
		assert.equal(result.description, "Solid");
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

test("confirm_service — an invalid quote_id fails clearly instead of throwing an opaque error", async () => {
	const tools = createOracleTools(getState);
	const confirm = tools.find((t) => t.name === "confirm_service");
	await assert.rejects(() => confirm.execute({ quote_id: "not-a-real-quote" }), /invalid or expired quote_id/);
});
