/**
 * novelty.js — OCP5: deliver Wall + Board novelty to the OpenClaw chat.
 *
 * Two delivery paths, matched to how the protocol actually works (see
 * openclaw-plugin.md's capability table):
 *   - Wall messages/DMs are PUSHED the instant they arrive (event listeners on
 *     the live socket) — no need to wait for the next tick.
 *   - Board posts are POLLED once per heartbeat tick (plain REST, no socket
 *     needed) and diffed against last-seen post ids.
 *
 * Phase 1 = rule-based only (dedup + straight pass-through). LLM judgment
 * (match-strict vs digest-worthy vs noise) is OCP10, Phase 2.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SeenPostsStore {
	constructor(filePath) {
		this.filePath = filePath;
		/** @type {Record<string, string[]>} board key -> seen post ids */
		this.seen = {};
	}

	async load() {
		try {
			this.seen = JSON.parse(await readFile(this.filePath, "utf8"));
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
			this.seen = {};
		}
		return this;
	}

	async save() {
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, JSON.stringify(this.seen, null, 2), { encoding: "utf8", mode: 0o600 });
	}

	key(clusterId, boardId) {
		return `${clusterId}::${boardId}`;
	}

	isNew(clusterId, boardId, postId) {
		const k = this.key(clusterId, boardId);
		return !(this.seen[k] || []).includes(postId);
	}

	async markSeen(clusterId, boardId, postId) {
		const k = this.key(clusterId, boardId);
		const list = this.seen[k] || [];
		if (!list.includes(postId)) list.push(postId);
		this.seen[k] = list.slice(-500); // bounded — mirrors the mesh's own ring-buffer philosophy
		await this.save();
	}
}

/**
 * OwnPostsStore — a bounded, disk-backed set of the post ids THIS agent has
 * published. It exists so inbound Wall delivery can tell "someone replied to
 * one of MY listings" apart from generic chatter (a reply carries the relay-
 * resolved `ref` = the post id it threads under; clusters.md §4/§8). That
 * distinction is the safe half of the autonomous-listen initiative — it lets
 * the plugin HIGHLIGHT the messages that actually merit the user's attention
 * (DMs to us, replies to our posts) without ever auto-replying.
 */
export class OwnPostsStore {
	constructor(filePath) {
		this.filePath = filePath;
		/** @type {string[]} recent own post ids (bounded) */
		this.ids = [];
	}

	async load() {
		try {
			this.ids = JSON.parse(await readFile(this.filePath, "utf8"));
			if (!Array.isArray(this.ids)) this.ids = [];
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
			this.ids = [];
		}
		return this;
	}

	async save() {
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, JSON.stringify(this.ids, null, 2), { encoding: "utf8", mode: 0o600 });
	}

	has(id) {
		return id != null && this.ids.includes(id);
	}

	async add(id) {
		if (id == null || this.ids.includes(id)) return;
		this.ids.push(id);
		this.ids = this.ids.slice(-500); // bounded, same ring-buffer philosophy as SeenPostsStore
		await this.save();
	}
}

/**
 * Attach live-push delivery to a just-joined cluster's Wall. Call this right
 * after runtime.joinCluster(). Idempotent per session (listeners attach once).
 *
 * `isOwnPost(id)` (optional) lets delivery recognize a reply threaded under one
 * of THIS agent's own posts (frame.ref) and mark it as high-signal — the exact
 * "someone answered my car listing" case. Still passive: this only labels what
 * reaches the user; it never sends a reply.
 */
