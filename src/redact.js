/**
 * redact.js — what the plugin may write to the gateway log.
 *
 * Tool arguments carry DM and post text, booking details, a private
 * cluster's join token and the user's city; inbound Wall messages carry
 * strangers' words. None of that belongs in a server log (ClawHub audit of
 * 0.5.9: "under-scoped logging"). Only structural ids are logged verbatim;
 * every other value is reduced to its type and size, which is still enough
 * to debug "was the tool called, and with what shape".
 */

/** Ids and switches that identify WHAT was touched, never what was said. */
const SAFE_KEYS = new Set([
	"cluster_id",
	"board_id",
	"post_id",
	"interest_id",
	"slug",
	"visibility",
	"ttl",
	"action",
	"free_only",
	"limit",
	"min_age"
]);

function shapeOf(value) {
	if (typeof value === "string") return `<${value.length} chars>`;
	if (Array.isArray(value)) return `<array ${value.length}>`;
	if (value && typeof value === "object") return `<object ${Object.keys(value).length} keys>`;
	return `<${typeof value}>`;
}

/** One log line for a tool call, with every non-structural value redacted. */
export function describeToolCall(name, params) {
	const parts = Object.entries(params ?? {}).map(([key, value]) =>
		SAFE_KEYS.has(key) ? `${key}=${JSON.stringify(value)}` : `${key}=${shapeOf(value)}`
	);
	return `[meshkore-tool] ${name}${parts.length ? ` ${parts.join(" ")}` : ""}`;
}
