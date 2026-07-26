import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeenPostsStore, wireWallDelivery, createBoardNoveltyTick, parseLocationTag, locationMatches } from "../src/novelty.js";

function tmpFile() {
	return join(tmpdir(), `meshkore-novelty-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test("SeenPostsStore — isNew/markSeen round-trip", async () => {
	const store = await new SeenPostsStore(tmpFile()).load();
	assert.equal(store.isNew("c_1", "b_1", "p_1"), true);
	await store.markSeen("c_1", "b_1", "p_1");
	assert.equal(store.isNew("c_1", "b_1", "p_1"), false);
	// different board/cluster key stays new
	assert.equal(store.isNew("c_1", "b_2", "p_1"), true);
});

test("SeenPostsStore — persists across reload", async () => {
	const file = tmpFile();
	const store = await new SeenPostsStore(file).load();
	await store.markSeen("c_1", "b_1", "p_1");
	const reloaded = await new SeenPostsStore(file).load();
	assert.equal(reloaded.isNew("c_1", "b_1", "p_1"), false);
});

test("SeenPostsStore — bounded to the last 500 ids per board key", async () => {
	const store = await new SeenPostsStore(tmpFile()).load();
	for (let i = 0; i < 510; i++) {
		await store.markSeen("c_1", "b_1", `p_${i}`);
	}
	const key = store.key("c_1", "b_1");
	assert.equal(store.seen[key].length, 500);
	// the oldest ids were evicted, the most recent survived
	assert.equal(store.isNew("c_1", "b_1", "p_0"), true);
	assert.equal(store.isNew("c_1", "b_1", "p_509"), false);
});

test("SeenPostsStore — missing file loads as empty, not an error", async () => {
	const store = await new SeenPostsStore(join(tmpdir(), "does-not-exist-meshkore.json")).load();
	assert.deepEqual(store.seen, {});
});

// --- wireWallDelivery ---

function fakeSession() {
	const listeners = {};
	return {
		addEventListener(kind, cb) {
			listeners[kind] = cb;
		},
		emit(kind, detail) {
			listeners[kind]?.({ detail });
		}
	};
}

test("wireWallDelivery — never echoes our own sends", () => {
	const session = fakeSession();
	const delivered = [];
	wireWallDelivery(session, { deliver: (t) => delivered.push(t), selfHandle: "me" });
	session.emit("message", { from: "me", payload: "hello" });
	assert.equal(delivered.length, 0);
});

test("wireWallDelivery — formats a broadcast differently from a DM", () => {
	const session = fakeSession();
	const delivered = [];
	wireWallDelivery(session, { deliver: (t) => delivered.push(t), selfHandle: "me" });
	session.emit("message", { from: "bob", payload: "hi all" });
	session.emit("message", { from: "carol", to: "me", payload: "psst" });
	assert.match(delivered[0], /broadcast/);
	assert.match(delivered[1], /DM/);
	assert.match(delivered[0], /bob/);
	assert.match(delivered[1], /carol/);
});

test("wireWallDelivery — surfaces the relay-resolved board/ref scope from a #hashtag", () => {
	const session = fakeSession();
	const delivered = [];
	wireWallDelivery(session, { deliver: (t) => delivered.push(t), selfHandle: "me" });
	session.emit("message", { from: "bob", payload: "still available? #buysell", board: "buysell" });
	session.emit("message", { from: "carol", to: "me", payload: "yes still here", board: "buysell", ref: "p_14bf7be790c74f48" });
	assert.match(delivered[0], /#buysell/);
	assert.match(delivered[1], /#p_14bf7be790c74f48/);
});

test("wireWallDelivery — a plain message with no board/ref carries no scope suffix", () => {
	const session = fakeSession();
	const delivered = [];
	wireWallDelivery(session, { deliver: (t) => delivered.push(t), selfHandle: "me" });
	session.emit("message", { from: "bob", payload: "hi all" });
	assert.doesNotMatch(delivered[0], /#/);
});

test("wireWallDelivery — non-string payload without .text falls back to [media]", () => {
	const session = fakeSession();
	const delivered = [];
	wireWallDelivery(session, { deliver: (t) => delivered.push(t), selfHandle: "me" });
	session.emit("message", { from: "bob", payload: { url: "https://example.com/x.png" } });
	assert.match(delivered[0], /\[media\]/);
});

// --- createBoardNoveltyTick ---

function fakeMemory(watches) {
	return { activeWatches: () => watches };
}

test("createBoardNoveltyTick — delivers a new post once, matching the watched interest", async () => {
	const seenStore = await new SeenPostsStore(tmpFile()).load();
	const delivered = [];
	const runtime = {
		readBoard: async () => ({ posts: [{ id: "p_1", title: "Civic 2018", body: "9000€" }] })
	};
	const memory = fakeMemory([{ cluster_id: "c_cars", board: "buysell", interest_id: "int_1" }]);
	let touched;
	memory.touchLastMatch = async (id) => {
		touched = id;
	};
	const tick = createBoardNoveltyTick({ runtime, memory, seenStore, deliver: (t) => delivered.push(t) });

	const had = await tick();
	assert.equal(had, true);
	assert.equal(delivered.length, 1);
	assert.match(delivered[0], /Civic 2018/);
	assert.equal(touched, "int_1");

	// second tick: same post, not re-delivered
	const had2 = await tick();
	assert.equal(had2, false);
	assert.equal(delivered.length, 1);
});

test("createBoardNoveltyTick — a board/cluster read error is skipped, not thrown", async () => {
	const seenStore = await new SeenPostsStore(tmpFile()).load();
	const runtime = {
		readBoard: async () => {
			throw new Error("board_not_found");
		}
	};
	const memory = fakeMemory([{ cluster_id: "c_gone", board: "buysell", interest_id: "int_1" }]);
	const tick = createBoardNoveltyTick({ runtime, memory, seenStore, deliver: () => {} });
	await assert.doesNotReject(() => tick());
});

test("createBoardNoveltyTick — no watches means no novelty, no crash", async () => {
	const seenStore = await new SeenPostsStore(tmpFile()).load();
	const runtime = { readBoard: async () => ({ posts: [] }) };
	const memory = fakeMemory([]);
	const tick = createBoardNoveltyTick({ runtime, memory, seenStore, deliver: () => {} });
	assert.equal(await tick(), false);
});

// --- board-charter protocol (2026-07-24): location + audience filtering ---

test("parseLocationTag — extracts the city from a leading [City, ...] tag", () => {
	assert.equal(parseLocationTag("[Seville, Spain] Selling my bike"), "Seville");
	assert.equal(parseLocationTag("[Seville] Selling my bike"), "Seville");
	assert.equal(parseLocationTag("Selling my bike"), null);
});

test("locationMatches — permissive when homeLocation or the tag is absent, strict on a real mismatch", () => {
	assert.equal(locationMatches("[Seville, Spain] Bike", null), true);
	assert.equal(locationMatches("Bike, no tag", "Seville, Spain"), true);
	assert.equal(locationMatches("[Seville, Spain] Bike", "Seville, Spain"), true);
	assert.equal(locationMatches("[seville] Bike", "Seville, Spain"), true); // case-insensitive
	assert.equal(locationMatches("[New York, USA] Bike", "Seville, Spain"), false);
});

test("createBoardNoveltyTick — a location-mismatched post is marked seen but never delivered", async () => {
	const seenStore = await new SeenPostsStore(tmpFile()).load();
	const delivered = [];
	const runtime = {
		readBoard: async () => ({ posts: [{ id: "p_ny", title: "[New York, USA] Civic 2018", body: "9000$" }] })
	};
	const memory = fakeMemory([{ cluster_id: "c_cars", board: "buysell", interest_id: "int_1" }]);
	memory.touchLastMatch = async () => {};
	const tick = createBoardNoveltyTick({ runtime, memory, seenStore, deliver: (t) => delivered.push(t), homeLocation: "Seville, Spain" });

	const had = await tick();
	assert.equal(had, false);
	assert.equal(delivered.length, 0);
	assert.equal(seenStore.isNew("c_cars", "buysell", "p_ny"), false, "still marked seen so it isn't re-evaluated forever");
});

test("createBoardNoveltyTick — a matching-location post still delivers normally", async () => {
	const seenStore = await new SeenPostsStore(tmpFile()).load();
	const delivered = [];
	const runtime = {
		readBoard: async () => ({ posts: [{ id: "p_sev", title: "[Seville, Spain] Civic 2018", body: "9000€" }] })
	};
	const memory = fakeMemory([{ cluster_id: "c_cars", board: "buysell", interest_id: "int_1" }]);
	memory.touchLastMatch = async () => {};
	const tick = createBoardNoveltyTick({ runtime, memory, seenStore, deliver: (t) => delivered.push(t), homeLocation: "Seville, Spain" });

	assert.equal(await tick(), true);
	assert.equal(delivered.length, 1);
});

test("createBoardNoveltyTick — an adult-charter board never delivers without adultOptIn, even a matching post", async () => {
	const seenStore = await new SeenPostsStore(tmpFile()).load();
	const delivered = [];
	const runtime = {
		readBoard: async () => ({
			board: { about: "18+ only, no exceptions." },
			posts: [{ id: "p_1", title: "Meetup", body: "..." }]
		})
	};
	const memory = fakeMemory([{ cluster_id: "c_x", board: "adults-only", interest_id: "int_1" }]);
	memory.touchLastMatch = async () => {};
	const tick = createBoardNoveltyTick({ runtime, memory, seenStore, deliver: (t) => delivered.push(t) });

	assert.equal(await tick(), false);
	assert.equal(delivered.length, 0);
});
