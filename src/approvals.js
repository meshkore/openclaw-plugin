/**
 * approvals.js — which tool calls a human must approve before they run.
 *
 * Wired into OpenClaw's own `before_tool_call` hook (docs/plugins/
 * plugin-permission-requests.md): returning `requireApproval` pauses the call
 * and shows the user an approve/deny prompt on their chat surface. That is
 * what makes `auto_publish: false` true in code rather than a sentence in a
 * tool description — a model that skips the "ask first" instruction still
 * cannot post, message or delete on its own.
 *
 * Two tiers:
 * - Acting as the user on the network (post, DM, broadcast, create, delete a
 *   post): approval unless the user opted into `auto_publish`.
 * - Irreversible or third-party (delete a cluster, any confirm_service —
 *   it sends the user's details to an outside provider, and may book):
 *   approval ALWAYS, and never "allow always".
 *
 * No approval surface connected (e.g. a headless cron run) means OpenClaw
 * blocks the call — the safe default. Pure module, no OpenClaw dependency.
 */

const ONCE = ["allow-once", "deny"];

/** Gateway caps: title 80 chars, description 256. */
function clip(text, max) {
	const s = String(text ?? "").replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function prompt(title, description, severity = "warning") {
	return { title: clip(title, 80), description: clip(description, 256), severity, allowedDecisions: ONCE, timeoutBehavior: "deny" };
}

/** Tools that act as the user on the network; gated unless auto_publish is on. */
const PUBLISHING = {
	// The post is stamped with the user's configured city and language — say so
	// in the prompt, so each post is a consent to showing them (ClawHub audit).
	post_to_board: (p, { homeLocation, lang } = {}) =>
		prompt(
			"Post to a MeshKore Board",
			`${homeLocation ? `Visible city: ${homeLocation}${lang ? ` · lang ${lang}` : ""}. ` : ""}Publish "${clip(p.title, 60)}" on board ${p.board_id} (cluster ${p.cluster_id}): ${p.body ?? ""}`
		),
	dm: (p) => prompt("Send a MeshKore direct message", `To ${p.handle} (cluster ${p.cluster_id}): ${p.text ?? ""}`),
	broadcast: (p) => prompt("Broadcast on a MeshKore Wall", `Everyone on cluster ${p.cluster_id} will see: ${p.text ?? ""}`),
	delete_post: (p) => prompt("Delete a MeshKore post", `Permanently remove your post ${p.post_id} from board ${p.board_id}.`),
	create_board: (p) => prompt("Create a MeshKore Board", `Create board "${p.slug}" on cluster ${p.cluster_id}.`),
	create_cluster: (p) =>
		prompt("Create a MeshKore cluster", `Create ${p.visibility === "private" ? "a private" : "a public"} cluster "${p.name}".`)
};

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} params
 * @param {{autoPublish?: boolean, homeLocation?: string, lang?: string}} opts
 * @returns {object | undefined} a `requireApproval` payload, or undefined to let the call run
 */
export function approvalFor(toolName, params = {}, { autoPublish = false, homeLocation, lang } = {}) {
	if (toolName === "delete_cluster") {
		return prompt(
			"Delete a MeshKore cluster — irreversible",
			`Permanently delete cluster ${params.cluster_id} and disconnect everyone in it. There is no undo.`,
			"critical"
		);
	}
	// Every confirm sends the user's request and details to a third party, and
	// a provider's DEFAULT skill can itself be transactional — so the gate
	// cannot hinge on the `action` param (ClawHub audit, 0.5.8). Always ask.
	if (toolName === "confirm_service") {
		const action = typeof params.action === "string" ? params.action : null;
		const acts = action && !action.startsWith("search");
		return prompt(
			acts ? `Let a provider "${action}" for you` : "Send your request to a provider",
			`${acts ? `Run "${action}"` : "Send your request"} to a third-party provider found on the MeshKore network, with the details you gave${params.details ? `: ${JSON.stringify(params.details)}` : "."}`
		);
	}
	if (!autoPublish && PUBLISHING[toolName]) return PUBLISHING[toolName](params, { homeLocation, lang });
	return undefined;
}

/** Tool names this module can gate — the hook ignores every other plugin's tools. */
export const GATED_TOOLS = new Set(["delete_cluster", "confirm_service", ...Object.keys(PUBLISHING)]);
