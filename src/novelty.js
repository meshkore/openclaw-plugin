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
 * Attach live-push delivery to a just-joined cluster's Wall. Call this right
 * after runtime.joinCluster(). Idempotent per session (listeners attach once).
 */
export function wireWallDelivery(session, { deliver, selfHandle }) {
	session.addEventListener("message", (e) => {
		const frame = e.detail;
		if (frame.from === selfHandle) return; // never echo our own sends
		const isDm = Boolean(frame.to);
		const text = typeof frame.payload === "string" ? frame.payload : frame.payload?.text || "[media]";
		deliver(
			isDm
				? `[MeshKore] DM from ${frame.from}: ${text}`
				: `[MeshKore] ${frame.from} (broadcast): ${text}`
		);
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