export function wireWallDelivery(session, { deliver, selfHandle, isOwnPost }) {
	session.addEventListener("message", (e) => {
		const frame = e.detail;
		if (frame.from === selfHandle) return; // never echo our own sends
		const isDm = Boolean(frame.to);
		const text = typeof frame.payload === "string" ? frame.payload : frame.payload?.text || "[media]";
		// A #board-slug/#post-id hashtag in the sender's text is resolved by the
		// relay into structured `board`/`ref` fields on the frame (clusters.md
		// §4) — surface that scope instead of flattening it away, so the
		// receiving agent knows this message is about a specific Board/post.
		const repliesToOurPost = Boolean(frame.ref && isOwnPost?.(frame.ref));
		const scope = frame.ref ? ` (on #${frame.ref})` : frame.board ? ` (on #${frame.board})` : "";
		// DMs to us and replies to our own posts are the messages that actually
		// merit a response — flag them so the user's agent surfaces them first
		// and treats a broadcast "hi everyone" as low-priority context, not
		// something to spend a turn answering.
		const worthReplying = isDm || repliesToOurPost;
		const attn = worthReplying ? " ⟨worth replying⟩" : "";
		let line;
		if (repliesToOurPost) {
			line = `[MeshKore] ${frame.from} replied to YOUR post #${frame.ref}: ${text}${attn}`;
		} else if (isDm) {
			line = `[MeshKore] DM from ${frame.from}${scope}: ${text}${attn}`;
		} else {
			line = `[MeshKore] ${frame.from} (broadcast${scope}): ${text}`;
		}
		deliver(line);
	});
}

/** Leading "[City, ...]" (or "[City]") tag on a post title. Null if the title isn't tagged. */
export function parseLocationTag(title) {
	const m = /^\s*\[([^,\]]+)/.exec(title || "");
	return m ? m[1].trim() : null;
}

/**
 * Board-charter protocol (2026-07-24): "location match comes FIRST, then
 * dates, then taste" — an agent in Seville must never surface a New York
 * bike ride. Permissive by design: no homeLocation configured, or the post
 * isn't location-tagged at all (older posts, or an agent not yet following
 * the convention), both pass through un-filtered — this only blocks a CLEAR
 * mismatch between two tagged cities, never a maybe.
 */
export function locationMatches(postTitle, homeLocation) {
	if (!homeLocation) return true;
	const postCity = parseLocationTag(postTitle);
	if (!postCity) return true;
	const homeCity = homeLocation.split(",")[0].trim().toLowerCase();
	return postCity.toLowerCase() === homeCity;
}

/** Same heuristic as MeshRuntime.ADULT_CHARTER_RE — kept independent since novelty.js has no OpenClaw/runtime dependency. */
export const ADULT_CHARTER_RE = /\b18\s*\+|\badults?\b|\bnsfw\b/i;

/**
 * One heartbeat tick's worth of Board polling — call as the heartbeat's
 * `onTick`. Returns true if anything new was found (feeds the idle-cadence
 * detector in heartbeat.js). `homeLocation`/`adultOptIn` gate delivery per the
 * board-charter protocol — filtered posts are still marked seen (so a
 * mismatch doesn't get re-evaluated forever), they just never reach the user.
 */
export function createBoardNoveltyTick({ runtime, memory, seenStore, deliver, homeLocation, adultOptIn }) {
	return async function tick() {
		const watches = memory.activeWatches();
		let hadNovelty = false;
		for (const { cluster_id, board, interest_id } of watches) {
			let boardData;
			try {
				boardData = await runtime.readBoard(cluster_id, board);
			} catch (err) {
				continue; // board or cluster gone — skip silently, don't crash the tick
			}
			const boardMeta = boardData.board || boardData;
			const boardIsAdultGated = !adultOptIn && ADULT_CHARTER_RE.test(boardMeta?.about || "");
			const posts = boardData.posts || boardData.board?.posts || [];
			for (const post of posts) {
				if (!seenStore.isNew(cluster_id, board, post.id)) continue;
				await seenStore.markSeen(cluster_id, board, post.id);
				if (boardIsAdultGated) continue; // never surface adult-charter content without opt-in
				if (!locationMatches(post.title, homeLocation)) continue; // wrong city — never propose it
				hadNovelty = true;
				await memory.touchLastMatch(interest_id);
				deliver(
					`[MeshKore] New post in #${board} (cluster ${cluster_id}) matching your interest "${interest_id}": ` +
						`"${post.title}" — ${post.body}`
				);
			}
		}
		return hadNovelty;
	};
}
