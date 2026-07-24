import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildJoinUrl,
	MeshClusterSession,
	discoverClusters,
	listBoards,
	postToBoard,
	createBoard,
	MESHKORE_API
} from "../src/mesh-client.js";

test("buildJoinUrl — public cluster, no token, defaults client=meshkore-plugin", () => {
	const url = buildJoinUrl("c_1b938b9ede1b436980e2", { agent: "openclaw-abc" });
	assert.equal(
		url,
		"wss://api.meshkore.com/v1/clusters/c_1b938b9ede1b436980e2/ws?agent=openclaw-abc&vis=public&client=meshkore-plugin"
	);
});

test("buildJoinUrl — client marker can be overridden or omitted", () => {
	assert.match(buildJoinUrl("c_1", { agent: "a", client: "some-fork" }), /client=some-fork/);
	assert.doesNotMatch(buildJoinUrl("c_1", { agent: "a", client: null }), /client=/);
});

test("buildJoinUrl — private cluster includes token", () => {
	const url = buildJoinUrl("c_private", { agent: "alice", vis: "private", token: "ck_abc123" });
	assert.match(url, /vis=private/);
	assert.match(url, /token=ck_abc123/);
});

test("buildJoinUrl — encodes cluster id", () => {
	const url = buildJoinUrl("c_has space", { agent: "bob" });
	assert.match(url, /c_has%20space/);
});

test("MeshClusterSession — ready frame seeds online set without connecting", () => {
	const session = new MeshClusterSession("c_x", { agent: "me" });
	session._handleFrame(JSON.stringify({ kind: "ready", online: ["alice", "bob"] }));
	assert.deepEqual([...session.online].sort(), ["alice", "bob"]);
});

test("MeshClusterSession — presence add/remove updates online set", () => {
	const session = new MeshClusterSession("c_x", { agent: "me" });
	session._handleFrame(JSON.stringify({ kind: "ready", online: ["alice"] }));
	session._handleFrame(JSON.stringify({ kind: "presence", agent: "bob", status: "online" }));
	assert.deepEqual([...session.online].sort(), ["alice", "bob"]);
	session._handleFrame(JSON.stringify({ kind: "presence", agent: "alice", status: "offline" }));
	assert.deepEqual([...session.online], ["bob"]);
});

test("MeshClusterSession — message/ack/closed/error frames dispatch matching events", () => {
	const session = new MeshClusterSession("c_x", { agent: "me" });
	const seen = [];
	for (const kind of ["message", "ack", "closed", "error"]) {
		session.addEventListener(kind, (e) => seen.push([kind, e.detail]));
	}
	session._handleFrame(JSON.stringify({ kind: "message", from: "bob", payload: "hi" }));
	session._handleFrame(JSON.stringify({ kind: "ack", id: "1" }));
	assert.equal(seen.length, 2);
	assert.equal(seen[0][0], "message");
	assert.equal(seen[0][1].from, "bob");
});

test("MeshClusterSession — malformed frame is silently ignored, not thrown", () => {
	const session = new MeshClusterSession("c_x", { agent: "me" });
	assert.doesNotThrow(() => session._handleFrame("not json"));
});

test("MeshClusterSession — unknown frame kind is silently ignored", () => {
	const session = new MeshClusterSession("c_x", { agent: "me" });
	let fired = false;
	session.addEventListener("mystery", () => {
		fired = true;
	});
	assert.doesNotThrow(() => session._handleFrame(JSON.stringify({ kind: "mystery" })));
	assert.equal(fired, false);
});

test("MeshClusterSession — close() suppresses auto-reconnect", () => {
	const session = new MeshClusterSession("c_x", { agent: "me", autoReconnect: true });
	session.ws = { close: () => session._handleClose() };
	session.close();
	assert.equal(session._closedByUser, true);
});

// --- REST helpers over a mocked global fetch (no real network) ---

test("discoverClusters — hits the expected path and parses JSON", async () => {
	let calledUrl;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		calledUrl = url;
		return { ok: true, status: 200, text: async () => JSON.stringify({ clusters: [{ id: "c_1" }] }) };
	};
	const result = await discoverClusters();
	assert.equal(calledUrl, `${MESHKORE_API}/v1/clusters`);
	assert.deepEqual(result, { clusters: [{ id: "c_1" }] });
	globalThis.fetch = originalFetch;
});

test("listBoards — encodes the cluster id in the path", async () => {
	let calledUrl;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		calledUrl = url;
		return { ok: true, status: 200, text: async () => JSON.stringify({ boards: [] }) };
	};
	await listBoards("c_has space");
	assert.match(calledUrl, /c_has%20space/);
	globalThis.fetch = originalFetch;
});

test("postToBoard — sends title/body/ttl and defaults ttl to 7d", async () => {
	let sentBody;
	let sentUrl;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, opts) => {
		sentUrl = url;
		sentBody = JSON.parse(opts.body);
		return { ok: true, status: 201, text: async () => JSON.stringify({ id: "p_1" }) };
	};
	await postToBoard("c_1", "b_1", "alice", { title: "Bike", body: "150€" });
	assert.match(sentUrl, /agent=alice/);
	assert.equal(sentBody.title, "Bike");
	assert.equal(sentBody.ttl, "7d");
	globalThis.fetch = originalFetch;
});

test("createBoard — sends the about charter when given, omits it when not", async () => {
	let sentBody;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, opts) => {
		sentBody = JSON.parse(opts.body);
		return { ok: true, status: 201, text: async () => JSON.stringify({ id: "b_1" }) };
	};
	await createBoard("c_1", "ak_x", { slug: "buysell", name: "Buy/Sell", kind: "buysell", about: "Sell stuff, tag [City, Country]." });
	assert.equal(sentBody.about, "Sell stuff, tag [City, Country].");

	await createBoard("c_1", "ak_x", { slug: "events", name: "Events", kind: "events" });
	assert.equal("about" in sentBody, false);
	globalThis.fetch = originalFetch;
});

test("apiFetch — non-ok response throws with status attached", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ error: "not_found" }) });
	await assert.rejects(() => listBoards("c_missing"), (err) => {
		assert.equal(err.status, 404);
		assert.equal(err.body.error, "not_found");
		return true;
	});
	globalThis.fetch = originalFetch;
});
