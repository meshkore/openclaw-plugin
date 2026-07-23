/**
 * memory.js — OCP3: local, durable "interests" store. Never synced to
 * MeshKore's own DB (privacy invariant, openclaw-plugin.md §Privacy) — this
 * file lives entirely in the OpenClaw user's own data dir.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * @typedef {{
 *   id: string,
 *   natural: string,
 *   matchers?: Record<string, unknown>,
 *   watching: Array<{cluster_id: string, board: string}>,
 *   created: string,
 *   last_match?: string | null,
 *   muted_until?: string | null,
 *   status?: "active" | "muted_after_user_feedback"
 * }} Interest
 */

export class InterestsMemory {
	/** @param {string} filePath — e.g. `${OPENCLAW_HOME}/plugins/meshkore/memory.json` */
	constructor(filePath) {
		this.filePath = filePath;
		/** @type {Interest[]} */
		this.interests = [];
	}

	async load() {
		try {
			const raw = await readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw);
			this.interests = Array.isArray(parsed.interests) ? parsed.interests : [];
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
			this.interests = [];
		}
		return this;
	}

	async save() {
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, JSON.stringify({ interests: this.interests }, null, 2), { encoding: "utf8", mode: 0o600 });
	}

	/** @param {Partial<Interest> & {natural: string}} input */
	async addInterest(input) {
		const id = input.id || slugify(input.natural);
		const interest = {
			id,
			natural: input.natural,
			matchers: input.matchers || {},
			watching: input.watching || [],
			created: new Date().toISOString(),
			last_match: null,
			muted_until: null,
			status: "active",
			...input
		};
		const idx = this.interests.findIndex((i) => i.id === id);
		if (idx >= 0) this.interests[idx] = { ...this.interests[idx], ...interest };
		else this.interests.push(interest);
		await this.save();
		return interest;
	}

	async watchBoard(interestId, clusterId, board) {
		const interest = this.interests.find((i) => i.id === interestId);
		if (!interest) throw new Error(`no interest with id ${interestId}`);
		if (!interest.watching.some((w) => w.cluster_id === clusterId && w.board === board)) {
			interest.watching.push({ cluster_id: clusterId, board });
		}
		await this.save();
		return interest;
	}

	async unwatchBoard(interestId, clusterId, board) {
		const interest = this.interests.find((i) => i.id === interestId);
		if (!interest) return false;
		interest.watching = interest.watching.filter((w) => !(w.cluster_id === clusterId && w.board === board));
		await this.save();
		return true;
	}

	/** "para de mostrarme X" → persistent mute, not a temporary skip. */
	async muteFromFeedback(interestId, rule) {
		const interest = this.interests.find((i) => i.id === interestId);
		if (!interest) throw new Error(`no interest with id ${interestId}`);
		interest.status = "muted_after_user_feedback";
		interest.rule = rule;
		await this.save();
		return interest;
	}

	activeWatches() {
		return this.interests
			.filter((i) => i.status !== "muted_after_user_feedback")
			.flatMap((i) => i.watching.map((w) => ({ ...w, interest_id: i.id })));
	}

	touchLastMatch(interestId) {
		const interest = this.interests.find((i) => i.id === interestId);
		if (interest) interest.last_match = new Date().toISOString();
		return this.save();
	}
}

function slugify(text) {
	return (
		text
			.toLowerCase()
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "")
			.slice(0, 48) || `interest-${Date.now()}`
	);
}
