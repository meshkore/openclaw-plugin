/**
 * oracle-tools.js — OCP12: task-shaped tool catalog over the Oracle client
 * (oracle-client.js). Separate module from tools.js on purpose: the Oracle's
 * global agent/service directory (~69,000+ agents) is a completely
 * different, much larger catalog than the MeshKore Cluster/Wall/Board
 * network tools.js covers.
 *
 * REDESIGNED 2026-07-23 (OCP12, supersedes OCP11's search_agents/
 * contact_agent/check_agent_reputation) per the operator's product
 * critique: a personal OpenClaw user never thinks in terms of "search for
 * agents," "contact an agent," or "check an agent's reputation" — nobody
 * says "hire an agent to find me a hotel." They say "book me a hotel."
 * The mesh's agent/contact/reputation mechanics are implementation detail,
 * not something to expose as LLM-facing tools. So: two tools shaped
 * around outcomes, not mechanism — `request_service` (find + evaluate)
 * and `confirm_service` (actually reach out, only after the user agreed).
 * `agent_id`/`oracle_score`/reputation numbers never reach the LLM/user;
 * they're internal ranking signals only.
 */

import { Type } from "typebox";
import { searchAgents, getReputation, contactAgent, sendFeedback } from "./oracle-client.js";

/**
 * Relevance floor for the WINNING candidate — found live 2026-07-23
 * (OMSK-3/OCP11): common personal queries ("vuelo a Roma", "traductor
 * legal") return mostly unrelated dev-tooling/research repos, not real
 * consumer services, because the Oracle's catalog has no personal/
 * professional audience taxonomy yet (verified: `agent_card.category`/
 * `tags` are empty on every real result sampled). Below this score, the
 * result is still returned but marked low-confidence so the LLM says so
 * plainly instead of presenting a guess as a firm match.
 */
const LOW_CONFIDENCE_SCORE = 0.75;

function encodeQuoteId(agentId, request) {
	return Buffer.from(JSON.stringify({ agentId, request }), "utf8").toString("base64url");
}

function decodeQuoteId(quoteId) {
	try {
		return JSON.parse(Buffer.from(quoteId, "base64url").toString("utf8"));
	} catch {
		throw new Error("invalid or expired quote_id");
	}
}

/**
 * Combines the Oracle's own semantic ranking with reputation, when
 * reputation actually has data. Verified live 2026-07-23 (a real bug this
 * check caught): the real API does NOT reliably return a `status:
 * "not_yet_rated"` marker — a brand-new, genuinely good hotel agent
 * (`roomrover`, oracle_score 0.93, real capabilities match) came back as
 * `{score: 0, message_through_count: 0, impression_count: 1}` with no
 * `status` field at all, which the original (wrong) check treated as a
 * real, bad rating and dragged a strong match down to "low confidence."
 * The robust signal for "no real track record yet" is `message_through_count`
 * being 0/absent — NOT the presence of any particular `status` string.
 */
async function scoreCandidate(agent) {
	const base = agent.oracle_score ?? 0;
	try {
		const rep = await getReputation(agent.agent_id);
		const hasTrackRecord = typeof rep.score === "number" && (rep.message_through_count ?? 0) > 0;
		if (!hasTrackRecord) return base;
		return base * 0.7 + rep.score * 0.3;
	} catch {
		return base;
	}
}

/**
 * @param {() => {handle?: string, ready: Promise<void>}} getState
 * @param {{log?: (msg: string) => void}} [opts]
 */
