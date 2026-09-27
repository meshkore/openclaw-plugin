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
import { searchAgents, contactAgent, sendFeedback, pickInvoke } from "./oracle-client.js";
import { describeToolCall } from "./redact.js";

/**
 * Relevance floor, used ONLY for results that predate the Oracle's
 * `domain_match` flag. Found live 2026-07-23 (OMSK-3/OCP11): common personal
 * queries used to return unrelated dev-tooling repos, so a weak score had to
 * be called out as low-confidence rather than presented as a firm match.
 */
const LOW_CONFIDENCE_SCORE = 0.75;

/** Quotes resolved in this process. Bounded — a long-lived gateway must not grow without limit. */
const MAX_REMEMBERED_QUOTES = 200;

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
 * Whether a result is genuinely callable right now. Standard §27:
 * `operational` means the Oracle actually called the agent's skills and they
 * answered; `online` is only a heartbeat. Results from before the probe
 * existed carry no `operational`, so `online` is the fallback.
 */
function isLive(agent) {
	return (agent.operational ?? agent.online) === true;
}

/**
 * High confidence needs a live agent AND a real match. Since 2026-08 the
 * Oracle says outright whether the agent's domain matches the request's
 * intent (`domain_match`) — its scores now run past 1, so a fixed score
 * floor no longer means anything. The floor stays only for older results.
 */
function confidenceOf(agent) {
	if (!isLive(agent)) return "low";
	if (typeof agent.domain_match === "boolean") return agent.domain_match ? "high" : "low";
	return (agent.oracle_score ?? 0) >= LOW_CONFIDENCE_SCORE ? "high" : "low";
}

/**
 * Keep the Oracle's order — it already folds reputation, semantics and mesh
 * state into one ranking — but never let an agent that cannot answer beat
 * one that can. (Before 0.5.6 this tool re-ranked with three extra
 * reputation calls per request; the Oracle now returns that signal itself.)
 */
function rankCandidates(agents) {
	return agents
		.map((agent, index) => ({ agent, index }))
		.sort((a, b) => Number(isLive(b.agent)) - Number(isLive(a.agent)) || a.index - b.index)
		.map(({ agent }) => agent);
}

/**
 * @param {() => {handle?: string, ready: Promise<void>}} getState
 * @param {{log?: (msg: string) => void}} [opts]
 */
