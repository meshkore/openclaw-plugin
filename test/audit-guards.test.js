/**
 * audit-guards — every ClawHub security finding we fixed, as a test that
 * fails if it comes back. The history and the full pre-release checklist
 * live in the monorepo: .meshkore/docs/security/openclaw-plugin-audit-checklist.md
 * A red guard means a past finding returned: fix the cause, never loosen
 * the guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createMeshTools } from "../src/tools.js";
import { createOracleTools } from "../src/oracle-tools.js";
import { GATED_TOOLS } from "../src/approvals.js";

const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf8");
const state = () => ({ ready: Promise.resolve() });
const allTools = [...createMeshTools(state), ...createOracleTools(state)];
const skillDirs = readdirSync(join(root, "skills"));
const skills = Object.fromEntries(skillDirs.map((d) => [d, read(`skills/${d}/SKILL.md`)]));
const frontmatterDescription = (md) => /^description:\s*(.+)$/m.exec(md)?.[1] ?? "";

test("guard 0.5.6 — manifest has no `icon` field; the icon ships as assets/icon.png", () => {
	const manifest = JSON.parse(read("openclaw.plugin.json"));
	assert.equal(manifest.icon, undefined);
	assert.ok(existsSync(join(root, "assets/icon.png")));
});

test("guard ≤0.5.4 — the published package is runtime only", () => {
	const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
	const files = JSON.parse(out)[0].files.map((f) => f.path);
	for (const f of files) {
		assert.ok(!/^(test|scenarios|reports)\//.test(f), `non-runtime file shipped: ${f}`);
	}
});

test("guard 0.5.7 — no tool hands a credential to the model", () => {
	const names = allTools.map((t) => t.name);
	assert.ok(!names.some((n) => /reveal|admin_token|secret/.test(n)), names.join(","));
});

test("guard 0.5.7/0.5.8 — every write or third-party tool is approval-gated", () => {
	const mustGate = ["post_to_board", "dm", "broadcast", "delete_post", "create_board", "create_cluster", "delete_cluster", "confirm_service"];
	for (const name of mustGate) {
		assert.ok(allTools.some((t) => t.name === name), `${name} no longer exists — update this guard`);
		assert.ok(GATED_TOOLS.has(name), `${name} runs without human approval`);
	}
});

test("guard 0.5.8 — skill triggers are explicit-intent only, no steering phrases", () => {
	const banned = [
		/err toward/i,
		/default to checking the meshkore network first/i,
		/first, not last/i,
		/prefer `?request_service`? over/i,
		/IS the approval/i,
		/persistent rule/i
	];
	for (const [name, md] of Object.entries(skills)) {
		for (const re of banned) assert.doesNotMatch(md, re, `${name}: ${re}`);
		const desc = frontmatterDescription(md);
		assert.match(desc, /MeshKore/, `${name}: trigger must be anchored on MeshKore`);
		assert.match(desc, /offer/i, `${name}: generic asks get an offer, not a route`);
	}
});

test("guard 0.5.8 — commerce guidance lives only in the services skill", () => {
	for (const [name, md] of Object.entries(skills)) {
		if (name === "meshkore-services") continue;
		assert.doesNotMatch(md, /missing_fields|paymentRequired|action: "book"/, `${name} carries services guidance`);
	}
});

test("guard 0.5.9 — no log line serializes raw tool params or message text", () => {
	for (const file of readdirSync(join(root, "src")).filter((f) => f.endsWith(".js"))) {
		const src = read(`src/${file}`);
		assert.doesNotMatch(src, /log\([^)]*JSON\.stringify\(params\)/, `${file} logs raw params`);
	}
	assert.doesNotMatch(read("index.js"), /log\(text\)/, "index.js logs inbound message text");
});

test("guard 0.5.7 — README discloses every outbound host the code contacts", () => {
	const readme = read("README.md");
	const hosts = new Set();
	for (const file of readdirSync(join(root, "src")).filter((f) => f.endsWith(".js"))) {
		// Strip comments: hosts mentioned only in comments are not contacted.
		const code = read(`src/${file}`).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
		for (const m of code.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/g)) hosts.add(m[1]);
	}
	hosts.delete("meshkore.com"); // User-Agent contact string for Nominatim, not a destination
	for (const host of hosts) {
		const label = host === "nominatim.openstreetmap.org" ? /Nominatim/ : new RegExp(host.replace(/\./g, "\\."));
		assert.match(readme, label, `README does not disclose ${host}`);
	}
});
