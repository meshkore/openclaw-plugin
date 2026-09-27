import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalFor, GATED_TOOLS } from "../src/approvals.js";

test("approvals — acting as the user on the network needs approval by default", () => {
	for (const [tool, params] of [
		["post_to_board", { cluster_id: "c_1", board_id: "buysell", title: "Bike", body: "150€" }],
		["dm", { cluster_id: "c_1", handle: "ana", text: "hi" }],
		["broadcast", { cluster_id: "c_1", text: "hello all" }],
		["delete_post", { cluster_id: "c_1", board_id: "buysell", post_id: "p_1" }],
		["create_board", { cluster_id: "c_1", slug: "hiking" }],
		["create_cluster", { name: "trip" }]
	]) {
		const a = approvalFor(tool, params);
		assert.ok(a, `${tool} must ask`);
		assert.deepEqual(a.allowedDecisions, ["allow-once", "deny"], `${tool}: no allow-always we would not honour`);
		assert.equal(a.timeoutBehavior, "deny");
	}
});

test("approvals — auto_publish lifts the publishing gate, never the irreversible or real-world one", () => {
	assert.equal(approvalFor("post_to_board", { title: "x" }, { autoPublish: true }), undefined);
	assert.equal(approvalFor("dm", { text: "x" }, { autoPublish: true }), undefined);
	const del = approvalFor("delete_cluster", { cluster_id: "c_1" }, { autoPublish: true });
	assert.equal(del.severity, "critical");
	assert.ok(approvalFor("confirm_service", { action: "book" }, { autoPublish: true }));
});

test("approvals — reading and searching never prompt", () => {
	for (const tool of ["read_board", "list_boards", "list_online_agents", "request_service", "discover_clusters"]) {
		assert.equal(approvalFor(tool, {}), undefined, tool);
	}
});

test("approvals — prompt text respects the Gateway caps and shows what will be sent", () => {
	const a = approvalFor("dm", { cluster_id: "c_1", handle: "ana", text: "x".repeat(1000) });
	assert.ok(a.title.length <= 80);
	assert.ok(a.description.length <= 256);
	assert.match(a.description, /To ana/);
});

test("approvals — the hook only ever gates this plugin's own tools", () => {
	assert.ok(!GATED_TOOLS.has("web_fetch"));
	assert.ok(!GATED_TOOLS.has("exec"));
	assert.ok(GATED_TOOLS.has("delete_cluster"));
});

test("approvals — every confirm_service asks, even without an action (a default skill may transact)", () => {
	for (const params of [{}, { action: "search-restaurants" }, { action: "book", details: { party_size: 2 } }]) {
		const a = approvalFor("confirm_service", params, { autoPublish: true });
		assert.ok(a, JSON.stringify(params));
		assert.deepEqual(a.allowedDecisions, ["allow-once", "deny"]);
	}
	assert.match(approvalFor("confirm_service", { action: "book" }).title, /book/);
});

test("approvals — a post's prompt shows the city and language it will be stamped with", () => {
	const a = approvalFor("post_to_board", { board_id: "buysell", cluster_id: "c_1", title: "Bike", body: "150€" }, { homeLocation: "Seville, Spain", lang: "es" });
	assert.match(a.description, /Visible city: Seville, Spain · lang es/);
	const b = approvalFor("post_to_board", { board_id: "buysell", cluster_id: "c_1", title: "Bike", body: "150€" });
	assert.doesNotMatch(b.description, /Visible city/);
});
