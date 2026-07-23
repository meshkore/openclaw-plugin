/**
 * live.mesh.test.js — integration test against the REAL production MeshKore
 * API. Creates a throwaway public cluster + board, posts, reads, and deletes
 * the cluster in a `finally` (cleanup is unconditional). Skipped by default —
 * opt in with `MESHKORE_LIVE_TEST=1 node --test test/live.mesh.test.js`, since
 * a normal `npm test` run should not depend on network/production state.
 *
 * This is how OCP1/OCP5's "Done when" (join Commons, list/read real Boards,
 * new post triggers delivery within one tick) were actually verified
 * 2026-07-22 — see the resolution notes on those task files.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MeshRuntime } from "../src/runtime.js";
import { InterestsMemory } from "../src/memory.js";
import { ClusterCredentials } from "../src/credentials.js";
import { SeenPostsStore, createBoardNoveltyTick } from "../src/novelty.js";
import { COMMONS_CLUSTER_ID, deleteCluster, getCluster, listBoards, MeshClusterSession } from "../src/mesh-client.js";

const RUN_LIVE = process.env.MESHKORE_LIVE_TEST === "1";
const maybeTest = RUN_LIVE ? test : test.skip;

function tmpPath(label) {
	return join(tmpdir(), `meshkore-live-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

async function makeRuntime(handle) {
	const credentials = await new ClusterCredentials(tmpPath(`creds-${handle}`)).load();
	return new MeshRuntime({ handle, credentials, log: () => {} });
}

maybeTest("Commons resolves and matches the documented id/name/topic", async () => {
	const commons = await getCluster(COMMONS_CLUSTER_ID);
	assert.equal(commons.cluster.id, COMMONS_CLUSTER_ID);
	assert.equal(commons.cluster.topic, "#public");
});

maybeTest("WebSocket join to the Commons yields a ready frame", async () => {
	const session = new MeshClusterSession(COMMONS_CLUSTER_ID, {
		agent: `test-${Date.now().toString(36)}`,
		vis: "ghost",
		autoReconnect: false
	});
	const ready = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no ready frame in 10s")), 10_000);
		session.addEventListener("ready", (e) => {
			clearTimeout(timer);
			resolve(e.detail);
		});
		session.connect();
	});
	assert.equal(ready.kind, "ready");
	session.close();
});

maybeTest("full round trip: create cluster -> enable+create board -> post -> read -> novelty tick delivers", async () => {
	const runtime = await makeRuntime("live-test-agent");
	const memory = await new InterestsMemory(tmpPath("mem")).load();
	const seenStore = await new SeenPostsStore(tmpPath("seen")).load();

	const created = await runtime.createCluster({ name: "openclaw-plugin-live-test", visibility: "public" });
	try {
		await runtime.createBoard(created.cluster_id, { slug: "buysell", name: "Buy/Sell", kind: "buysell" });

		const interest = await memory.addInterest({ natural: "test item" });
		await memory.watchBoard(interest.id, created.cluster_id, "buysell");

		const delivered = [];
		const tick = createBoardNoveltyTick({ runtime, memory, seenStore, deliver: (t) => delivered.push(t) });

		assert.equal(await tick(), false, "empty board should report no novelty");

		await runtime.postToBoard(created.cluster_id, "buysell", { title: "Test item", body: "for CI", ttl: "24h" });

		assert.equal(await tick(), true, "a fresh post should report novelty");
		assert.equal(delivered.length, 1);
		assert.match(delivered[0], /Test item/);

		assert.equal(await tick(), false, "the same post must not fire twice");
	} finally {
		await runtime.deleteOwnCluster(created.cluster_id);
	}
});

maybeTest("credentials persist across a simulated restart (new MeshRuntime, same store)", async () => {
	const credsFile = tmpPath("creds-restart");
	const runtimeA = new MeshRuntime({ handle: "restart-test-agent", credentials: await new ClusterCredentials(credsFile).load(), log: () => {} });
	const created = await runtimeA.createCluster({ name: "openclaw-plugin-restart-test", visibility: "public" });
	try {
		// Simulate a process restart: brand-new MeshRuntime, same credentials file on disk.
		const runtimeB = new MeshRuntime({ handle: "restart-test-agent", credentials: await new ClusterCredentials(credsFile).load(), log: () => {} });
		assert.equal(runtimeB.credentials.adminToken(created.cluster_id), created.admin_token);
		// Prove it's not just a string match — actually delete with the "restarted" runtime's own admin_token.
		await runtimeB.deleteOwnCluster(created.cluster_id);
		const { count } = await (await import("../src/mesh-client.js")).discoverClusters();
		// no strong assertion on count (shared catalog) — the real proof is deleteOwnCluster not throwing
		assert.ok(count >= 0);
	} catch (err) {
		await deleteCluster(created.cluster_id, created.admin_token).catch(() => {});
		throw err;
	}
});

maybeTest("private cluster: agent A creates it, agent B joins with the shared token, they see each other", async () => {
	const runtimeA = await makeRuntime("private-test-alice");
	const runtimeB = await makeRuntime("private-test-bob");

	const created = await runtimeA.createCluster({ name: "openclaw-plugin-private-test", visibility: "private" });
	try {
		const { session: sessionA, ready: readyA } = await runtimeA.joinCluster(created.cluster_id, {});
		assert.equal(readyA.public, false, "a private cluster's ready frame must say public:false");

		const invite = runtimeA.getClusterInvite(created.cluster_id);
		assert.equal(invite.token, created.token, "the invite token must be the one returned at creation");

		// Bob's agent joins using ONLY the shared invite token — no admin_token, exactly
		// what a friend's OpenClaw instance would have after Alice hands them the token.
		const { ready: readyB } = await runtimeB.joinCluster(created.cluster_id, { token: invite.token });
		assert.ok(readyB.online.includes("private-test-alice"), "Bob should see Alice already in the roster");

		// Cross-check presence both ways (give the presence frame a beat to arrive).
		await new Promise((r) => setTimeout(r, 500));
		assert.ok(runtimeA.listOnlineAgents(created.cluster_id).includes("private-test-bob"), "Alice should see Bob join");

		// A stranger with NO token must not be able to read the private cluster's Boards
		// via the tokenless-public REST path either (security check beyond just the socket).
		await assert.rejects(() => listBoards(created.cluster_id), /404|401/, "a private cluster must not be readable without its token");

		sessionA.close();
		runtimeB.shutdown();
	} finally {
		await runtimeA.deleteOwnCluster(created.cluster_id);
	}
});

maybeTest("private cluster: a WebSocket with NO token never opens (security floor)", async () => {
	const runtimeA = await makeRuntime("private-test-alice2");
	const created = await runtimeA.createCluster({ name: "openclaw-plugin-private-security-test", visibility: "private" });
	try {
		const strangerSession = new MeshClusterSession(created.cluster_id, {
			agent: "private-test-stranger",
			vis: "public",
			autoReconnect: false
		});
		const outcome = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve("timeout-no-ready"), 4000);
			strangerSession.addEventListener("ready", () => {
				clearTimeout(timer);
				resolve("ready");
			});
			strangerSession.addEventListener("error", () => {
				clearTimeout(timer);
				resolve("error");
			});
			strangerSession.addEventListener("close", () => {
				clearTimeout(timer);
				resolve("closed");
			});
			strangerSession.connect();
		});
		assert.notEqual(outcome, "ready", "a socket with no token must never receive a ready frame from a private cluster");
		strangerSession.close();
	} finally {
		await runtimeA.deleteOwnCluster(created.cluster_id);
	}
});