export function createOracleTools(getState, { log = () => {} } = {}) {
	async function ctx() {
		const state = getState();
		await state.ready;
		return state;
	}

	function withLogging(tool) {
		const { execute, ...rest } = tool;
		return {
			...rest,
			execute: async (params, ...args) => {
				log(`[meshkore-tool] ${tool.name} args=${JSON.stringify(params)}`);
				return execute(params, ...args);
			}
		};
	}

	return [
		{
			name: "request_service",
			label: "Ask for anything a third party could do for you",
			description:
				"Ask for ANYTHING you'd want a real-world provider to do — book a flight/hotel/car, buy a " +
				"product, get a translation or professional service done, find a restaurant, anything a " +
				"person would normally search a website or call a business for. Describe it in plain " +
				"language, exactly as the user said it — this finds and evaluates the best match across " +
				"69,000+ providers automatically. This is a DIFFERENT, much larger catalog than " +
				"discover_clusters/Boards (which only cover the MeshKore Cluster/Wall/Board network) — use " +
				"this one for real-world services, not for anything about clusters/Boards/Wall. Present the " +
				"result as a plain outcome to the user — never mention 'agent', 'provider id', 'score', or " +
				"'reputation'; those are internal. If nothing good was found, say so plainly rather than " +
				"guessing. If a result is low-confidence, say that too, don't present it as a firm match. " +
				"When the user agrees to proceed, call confirm_service with the returned quote_id.",
			parameters: Type.Object({
				request: Type.String({ description: "The user's request, verbatim." }),
				budget_max: Type.Optional(Type.Number({ description: "Max price in USD, if the user gave one." }))
			}),
			execute: async ({ request, budget_max }) => {
				await ctx();
				const result = await searchAgents(request, { limit: 5, maxPriceUsd: budget_max });
				const candidates = result.agents ?? [];
				if (!candidates.length) {
					return { found: false, reason: "no matching provider found" };
				}
				const scored = await Promise.all(
					candidates.slice(0, 3).map(async (a) => ({ agent: a, score: await scoreCandidate(a) }))
				);
				scored.sort((a, b) => b.score - a.score);
				const winner = scored[0];
				// Real data found empty `description` fields in production (e.g. a genuinely
				// good hotel match, 2026-07-23) — fall back to capabilities so the LLM still
				// has something presentable, without resorting to internal fields like agent_id.
				const description =
					winner.agent.description?.trim() ||
					(winner.agent.capabilities?.length ? winner.agent.capabilities.join(", ") : "a matching provider");
				// Verified live 2026-07-24: the Oracle's `audience: "personal"` filter
				// (oracle-personal-audience) falls back to its full, mostly-scraped
				// pool when NOTHING operational matches (e.g. "traductor legal
				// barato" → an offline academic RAG paper) — that fallback is
				// correct (never silently return zero), but this tool must not then
				// call it "high confidence" just because its raw score is high. A
				// result that isn't actually online is never high-confidence here,
				// regardless of score.
				const isOperational = winner.agent.online === true;
				return {
					found: true,
					description,
					pricing: winner.agent.pricing ?? winner.agent.agent_card?.pricing ?? null,
					confidence: isOperational && winner.score >= LOW_CONFIDENCE_SCORE ? "high" : "low",
					quote_id: encodeQuoteId(winner.agent.agent_id, request)
				};
			}
		},
		{
			name: "confirm_service",
			label: "Actually go through with a request_service result",
			description:
				"Complete a request from request_service — ONLY call this after the user has explicitly " +
				"agreed to what request_service found (the description/price shown). This is the step that " +
				"actually reaches out to the provider; it may come back needing payment (always surfaced to " +
				"the user for approval, this never pays on its own) or needing more specific details (e.g. a " +
				"hotel needs exact check-in/check-out dates, not just 'a hotel in Barcelona') — if the result " +
				"has `needs_info`, ask the user for exactly those fields and call this again with `details` " +
				"filled in, using the same quote_id.",
			parameters: Type.Object({
				quote_id: Type.String(),
				details: Type.Optional(
					Type.Any({ description: "Structured fields the provider asked for (e.g. {city, checkin, checkout}), from a prior needs_info response." })
				)
			}),
			execute: async ({ quote_id, details }) => {
				const { handle } = await ctx();
				const { agentId, request } = decodeQuoteId(quote_id);
				const result = await contactAgent({ agentId, body: { query: request, ...(details ?? {}) } });
				// Verified live 2026-07-23: real booking-style agents (e.g. a hotel)
				// reject a bare NL query with a structured 400 listing what they
				// actually need (`{error: "missing_fields", need: [...]}`)  — surface
				// that plainly instead of a raw failure, so the LLM can ask and retry.
				const missing = result.status === 400 ? result.detail?.need ?? result.detail?.missing_fields : undefined;
				if (Array.isArray(missing) && missing.length) {
					return { ok: false, needs_info: true, missing_fields: missing, quote_id };
				}
				// Not every agent names its missing fields in an array. foodlens
				// answers `{error, detail: 'json body missing "image_base64"'}` —
				// a real, actionable complaint that used to be swallowed as a raw
				// failure. Pass the sentence through without inventing field names
				// from it, so the LLM can ask for the right thing.
				if (result.status === 400 && typeof result.detail?.detail === "string") {
					return { ok: false, needs_info: true, hint: result.detail.detail, quote_id };
				}
				if (result.ok && handle) {
					sendFeedback({ requester: handle, agentId }).catch(() => {});
				}
				return result;
			}
		}
	].map(withLogging);
}
