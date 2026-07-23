import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../src/identity.js";

function tmpFile() {
	return join(tmpdir(), `meshkore-identity-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test("generates a handle automatically when none is given", async () => {
	const identity = await loadOrCreateIdentity(tmpFile());
	assert.match(identity.handle, /^openclaw-[0-9a-f]{8}$/);
});

test("persists the SAME handle across repeated loads (no fresh identity per restart)", async () => {
	const file = tmpFile();
	const first = await loadOrCreateIdentity(file);
	const second = await loadOrCreateIdentity(file);
	const third = await loadOrCreateIdentity(file, { preferredHandle: "should-be-ignored" });
	assert.equal(first.handle, second.handle);
	assert.equal(first.handle, third.handle, "a later preferredHandle must NOT override an already-persisted identity");
});

test("uses preferredHandle only on first creation", async () => {
	const file = tmpFile();
	const identity = await loadOrCreateIdentity(file, { preferredHandle: "ada-assistant" });
	assert.equal(identity.handle, "ada-assistant");
});
