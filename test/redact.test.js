import { test } from "node:test";
import assert from "node:assert/strict";
import { describeToolCall } from "../src/redact.js";

test("redact — message text, tokens, details and location never reach the log line", () => {
	const line = describeToolCall("dm", { cluster_id: "c_1", handle: "ana", text: "my address is Calle Mayor 3" });
	assert.equal(line, '[meshkore-tool] dm cluster_id="c_1" handle=<3 chars> text=<27 chars>');
	for (const [name, params, secret] of [
		["join_cluster", { cluster_id: "c_9", token: "ck_supersecret" }, "ck_supersecret"],
		["post_to_board", { cluster_id: "c_1", board_id: "buysell", title: "Bike", body: "call 600123123" }, "600123123"],
		["confirm_service", { quote_id: "eyJhZ2VudElk", action: "book", details: { name: "Ana", phone: "600" } }, "Ana"],
		["request_service", { request: "hotel near my home in Triana" }, "Triana"]
	]) {
		const logged = describeToolCall(name, params);
		assert.ok(!logged.includes(secret), `${name} leaked ${secret}: ${logged}`);
		assert.ok(logged.startsWith(`[meshkore-tool] ${name}`), "E2E runner still finds the tool name");
	}
});

test("redact — structural ids stay readable for debugging", () => {
	assert.match(describeToolCall("confirm_service", { quote_id: "x", action: "book" }), /action="book"/);
	assert.equal(describeToolCall("list_boards", {}), "[meshkore-tool] list_boards");
});
