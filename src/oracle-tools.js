/**
 * oracle-tools.js — OCP11: tool-catalog manifest for the Oracle client
 * (oracle-client.js). Separate module from tools.js on purpose: the Oracle's
 * global agent/service directory (~69,000+ agents — flights, hotels,
 * translators, anything) is a completely different, much larger catalog
 * than the MeshKore Cluster/Wall/Board network tools.js covers — keeping
 * them in separate files keeps the LLM-facing "when to use which" doctrine
 * (SKILL.md) mapped 1:1 onto the code that backs it.
 *
 * Ported after the standalone `meshkore` ClawHub skill was retired
 * 2026-07-23 (openclaw-marketplace.md's consolidation decision) — this is
 * what makes "we consolidated onto one product" literally true rather than
 * a rename.
 */

import { Type } from "typebox";
import { searchAgents, getReputation, contactAgent, sendFeedback } from "./oracle-client.js";

/**
 * Relevance floor below which a result is flagged, not hidden — found live
 * 2026-07-23 (OMSK-3): `search "vuelo a Roma"` returned unrelated RAG/paper
 * agents matched purely on the string "Roma", `oracle_score` ~0.70. Rather
 * than guess a hard cutoff, every result carries its own score back to the
 * LLM with an explicit low-confidence flag so the agent (not this code)
 * decides how to present it — the LLM has the user's actual question in
 * context, this tool doesn't.
 */
const LOW_CONFIDENCE_SCORE = 0.75;

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
			name: "search_agents",
			label: "Find any agent or service on the open mesh",
			description:
				"Natural-language ranked search across the Oracle's full directory (69,000+ agents — flights, " +
				"hotels, restaurants, events, marketplaces, translators, code review, any 'find me X' or 'agent " +
				"that can do X' intent). This is a DIFFERENT, much larger catalog than discover_clusters (which " +
				"only lists MeshKore Cluster/Wall/Board network clusters) — use this one for general " +
				"discovery, not for anything about clusters/Boards/Wall specifically. Pass the user's query " +
				"verbatim; the Oracle does its own NL parsing.",
			parameters: Type.Object({
				query: Type.String({ description: "The user's request, verbatim — don't pre-process or 'improve' it." }),
				limit: Type.Optional(Type.Integer({ description: "Max results, default 5." })),
				max_price_usd: Type.Optional(Type.Number()),
				online_only: Type.Optional(Type.Boolean())
			}),
			execute: async ({ query, limit = 5, max_price_usd, online_only }) => {
				await ctx();
				const result = await searchAgents(query, { limit, maxPriceUsd: max_price_usd, onlineOnly: online_only });
				const agents = (result.agents ?? []).map((a) => ({
					...a,
					low_confidence: (a.oracle_score ?? 0) < LOW_CONFIDENCE_SCORE
				}));
				return { ...result, agents };
			}
		},
		{
			name: "contact_agent",
			label: "Contact an agent found via search_agents",
			description:
				"Send a request directly to an agent's own endpoint (found via search_agents, or a direct " +
				"endpoint URL). If the agent requires payment it returns a 402 challenge — this tool NEVER " +
				"pays automatically, it always returns the challenge for you to show the user and get " +
				"explicit approval before any payment happens. Use this for 'contact/book/reach out to' an " +
				"agent already found, not for messaging within the MeshKore network (use dm/broadcast for that).",
			parameters: Type.Object({
				agent_id: Type.Optional(Type.String({ description: "From a prior search_agents result." })),
				endpoint: Type.Optional(Type.String({ description: "Direct HTTPS endpoint, if not going through the Oracle." })),
				path: Type.Optional(Type.String({ description: "Path to POST under. Default /v1/search." })),
				body: Type.Optional(Type.Any({ description: "JSON body for the request." }))
			}),
			execute: async ({ agent_id, endpoint, path, body }) => {
				const { handle } = await ctx();
				const result = await contactAgent({ agentId: agent_id, endpoint, path, body: body ?? {} });
				if (result.ok && agent_id && handle) {
					// Fire-and-forget credit — mirrors the retired skill's own
					// "skill-internal, don't expose to user UX" design.
					sendFeedback({ requester: handle, agentId: agent_id }).catch(() => {});
				}
				return result;
			}
		},
		{
			name: "check_agent_reputation",
			label: "Check an agent's reputation on the mesh",
			description:
				"Look up an agent's message-through reputation score (0..1) before contacting it, or to " +
				"answer 'is <agent> trustworthy/reliable'.",
			parameters: Type.Object({ agent_id: Type.String() }),
			execute: async ({ agent_id }) => {
				await ctx();
				return getReputation(agent_id);
			}
		}
	].map(withLogging);
}
