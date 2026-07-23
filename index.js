/**
 * index.js — MeshKore OpenClaw plugin entry point.
 *
 * Wires together: the tool catalog (tools.js/OCP1), the interests memory
 * (memory.js/OCP3), the heartbeat service (heartbeat.js/OCP2), Board polling
 * + Wall push delivery (novelty.js/OCP5), and the CLI (commands.js/OCP4).
 *
 * Registration shape verified against node_modules/openclaw's own Browser
 * plugin (dist/extensions/browser/{index,plugin-registration}.js):
 * `definePluginEntry({id,name,description,configSchema,register(api){...}})`
 * with `api.registerTool/registerCli/registerService`.
 *
 * IMPORTANT (found running against the real gateway, 2026-07-22):
 * `register(api)` MUST be synchronous — `openclaw plugins install --link`
 * failed with "Error: plugin register must be synchronous" when this was an
 * `async register(api) {...}`. Fix: `register` returns immediately; disk-backed
 * init (memory/credentials/identity) runs as a background `ready` promise that
 * every tool/service/CLI callback awaits before touching shared state — those
 * callbacks are allowed to be async (verified: the Browser plugin's own tool
 * `execute` is `async`), only the top-level `register` function itself cannot be.
 */

import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { InterestsMemory } from "./src/memory.js";
import { ClusterCredentials } from "./src/credentials.js";
import { loadOrCreateIdentity } from "./src/identity.js";
import { createHeartbeatService } from "./src/heartbeat.js";
import { createBoardNoveltyTick, SeenPostsStore, wireWallDelivery } from "./src/novelty.js";
import { MeshRuntime } from "./src/runtime.js";
import { createMeshTools } from "./src/tools.js";
import { registerMeshCli } from "./src/commands.js";
import { COMMONS_CLUSTER_ID } from "./src/mesh-client.js";

const meshkore_plugin_default = definePluginEntry({
	id: "meshkore",
	name: "MeshKore",
	description: "Personal agent with a heartbeat on the MeshKore Cluster/Wall/Board network",
	register(api) {
		const config = api.pluginConfig ?? {};
		const log = (msg) => api.log?.(`[meshkore] ${msg}`) ?? console.log(`[meshkore] ${msg}`);
		// api.rootDir is undefined under ClawHub's mocked-SDK runtime capture
		// (offline CI validation, no real gateway) — found running
		// `clawhub package validate --runtime --allow-execute` 2026-07-22.
		// Falls back to cwd there; a real gateway always provides a real rootDir.
		const stateDir = join(api.rootDir ?? process.cwd(), "plugins", "meshkore");

		/** @type {{runtime?: MeshRuntime, memory?: InterestsMemory, seenStore?: SeenPostsStore, deliver?: (t:string)=>void, handle?: string, boardTick?: () => Promise<boolean>, pendingNovelty: string[]}} */
		const state = { pendingNovelty: [] };

		const ready = (async () => {
			state.memory = await new InterestsMemory(join(stateDir, "memory.json")).load();
			state.seenStore = await new SeenPostsStore(join(stateDir, "seen.json")).load();
			const credentials = await new ClusterCredentials(join(stateDir, "cluster-credentials.json")).load();

			// Automatic, STABLE identity — generated once and persisted, so this
			// OpenClaw install always presents the same handle on the mesh (a
			// fresh random handle every restart would break DM/roster continuity).
			// Explicit `config.handle` always wins, on every run.
			const identity = await loadOrCreateIdentity(join(stateDir, "identity.json"), {
				preferredHandle: config.handle || api.agentDisplayName
			});
			state.handle = config.handle || identity.handle;
			state.runtime = new MeshRuntime({ handle: state.handle, visibility: config.visibility ?? "public", credentials, log });

			// Deliver hook. Was: push a plugin-composed, pre-formatted string
			// straight to the user via api.services.notify() — bypasses the
			// model entirely, so it can never match whatever language the user
			// actually talks to their own agent in (found live 2026-07-23:
			// this had hardcoded Spanish text, which every user got regardless
			// of their own language — see OPQ-8). Fixed: queue the FACTUAL
			// event and hand it to OpenClaw's own `heartbeat_prompt_contribution`
			// hook (docs/plugins/hooks.md — "Intended for background monitors
			// that need to summarize current state") so the AGENT'S OWN LLM
			// composes the user-facing notification on its next heartbeat turn,
			// in whatever language that conversation is already in. This is the
			// documented, precedented seam for exactly this — not something
			// specific to meshkore; any plugin with a background monitor faces
			// the same problem and should use the same hook.
			state.deliver = (text) => {
				log(text); // still keep a server-side debug trail
				state.pendingNovelty.push(text);
			};

			state.boardTick = createBoardNoveltyTick({
				runtime: state.runtime,
				memory: state.memory,
				seenStore: state.seenStore,
				deliver: state.deliver
			});

			log(`ready — handle=${state.handle}`);
		})();
		ready.catch((err) => log(`init failed: ${err.stack}`));

		for (const tool of createMeshTools(() => ({ ...state, ready }), { log })) {
			api.registerTool({
				name: tool.name,
				label: tool.label,
				description: tool.description,
				parameters: tool.parameters,
				execute: async (toolCallId, params) => JSON.stringify(await tool.execute(params))
			});
		}

		// Hands any accumulated novelty (Board matches, Wall messages) to
		// OpenClaw's own next heartbeat turn as plain factual context — the
		// agent's LLM composes the actual notificationText from this, in
		// whatever language the user's own conversation is in. Returns nothing
		// when there's nothing pending, so a quiet tick stays quiet.
		api.on("heartbeat_prompt_contribution", async () => {
			if (!state.pendingNovelty.length) return;
			const summary = state.pendingNovelty.join("\n");
			state.pendingNovelty = [];
			return { appendContext: `MeshKore network updates since the last check:\n${summary}` };
		});

		api.registerCli(
			async ({ program }) => {
				await ready;
				registerMeshCli(program, { runtime: state.runtime, memory: state.memory });
			},
			{ commands: ["meshkore"] }
		);

		const heartbeat = createHeartbeatService({
			config,
			log,
			onTick: async () => {
				await ready;
				// Join the default cluster lazily on the first tick, not at
				// plugin load — keeps startup fast and respects `enabledByDefault: false`.
				if (state.runtime.sessions.size === 0) {
					const { session } = await state.runtime.joinCluster(config.default_cluster_id || COMMONS_CLUSTER_ID);
					wireWallDelivery(session, { deliver: state.deliver, selfHandle: state.handle });
				}
				return state.boardTick();
			}
		});

		api.registerService(heartbeat);
	}
});

export default meshkore_plugin_default;
