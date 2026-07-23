/**
 * commands.js — OCP4: manual cluster/board control, before Phase 2's LLM
 * autonomy exists. Two surfaces, same underlying MeshRuntime calls:
 *
 *   1. In-chat: the tools in tools.js are already invocable by natural
 *      language ("conéctate a la commons", "vigila si sale un Civic 2017…") —
 *      OpenClaw's own NL→tool-call routing covers "/join"-style phrasing
 *      without any extra registration.
 *   2. Terminal CLI (`openclaw meshkore <cmd>`): registered here via
 *      `api.registerCli`, verified against the Browser plugin's own
 *      `registerBrowserCli` usage (commander.js `program`).
 *
 * registerMeshCli(program, {runtime, memory}) is called from index.js inside
 * the `registerCli` callback.
 */

import { COMMONS_CLUSTER_ID } from "./mesh-client.js";

export function registerMeshCli(program, { runtime, memory }) {
	const mesh = program.command("meshkore").description("MeshKore Cluster/Wall/Board network");

	mesh
		.command("join [cluster_id]")
		.description("Join a cluster's Wall (defaults to the public Commons). Pass --token for a private cluster.")
		.option("--vis <vis>", "public|private|ghost", "public")
		.option("--token <token>", "join token for a PRIVATE cluster (given by whoever invited you)")
		.action(async (clusterId, opts) => {
			const { ready } = await runtime.joinCluster(clusterId || COMMONS_CLUSTER_ID, { vis: opts.vis, token: opts.token });
			console.log(`joined ${clusterId || COMMONS_CLUSTER_ID} — ${(ready.online || []).length} agent(s) online`);
		});

	mesh
		.command("create <name>")
		.description("Create a new cluster — public (default) or private (--private, for a closed friend group)")
		.option("--private", "make it token-gated instead of public")
		.option("--topic <topic>", "e.g. #cars — only meaningful for public clusters")
		.action(async (name, opts) => {
			const created = await runtime.createCluster({ name, visibility: opts.private ? "private" : "public", topic: opts.topic });
			console.log(`created ${created.cluster_id} (${created.visibility})`);
			if (created.visibility === "private") {
				console.log(`share this with friends to let them join: openclaw meshkore invite ${created.cluster_id}`);
			}
		});

	mesh
		.command("invite <cluster_id>")
		.description("Show the join token for a private cluster you own/joined, to hand to a friend")
		.action((clusterId) => {
			const { token } = runtime.getClusterInvite(clusterId);
			console.log(`join token (keep it out of public channels): ${token}`);
		});

	mesh
		.command("delete <cluster_id>")
		.description("Permanently delete a cluster this agent created — IRREVERSIBLE")
		.action(async (clusterId) => {
			await runtime.deleteOwnCluster(clusterId);
			console.log(`deleted ${clusterId}`);
		});

	mesh
		.command("watch <cluster_id> <board>")
		.description("Watch a Board for new posts (adds/updates a standing interest)")
		.option("--interest <text>", "natural-language description of what to watch for", "")
		.action(async (clusterId, board, opts) => {
			const interest = await memory.addInterest({ natural: opts.interest || `${board} on ${clusterId}` });
			await memory.watchBoard(interest.id, clusterId, board);
			console.log(`watching #${board} on ${clusterId} (interest: ${interest.id})`);
		});

	mesh
		.command("unwatch <cluster_id> <board> <interest_id>")
		.description("Stop watching a Board for a given interest")
		.action(async (clusterId, board, interestId) => {
			const ok = await memory.unwatchBoard(interestId, clusterId, board);
			console.log(ok ? `stopped watching #${board} on ${clusterId}` : "no matching watch found");
		});

	mesh
		.command("clusters")
		.description("List joined clusters + the public discovery catalog")
		.action(async () => {
			const joined = [...runtime.sessions.keys()];
			const { clusters } = await runtime.discoverClusters();
			console.log("joined:", joined.length ? joined.join(", ") : "(none)");
			console.log(
				"public catalog:",
				clusters?.length ? clusters.map((c) => `${c.id} (${c.name || c.topic || "—"})`).join(", ") : "(empty)"
			);
		});

	return mesh;
}