export function createOracleTools(getState, { log = () => {} } = {}) {
	// quote_id → the winning agent's `invoke[]`, so confirm_service calls the
	// exact skill URL the Oracle verified instead of searching the agent up
	// again. Keyed by the quote itself: the LLM can only reach a URL this
	// process was given by the Oracle, never one it wrote into a quote.
	const quotes = new Map();

	function remember(quoteId, invoke) {
		quotes.delete(quoteId);
		quotes.set(quoteId, invoke);
		if (quotes.size > MAX_REMEMBERED_QUOTES) quotes.delete(quotes.keys().next().value);
	}

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
				log(describeToolCall(tool.name, params));
				return execute(params, ...args);
			}
		};
	}

	return [
		{
			name: "request_service",
			label: "Ask for anything a third party could do for you",
			description:
				"Find a live provider on the MeshKore network for a real-world service — a flight, a " +
				"restaurant, a hotel, a place. Use it when the user asks for this THROUGH MeshKore, or agreed " +
				"to your offer to check MeshKore; for a generic request, offer first instead of calling it. " +
				"Pass the request in plain language, exactly as the user said it — this finds and evaluates " +
				"the best match across 69,000+ providers. This is a DIFFERENT, much larger catalog than " +
				"discover_clusters/Boards (which only cover the MeshKore Cluster/Wall/Board network) — use " +
				"this one for real-world services, not for anything about clusters/Boards/Wall. Present the " +
				"result as a plain outcome, and say it came from a provider found on the MeshKore network — " +
				"but never show a 'provider id', 'score', or 'reputation'; those are internal. Your request " +
				"text goes to MeshKore's Oracle to find the match. If nothing good was found, say so plainly rather than " +
				"guessing. If a result is low-confidence, say that too, don't present it as a firm match. " +
				"If `free` is true, tell the user it costs nothing. `actions` lists what the provider can do " +
				"next (e.g. search, then book). When the user agrees to proceed, call confirm_service with " +
				"the returned quote_id.",
			parameters: Type.Object({
				request: Type.String({ description: "The user's request, verbatim." }),
				budget_max: Type.Optional(Type.Number({ description: "Max price in USD, if the user gave one." })),
				free_only: Type.Optional(
					Type.Boolean({ description: "Only providers that cost nothing — set when the user asks for free options." })
				)
			}),
			execute: async ({ request, budget_max, free_only }) => {
				await ctx();
				const result = await searchAgents(request, { limit: 5, maxPriceUsd: budget_max, freeOnly: free_only });
				const candidates = result.agents ?? [];
				if (!candidates.length) {
					// The Oracle explains empty results ("try broader terms…") — pass
					// that on so the model can retry sensibly instead of giving up.
					return { found: false, reason: "no matching provider found", ...(result.hint ? { hint: result.hint } : {}) };
				}
				const winner = rankCandidates(candidates)[0];
				// Real data found empty `description` fields in production (e.g. a genuinely
				// good hotel match, 2026-07-23) — fall back to capabilities so the LLM still
				// has something presentable, without resorting to internal fields like agent_id.
				const description =
					winner.description?.trim() ||
					(winner.capabilities?.length ? winner.capabilities.join(", ") : "a matching provider");
				const quoteId = encodeQuoteId(winner.agent_id, request);
				const invoke = Array.isArray(winner.invoke) ? winner.invoke.filter((e) => typeof e?.url === "string") : [];
				if (invoke.length) remember(quoteId, invoke);
				return {
					found: true,
					description,
					pricing: winner.pricing ?? winner.agent_card?.pricing ?? null,
					free: winner.free === true || winner.pricing?.amount === 0,
					confidence: confidenceOf(winner),
					...(invoke.length > 1 ? { actions: invoke.map((e) => e.skill) } : {}),
					quote_id: quoteId
				};
			}
		},
		{
			name: "confirm_service",
			label: "Actually go through with a request_service result",
			description:
				"Complete a request from request_service — ONLY call this after the user has explicitly " +
				"agreed to what request_service found (the description/price shown). This is the step that " +
				"actually reaches out to the third-party provider with the user's request and details, so " +
				"OpenClaw asks the user to approve every call. It may come back needing payment (always surfaced to " +
				"the user for approval, this never pays on its own) or needing more specific details (e.g. a " +
				"hotel needs exact check-in/check-out dates, not just 'a hotel in Barcelona') — if the result " +
				"has `needs_info`, ask the user for exactly those fields and call this again with `details` " +
				"filled in, using the same quote_id. If request_service returned `actions`, pass `action` to " +
				"pick one (e.g. 'book' after the user chose a result from 'search-restaurants') — an action " +
				"that acts in the real world, like booking, needs the user's explicit yes to THAT action.",
			parameters: Type.Object({
				quote_id: Type.String(),
				action: Type.Optional(Type.String({ description: "One of the `actions` request_service returned. Defaults to the first." })),
				details: Type.Optional(
					Type.Any({ description: "Structured fields the provider asked for (e.g. {city, checkin, checkout}), from a prior needs_info response." })
				)
			}),
			execute: async ({ quote_id, action, details }) => {
				const { handle } = await ctx();
				const { agentId, request } = decodeQuoteId(quote_id);
				const body = { query: request, ...(details ?? {}) };
				// Straight to the verified skill URL when this process resolved the
				// quote; after a restart the quote is unknown, so look the agent up again.
				const known = quotes.get(quote_id);
				// A misspelt action must not quietly run a different one — "boook"
				// falling back to search would look like a booking that never happened.
				if (known && action && !known.some((e) => e.skill === action)) {
					return { ok: false, error: `unknown action "${action}"`, actions: known.map((e) => e.skill), quote_id };
				}
				const target = known ? pickInvoke({ invoke: known }, action) : null;
				const result = target
					? await contactAgent({ endpoint: target.url, body })
					: await contactAgent({ agentId, skill: action, body });
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
