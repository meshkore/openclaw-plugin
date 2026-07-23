import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { ClusterCredentials } from "../src/credentials.js";

function tmpFile() {
	return join(tmpdir(), `meshkore-creds-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test("remember + adminToken/joinToken round trip, survives reload", async () => {
	const file = tmpFile();
	const creds = await new ClusterCredentials(file).load();
	await creds.remember("c_123", { adminToken: "ak_abc", token: "ck_xyz", name: "trip planning", visibility: "private" });

	assert.equal(creds.adminToken("c_123"), "ak_abc");
	assert.equal(creds.joinToken("c_123"), "ck_xyz");

	const reloaded = await new ClusterCredentials(file).load();
	assert.equal(reloaded.adminToken("c_123"), "ak_abc");
	assert.equal(reloaded.joinToken("c_123"), "ck_xyz");
});

test("file is written with mode 0o600 (owner-only)", async () => {
	const file = tmpFile();
	const creds = await new ClusterCredentials(file).load();
	await creds.remember("c_123", { adminToken: "ak_abc" });
	const { mode } = await stat(file);
	assert.equal(mode & 0o777, 0o600);
});

test("forget() removes a cluster's credentials", async () => {
	const file = tmpFile();
	const creds = await new ClusterCredentials(file).load();
	await creds.remember("c_123", { adminToken: "ak_abc" });
	await creds.forget("c_123");
	assert.equal(creds.adminToken("c_123"), undefined);
});

test("ownedClusters() lists only clusters with an admin_token", async () => {
	const file = tmpFile();
	const creds = await new ClusterCredentials(file).load();
	await creds.remember("c_mine", { adminToken: "ak_1", name: "mine" });
	await creds.remember("c_friends", { token: "ck_2", name: "friends" }); // joined, not owned
	const owned = creds.ownedClusters();
	assert.equal(owned.length, 1);
	assert.equal(owned[0].clusterId, "c_mine");
});
