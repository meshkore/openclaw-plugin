/**
 * credentials.js — persisted per-cluster credentials (admin_token for
 * clusters this agent created, join `token` for private clusters it was
 * invited into). Fixes a real gap found during deeper testing (2026-07-22):
 * `MeshRuntime` originally held `admin_token`s only in-memory — an OpenClaw
 * restart would silently orphan every cluster this agent ever created (no
 * way to delete/administer them again, ever).
 *
 * Security invariants (operator's explicit ask, 2026-07-22):
 *   - File written with mode 0o600 (owner read/write only).
 *   - NEVER logged, NEVER put in a prompt/tool response, NEVER synced to
 *     MeshKore's own servers — same invariant as InterestsMemory (memory.js).
 *   - `admin_token` is the only credential that can delete/administer a
 *     cluster (clusters.md §1/§7) — treat it like a private key.
 *   - A private cluster's join `token` is a trust boundary (clusters.md §1:
 *     "anyone with cluster_id + token can join and see all traffic, DMs
 *     included") — store it, never print it in a tool's return value.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class ClusterCredentials {
	/** @param {string} filePath — e.g. `${stateDir}/cluster-credentials.json` */
	constructor(filePath) {
		this.filePath = filePath;
		/** @type {Record<string, {token?: string, adminToken?: string, name?: string, visibility?: string}>} */
		this.entries = {};
	}

	async load() {
		try {
			this.entries = JSON.parse(await readFile(this.filePath, "utf8"));
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
			this.entries = {};
		}
		return this;
	}

	async save() {
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, JSON.stringify(this.entries, null, 2), { encoding: "utf8", mode: 0o600 });
	}

	async remember(clusterId, { token, adminToken, name, visibility } = {}) {
		const existing = this.entries[clusterId] || {};
		this.entries[clusterId] = {
			...existing,
			...(token ? { token } : {}),
			...(adminToken ? { adminToken } : {}),
			...(name ? { name } : {}),
			...(visibility ? { visibility } : {})
		};
		await this.save();
	}

	async forget(clusterId) {
		delete this.entries[clusterId];
		await this.save();
	}

	adminToken(clusterId) {
		return this.entries[clusterId]?.adminToken;
	}

	joinToken(clusterId) {
		return this.entries[clusterId]?.token;
	}

	/** Clusters this agent holds an admin_token for (i.e. created itself). */
	ownedClusters() {
		return Object.entries(this.entries)
			.filter(([, v]) => v.adminToken)
			.map(([clusterId, v]) => ({ clusterId, name: v.name }));
	}
}
