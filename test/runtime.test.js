import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshRuntime } from "../src/runtime.js";
import { ClusterCredentials } from "../src/credentials.js";

function tmpFile() {
	return join(tmpdir(), `meshkore-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

async function makeRuntime() {
	const credentials = await new ClusterCredentials(tmpFile()).load();
	return new MeshRuntime({ handle: "openclaw-test", credentials });
}

function fakeSession() {
	return {
		online: new Set(["alice", "bob"]),
		broadcastCalls: [],
		dmCalls: [],
		closed: false,
		broadcast(text) {
			this.broadcastCalls.push(text);
		},
		dm(to, text) {
			this.dmCalls.push([to, text]);
		},
		close() {
			this.closed = true;
		}
	};
}

test("listOnlineAgents/broadcast/dm operate on an already-joined session", async () => {
	const runtime = await makeRuntime();
	const session = fakeSession();
	runtime.sessions.set("c_1", session);

	assert.deepEqual(runtime.listOnlineAgents("c_1").sort(), ["alice", "bob"]);
	runtime.broadcast("c_1", "hello everyone");
	runtime.dm("c_1", "bob", "psst");
	assert.deepEqual(session.broadcastCalls, ["hello everyone"]);
	assert.deepEqual(session.dmCalls, [["bob", "psst"]]);
});

test("listOnlineAgents/broadcast/dm throw a clear error when not joined", async () => {
	const runtime = await makeRuntime();
	assert.throws(() => runtime.listOnlineAgents("c_missing"), /not joined/);
	assert.throws(() => runtime.broadcast("c_missing", "hi"), /not joined/);
	assert.throws(() => runtime.dm("c_missing", "bob", "hi"), /not joined/);
});

test("leaveCluster closes the session and removes it, returns false if absent", async () => {
	const runtime = await makeRuntime();
	const session = fakeSession();
	runtime.sessions.set("c_1", session);
	assert.equal(runtime.leaveCluster("c_1"), true);
	assert.equal(session.closed, true);
	assert.equal(runtime.sessions.has("c_1"), false);
	assert.equal(runtime.leaveCluster("c_1"), false);
});

test("joinCluster is idempotent — returns the existing session without reconnecting", async () => {
	const runtime = await makeRuntime();
	const session = fakeSession();
	runtime.sessions.set("c_1", session);
	const result = await runtime.joinCluster("c_1");
	assert.equal(result, session);
});

// --- REST-backed methods, over a mocked global fetch ---

function withMockFetch(handler, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = handler;
	return fn().finally(() => {
		globalThis.fetch = original;
	});
}

test("listBoards/readBoard/discoverClusters delegate to mesh-client over fetch", async () => {
	const runtime = await makeRuntime();
	await withMockFetch(
		async (url) => {
			if (url.includes("/boards/b_1")) return { ok: true, status: 200, text: async () => JSON.stringify({ id: "b_1", posts: [] }) };
			if (url.includes("/boards")) return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
			if (url.includes("/v1/clusters") && !url.includes("/c_"))
				return { ok: true, status: 200, text: async () => JSON.stringify({ clusters: [] }) };
			return { ok: true, status: 200, text: async () => JSON.stringify({}) };
		},
		async () => {
			const boards = await runtime.listBoards("c_1");
			assert.deepEqual(boards.boards, [{ id: "b_1", slug: "buysell" }]);
			const board = await runtime.readBoard("c_1", "b_1");
			assert.equal(board.id, "b_1");
			const discovered = await runtime.discoverClusters();
			assert.deepEqual(discovered.clusters, []);
		}
	);
});

test("_resolveBoardId — passes through an opaque id, resolves a slug via listBoards", async () => {
	const runtime = await makeRuntime();
	assert.equal(await runtime._resolveBoardId("c_1", "b_direct"), "b_direct");

	await withMockFetch(
		async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) }),
		async () => {
			assert.equal(await runtime._resolveBoardId("c_1", "buysell"), "b_1");
		}
	);
});

test("_resolveBoardId — throws a clear error when no board matches", async () => {
	const runtime = await makeRuntime();
	await withMockFetch(
		async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ boards: [] }) }),
		async () => {
			await assert.rejects(() => runtime._resolveBoardId("c_1", "nope"), /no board "nope"/);
		}
	);
});

test("deletePost resolves the board slug then deletes as this agent's own handle", async () => {
	const runtime = await makeRuntime();
	let deleteUrl;
	await withMockFetch(
		async (url, opts) => {
			if (opts?.method === "DELETE") {
				deleteUrl = url;
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
		},
		async () => {
			const result = await runtime.deletePost("c_1", "buysell", "p_1");
			assert.equal(result.ok, true);
		}
	);
	assert.match(deleteUrl, /agent=openclaw-test/);
	assert.match(deleteUrl, /\/posts\/p_1/);
});

test("postToBoard resolves the board slug then posts as this agent's handle", async () => {
	const runtime = await makeRuntime();
	let postedUrl;
	let postedBody;
	await withMockFetch(
		async (url, opts) => {
			if (opts?.method === "POST") {
				postedUrl = url;
				postedBody = JSON.parse(opts.body);
				return { ok: true, status: 201, text: async () => JSON.stringify({ id: "p_1" }) };
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
		},
		async () => {
			await runtime.postToBoard("c_1", "buysell", { title: "Bike", body: "150€" });
			assert.match(postedUrl, /agent=openclaw-test/);
			assert.equal(postedBody.title, "Bike");
		}
	);
});

test("postToBoard — OPQ-6: skips posting a duplicate of this agent's own recent live post", async () => {
	const runtime = await makeRuntime();
	let postCalls = 0;
	await withMockFetch(
		async (url, opts) => {
			if (opts?.method === "POST") {
				postCalls++;
				return { ok: true, status: 201, text: async () => JSON.stringify({ id: "p_new" }) };
			}
			if (url.includes("/boards/b_1")) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({
							posts: [
								{
									id: "p_existing",
									author: "openclaw-test",
									title: "Bike",
									body: "150€",
									created_at: Date.now() / 1000 - 30
								}
							]
						})
				};
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
		},
		async () => {
			const result = await runtime.postToBoard("c_1", "buysell", { title: "Bike", body: "150€" });
			assert.equal(result.id, "p_existing");
			assert.equal(result.deduped, true);
		}
	);
	assert.equal(postCalls, 0, "must not actually POST when a recent duplicate already exists");
});

test("postToBoard — a different title/body from the same agent is NOT deduped", async () => {
	const runtime = await makeRuntime();
	let postCalls = 0;
	await withMockFetch(
		async (url, opts) => {
			if (opts?.method === "POST") {
				postCalls++;
				return { ok: true, status: 201, text: async () => JSON.stringify({ id: "p_new" }) };
			}
			if (url.includes("/boards/b_1")) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({
							posts: [{ id: "p_old", author: "openclaw-test", title: "Old bike", body: "100€", created_at: Date.now() / 1000 }]
						})
				};
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
		},
		async () => {
			await runtime.postToBoard("c_1", "buysell", { title: "New bike", body: "150€" });
		}
	);
	assert.equal(postCalls, 1);
});

test("postToBoard — a stale duplicate (older than the dedupe window) is NOT deduped", async () => {
	const runtime = await makeRuntime();
	let postCalls = 0;
	const staleTime = Date.now() / 1000 - MeshRuntime.DEDUPE_WINDOW_MS / 1000 - 60; // 1 min past the window
	await withMockFetch(
		async (url, opts) => {
			if (opts?.method === "POST") {
				postCalls++;
				return { ok: true, status: 201, text: async () => JSON.stringify({ id: "p_new" }) };
			}
			if (url.includes("/boards/b_1")) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({ posts: [{ id: "p_stale", author: "openclaw-test", title: "Bike", body: "150€", created_at: staleTime }] })
				};
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
		},
		async () => {
			await runtime.postToBoard("c_1", "buysell", { title: "Bike", body: "150€" });
		}
	);
	assert.equal(postCalls, 1, "a duplicate outside the dedupe window should post normally");
});

test("createCluster persists returned credentials for later admin actions", async () => {
	const runtime = await makeRuntime();
	await withMockFetch(
		async () => ({
			ok: true,
			status: 201,
			text: async () => JSON.stringify({ cluster_id: "c_new", token: "ck_x", admin_token: "ak_x", visibility: "public" })
		}),
		async () => {
			const created = await runtime.createCluster({ name: "Trip planning", visibility: "public" });
			assert.equal(created.cluster_id, "c_new");
		}
	);
	assert.equal(runtime.credentials.adminToken("c_new"), "ak_x");
	assert.equal(runtime.credentials.joinToken("c_new"), "ck_x");
});

test("createBoard refuses when this runtime holds no admin_token for the cluster", async () => {
	const runtime = await makeRuntime();
	await assert.rejects(
		() => runtime.createBoard("c_not_mine", { slug: "buysell", name: "Buy/Sell", kind: "buysell" }),
		/this agent did not create it/
	);
});

test("getClusterInvite/revealAdminToken throw when the credential isn't held", async () => {
	const runtime = await makeRuntime();
	assert.throws(() => runtime.getClusterInvite("c_x"), /no join token/);
	assert.throws(() => runtime.revealAdminToken("c_x"), /no admin_token/);
});

test("deleteOwnCluster refuses without an admin_token, forgets credentials + leaves on success", async () => {
	const runtime = await makeRuntime();
	await assert.rejects(() => runtime.deleteOwnCluster("c_not_mine"), /cannot delete a cluster this agent didn't create/);

	await runtime.credentials.remember("c_mine", { adminToken: "ak_x" });
	const session = fakeSession();
	runtime.sessions.set("c_mine", session);
	await withMockFetch(
		async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }),
		async () => {
			await runtime.deleteOwnCluster("c_mine");
		}
	);
	assert.equal(runtime.credentials.adminToken("c_mine"), undefined);
	assert.equal(session.closed, true);
	assert.equal(runtime.sessions.has("c_mine"), false);
});

test("shutdown closes every open session", async () => {
	const runtime = await makeRuntime();
	const s1 = fakeSession();
	const s2 = fakeSession();
	runtime.sessions.set("c_1", s1);
	runtime.sessions.set("c_2", s2);
	runtime.shutdown();
	assert.equal(s1.closed, true);
	assert.equal(s2.closed, true);
	assert.equal(runtime.sessions.size, 0);
});
