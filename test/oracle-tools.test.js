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

test("search_agents — flags low-confidence results without hiding them", async () => {
	const restore = mockFetch(async () => ({
		ok: true,
		status: 200,
		text: async () =>
			JSON.stringify({
				agents: [
					{ agent_id: "real-flights", oracle_score: 0.92 },
					{ agent_id: "unrelated-rag", oracle_score: 0.7 }
				]
			})
	}));
	try {
		const tools = createOracleTools(getState);
		const search = tools.find((t) => t.name === "search_agents");
		const result = await search.execute({ query: "vuelo a Roma" });
		assert.equal(result.agents[0].low_confidence, false);
		assert.equal(result.agents[1].low_confidence, true);
	} finally {
		restore();
	}
});

test("contact_agent — fires feedback after a successful contact", async () => {
	const calledPaths = [];
	const restore = mockFetch(async (url) => {
		calledPaths.push(url);
		if (url === "https://agent.example.com/v1/search") {
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
		}
		if (url === `${ORACLE_URL}/v1/feedback`) {
			return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok" }) };
		}
		throw new Error(`unexpected fetch: ${url}`);
	});
	try {
		const tools = createOracleTools(getState);
		const contact = tools.find((t) => t.name === "contact_agent");
		await contact.execute({ agent_id: "food-vision", endpoint: "https://agent.example.com" });
		// Feedback is fire-and-forget — give the microtask queue a tick.
		await new Promise((r) => setTimeout(r, 0));
		assert.ok(calledPaths.includes(`${ORACLE_URL}/v1/feedback`));
	} finally {
		restore();
	}
});

test("contact_agent — a 402 never triggers a feedback call", async () => {
	let feedbackCalled = false;
	const restore = mockFetch(async (url) => {
		if (url === `${ORACLE_URL}/v1/feedback`) feedbackCalled = true;
		return { ok: false, status: 402, text: async () => JSON.stringify({ amount: 5, currency: "USDC" }) };
	});
	try {
		const tools = createOracleTools(getState);
		const contact = tools.find((t) => t.name === "contact_agent");
		const result = await contact.execute({ agent_id: "food-vision", endpoint: "https://agent.example.com" });
		assert.equal(result.paymentRequired, true);
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(feedbackCalled, false);
	} finally {
		restore();
	}
});

test("check_agent_reputation — passes through the Oracle response", async () => {
	const restore = mockFetch(async () => ({
		ok: true,
		status: 200,
		text: async () => JSON.stringify({ agent_id: "food-vision", score: 0.42 })
	}));
	try {
		const tools = createOracleTools(getState);
		const rep = tools.find((t) => t.name === "check_agent_reputation");
		const result = await rep.execute({ agent_id: "food-vision" });
		assert.equal(result.score, 0.42);
	} finally {
		restore();
	}
});
