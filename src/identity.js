/**
 * identity.js — automatic, stable agent identity. Answers the operator's
 * question (2026-07-22): "will every OpenClaw instance be able to create an
 * identity automatically and join the mesh?" — yes: on first run, if the
 * user hasn't set an explicit `handle` in the plugin config, generate one and
 * PERSIST it, so the same OpenClaw install always presents the same handle
 * on the mesh (a fresh random handle every restart would break DMs/roster
 * continuity — this was a real gap, fixed here rather than left as a TODO).
 *
 * `did:key` (an optional stronger identity, per clusters.md — "self-asserted,
 * echoed to peers but not yet cryptographically verified on connect") is
 * DEFERRED on purpose: correct did:key encoding needs multicodec + base58btc,
 * and the wire protocol doesn't verify it yet anyway (no security benefit
 * today) — see openclaw-plugin.md's open decisions for why this is a
 * documented "later", not a silently-skipped corner.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function generateHandle() {
	return `openclaw-${randomBytes(4).toString("hex")}`;
}

/**
 * @param {string} filePath — e.g. `${stateDir}/identity.json`
 * @param {{preferredHandle?: string}} opts — `preferredHandle` wins if the
 *   file doesn't exist yet (e.g. the user set `config.handle` for the FIRST
 *   run); ignored on later runs so the persisted handle stays stable even if
 *   `preferredHandle` would compute differently (e.g. OpenClaw's own display
 *   name changed).
 */
export async function loadOrCreateIdentity(filePath, { preferredHandle } = {}) {
	try {
		const data = JSON.parse(await readFile(filePath, "utf8"));
		if (data.handle) return data;
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	const identity = { handle: preferredHandle || generateHandle(), created: new Date().toISOString() };
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(identity, null, 2), { encoding: "utf8", mode: 0o600 });
	return identity;
}
