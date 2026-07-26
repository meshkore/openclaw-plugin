import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshRuntime } from "../src/runtime.js";
import { ClusterCredentials } from "../src/credentials.js";

function tmpFile() {
	return join(tmpdir(), `meshkore-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

async function makeRuntime(opts = {}) {
	const credentials = await new ClusterCredentials(tmpFile()).load();
	return new MeshRuntime({ handle: "openclaw-test", credentials, ...opts });
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
			if (url.includes("/boards/b_1/posts")) return { ok: true, status: 200, text: async () => JSON.stringify({ posts: [{ id: "p_1" }] }) };
			if (url.includes("/boards")) return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
			if (url.includes("/v1/clusters") && !url.includes("/c_"))
				return { ok: true, status: 200, text: async () => JSON.stringify({ clusters: [] }) };
			return { ok: true, status: 200, text: async () => JSON.stringify({}) };
		},
		async () => {
			const boards = await runtime.listBoards("c_1");
			assert.deepEqual(boards.boards, [{ id: "b_1", slug: "buysell" }]);
			const result = await runtime.readBoard("c_1", "b_1");
			assert.equal(result.board.id, "b_1");
			assert.deepEqual(result.posts, [{ id: "p_1" }]);
			const discovered = await runtime.discoverClusters();
			assert.deepEqual(discovered.clusters, []);
		}
	);
});

// --- PROPS layer (2026-07-26): geocoding, near/lang/adult filters, stamping ---

test("mergeProps — per-key inheritance, lower level wins, unset inherits", () => {
	const cluster = { where: { lat: 1, lon: 1, label: "Cluster City" }, lang: "en" };
	const board = { lang: "es" };
	assert.deepEqual(MeshRuntime.mergeProps(cluster, board), { where: { lat: 1, lon: 1, label: "Cluster City" }, lang: "es" });
	assert.deepEqual(MeshRuntime.mergeProps(cluster, null), cluster);
	assert.deepEqual(MeshRuntime.mergeProps(undefined, undefined), {});
});

test("_findBoard attaches effectiveProps merged from cluster_props + board.props", async () => {
	const runtime = await makeRuntime();
	await withMockFetch(
		async () => ({
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({
					cluster_props: { lang: "en", entry: { age_min: 0 } },
					boards: [{ id: "b_1", slug: "cars", props: { entry: { age_min: 18 } } }]
				})
		}),
		async () => {
			const board = await runtime._findBoard("c_1", "cars");
			assert.deepEqual(board.effectiveProps, { lang: "en", entry: { age_min: 18 } });
		}
	);
});

test("_resolveHomeCoords geocodes once and caches in-memory; null without homeLocation", async () => {
	let calls = 0;
	const geocode = async () => {
		calls++;
		return { lat: 41.4, lon: 2.2, label: "Barcelona, Spain" };
	};
	const runtime = await makeRuntime({ homeLocation: "Barcelona, Spain", geocode });
	assert.deepEqual(await runtime._resolveHomeCoords(), { lat: 41.4, lon: 2.2, label: "Barcelona, Spain" });
	await runtime._resolveHomeCoords();
	assert.equal(calls, 1, "geocode must only be called once, cached after that");

	const noHome = await makeRuntime({ geocode });
	assert.equal(await noHome._resolveHomeCoords(), null);
	assert.equal(calls, 1, "no homeLocation configured means geocode is never even called");
});

test("_resolveHomeCoords — a failed/unresolvable geocode degrades to null, not a crash", async () => {
	const runtime = await makeRuntime({ homeLocation: "Nowhereville", geocode: async () => null });
	assert.equal(await runtime._resolveHomeCoords(), null);
});

test("readBoard forwards near/km/lang/adult derived from runtime config to mesh.readPosts", async () => {
	const runtime = await makeRuntime({
		homeLocation: "Seville, Spain",
		lang: "es",
		adultOptIn: true,
		nearRadiusKm: 25,
		geocode: async () => ({ lat: 37.4, lon: -5.99, label: "Seville, Spain" })
	});
	let capturedUrl;
	await withMockFetch(
		async (url) => {
			if (url.includes("/posts")) {
				capturedUrl = url;
				return { ok: true, status: 200, text: async () => JSON.stringify({ posts: [] }) };
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
		},
		async () => {
			await runtime.readBoard("c_1", "buysell");
		}
	);
	assert.match(capturedUrl, /near=37\.4%2C-5\.99/);
	assert.match(capturedUrl, /km=25/);
	assert.match(capturedUrl, /lang=es/);
	assert.match(capturedUrl, /adult=1/);
});

test("readBoard omits filters entirely when nothing is configured", async () => {
	const runtime = await makeRuntime();
	let capturedUrl;
	await withMockFetch(
		async (url) => {
			if (url.includes("/posts")) {
				capturedUrl = url;
				return { ok: true, status: 200, text: async () => JSON.stringify({ posts: [] }) };
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
		},
		async () => {
			await runtime.readBoard("c_1", "buysell");
		}
	);
	assert.doesNotMatch(capturedUrl, /\?/);
});

test("readBoard refuses an age-gated board (structured entry.age_min) without adult_content_opt_in", async () => {
	const runtime = await makeRuntime();
	await withMockFetch(
		async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "adults-only", props: { entry: { age_min: 18 } } }] })
		}),
		async () => {
			await assert.rejects(() => runtime.readBoard("c_1", "adults-only"), /requires age_min 18/);
		}
	);
});

test("postToBoard stamps props.where/props.lang and sends adult=1 once opted in", async () => {
	const runtime = await makeRuntime({
		homeLocation: "Seville, Spain",
		lang: "es",
		adultOptIn: true,
		geocode: async () => ({ lat: 37.4, lon: -5.99, label: "Seville, Spain" })
	});
	let postedBody;
	let postedUrl;
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
			await runtime.postToBoard("c_1", "buysell", { title: "Selling my bike", body: "150€" });
		}
	);
	assert.deepEqual(postedBody.props, { where: { lat: 37.4, lon: -5.99, label: "Seville, Spain" }, lang: "es" });
	assert.match(postedUrl, /adult=1/);
});

test("postToBoard refuses a post over the board's props.limits.post_max_chars", async () => {
	const runtime = await makeRuntime();
	await withMockFetch(
		async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell", props: { limits: { post_max_chars: 10 } } }] })
		}),
		async () => {
			await assert.rejects(
				() => runtime.postToBoard("c_1", "buysell", { title: "Way too long a title", body: "and body" }),
				/over board "buysell"'s limit of 10/
			);
		}
	);
});

test("postToBoard allows a post within the board's props.limits.post_max_chars", async () => {
	const runtime = await makeRuntime();
	let postCalled = false;
	await withMockFetch(
		async (url, opts) => {
			if (opts?.method === "POST") {
				postCalled = true;
				return { ok: true, status: 201, text: async () => JSON.stringify({ id: "p_1" }) };
			}
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell", props: { limits: { post_max_chars: 1000 } } }] })
			};
		},
		async () => {
			await runtime.postToBoard("c_1", "buysell", { title: "Short", body: "and short" });
		}
	);
	assert.equal(postCalled, true);
});

test("postToBoard — a board with no structured limits is unrestricted client-side", async () => {
	const runtime = await makeRuntime();
	let postCalled = false;
	await withMockFetch(
		async (url, opts) => {
			if (opts?.method === "POST") {
				postCalled = true;
				return { ok: true, status: 201, text: async () => JSON.stringify({ id: "p_1" }) };
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
		},
		async () => {
			await runtime.postToBoard("c_1", "buysell", { title: "x".repeat(5000), body: "y".repeat(5000) });
		}
	);
	assert.equal(postCalled, true);
});

test("postToBoard sends no props/adult when nothing is configured", async () => {
	const runtime = await makeRuntime();
	let postedBody;
	let postedUrl;
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
			await runtime.postToBoard("c_1", "buysell", { title: "Selling my bike", body: "150€" });
		}
	);
	assert.equal("props" in postedBody, false);
	assert.doesNotMatch(postedUrl, /adult=/);
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

// --- board-charter protocol (2026-07-24): location tagging + audience gating ---

test("postToBoard — auto-prefixes [City, Country] when homeLocation is configured and the title isn't already tagged", async () => {
	const runtime = await makeRuntime({ homeLocation: "Seville, Spain" });
	let postedBody;
	await withMockFetch(
		async (url, opts) => {
			if (opts?.method === "POST") {
				postedBody = JSON.parse(opts.body);
				return { ok: true, status: 201, text: async () => JSON.stringify({ id: "p_1" }) };
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
		},
		async () => {
			await runtime.postToBoard("c_1", "buysell", { title: "Selling my bike", body: "150€" });
		}
	);
	assert.equal(postedBody.title, "[Seville, Spain] Selling my bike");
});

test("postToBoard — respects a title that's already tagged, never double-prefixes", async () => {
	const runtime = await makeRuntime({ homeLocation: "Seville, Spain" });
	let postedBody;
	await withMockFetch(
		async (url, opts) => {
			if (opts?.method === "POST") {
				postedBody = JSON.parse(opts.body);
				return { ok: true, status: 201, text: async () => JSON.stringify({ id: "p_1" }) };
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
		},
		async () => {
			await runtime.postToBoard("c_1", "buysell", { title: "[Madrid, Spain] Selling my bike", body: "150€" });
		}
	);
	assert.equal(postedBody.title, "[Madrid, Spain] Selling my bike");
});

test("postToBoard — no homeLocation configured leaves the title untouched", async () => {
	const runtime = await makeRuntime();
	let postedBody;
	await withMockFetch(
		async (url, opts) => {
			if (opts?.method === "POST") {
				postedBody = JSON.parse(opts.body);
				return { ok: true, status: 201, text: async () => JSON.stringify({ id: "p_1" }) };
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "buysell" }] }) };
		},
		async () => {
			await runtime.postToBoard("c_1", "buysell", { title: "Selling my bike", body: "150€" });
		}
	);
	assert.equal(postedBody.title, "Selling my bike");
});

test("postToBoard — refuses a board whose charter reads 18+ without adult_content_opt_in", async () => {
	const runtime = await makeRuntime();
	await withMockFetch(
		async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "adults-only", about: "18+ only, no exceptions." }] })
		}),
		async () => {
			await assert.rejects(
				() => runtime.postToBoard("c_1", "adults-only", { title: "Hi", body: "..." }),
				/adult\/18\+ content/
			);
		}
	);
});

test("postToBoard — allows the same board when adultOptIn is true", async () => {
	const runtime = await makeRuntime({ adultOptIn: true });
	let postCalled = false;
	await withMockFetch(
		async (url, opts) => {
			if (opts?.method === "POST") {
				postCalled = true;
				return { ok: true, status: 201, text: async () => JSON.stringify({ id: "p_1" }) };
			}
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ boards: [{ id: "b_1", slug: "adults-only", about: "18+ only, no exceptions." }] })
			};
		},
		async () => {
			await runtime.postToBoard("c_1", "adults-only", { title: "Hi", body: "..." });
		}
	);
	assert.equal(postCalled, true);
});

test("createBoard passes an about charter through to mesh.createBoard", async () => {
	const runtime = await makeRuntime();
	await runtime.credentials.remember("c_mine", { adminToken: "ak_x" });
	let sentBody;
	await withMockFetch(
		async (url, opts) => {
			sentBody = opts?.body ? JSON.parse(opts.body) : sentBody;
			return { ok: true, status: 201, text: async () => JSON.stringify({ id: "b_new" }) };
		},
		async () => {
			await runtime.createBoard("c_mine", { slug: "buysell", name: "Buy/Sell", kind: "buysell", about: "Tag [City, Country]." });
		}
	);
	assert.equal(sentBody.about, "Tag [City, Country].");
});

test("_safeListBoardsWithCharters — returns the board list, and [] (not a throw) on a fetch error", async () => {
	const runtime = await makeRuntime();
	await withMockFetch(
		async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ boards: [{ id: "b_1", about: "charter text" }] }) }),
		async () => {
			assert.deepEqual(await runtime._safeListBoardsWithCharters("c_1"), [{ id: "b_1", about: "charter text" }]);
		}
	);
	await withMockFetch(
		async () => ({ ok: false, status: 500, text: async () => "" }),
		async () => {
			assert.deepEqual(await runtime._safeListBoardsWithCharters("c_1"), []);
		}
	);
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
