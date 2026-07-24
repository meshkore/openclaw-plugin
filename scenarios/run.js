/**
 * run.js — OPQ-4: E2E scenario runner. Drives real `openclaw agent` turns
 * (against the REAL persistent gateway, not `--local` — see OCP13, 2026-07-24:
 * `--local` is a separate embedded runtime that doesn't reproduce a real
 * gateway's tools.profile/alsoAllow resolution, so it can silently pass
 * scenarios a real gateway-backed agent would fail) against the catalog
 * (OPQ-3) and checks the actual tool-call sequence (read from the plugin's
 * own `[meshkore-tool] <name> args=...` log lines) matches each scenario's
 * expected_tools, as an ORDERED subsequence.
 *
 * Usage:
 *   node scenarios/run.js                    # sample mode: ~25 scenarios, stratified across categories
 *   node scenarios/run.js --full             # full catalog (~198 scenarios) — slow, real $ cost, explicit opt-in
 *   node scenarios/run.js --n=50             # custom sample size
 *   node scenarios/run.js --category=<name>  # only scenarios in one category
 *
 * Requires a RUNNING gateway (`openclaw gateway run`, see
 * ~/Documents/Prj/asimovia/openclaw/scripts/run-openclaw.sh) with this plugin
 * linked, `tools.alsoAllow: ["group:plugins"]` set if your profile is
 * restrictive (see this plugin's README), and AIMLAPI configured as the
 * default model.
 */

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OPENCLAW_ROOT = process.env.OPENCLAW_ROOT || join(process.env.HOME, "Documents/Prj/asimovia/openclaw");
const RUN_SCRIPT = join(OPENCLAW_ROOT, "scripts/run-openclaw.sh");

const IDLE_TIMEOUT_MARKERS = [
	"LLM idle timeout",
	"idle watchdog",
	"did not deliver a first SSE event",
	"RUNNER_KILLED_AFTER_TIMEOUT"
];

function parseArgs(argv) {
	const full = argv.includes("--full");
	const nArg = argv.find((a) => a.startsWith("--n="));
	const n = nArg ? parseInt(nArg.slice(4), 10) : 25;
	const categoryArg = argv.find((a) => a.startsWith("--category="));
	const category = categoryArg ? categoryArg.slice(11) : null;
	return { full, n, category };
}

/** Stratified sample: at least one per category, then fill up to `n` round-robin. */
function sampleStratified(catalog, n) {
	const byCategory = new Map();
	for (const s of catalog) {
		if (!byCategory.has(s.category)) byCategory.set(s.category, []);
		byCategory.get(s.category).push(s);
	}
	const buckets = [...byCategory.values()];
	const picked = [];
	let round = 0;
	while (picked.length < n && picked.length < catalog.length) {
		let addedThisRound = false;
		for (const bucket of buckets) {
			if (picked.length >= n) break;
			if (round < bucket.length) {
				picked.push(bucket[round]);
				addedThisRound = true;
			}
		}
		round++;
		if (!addedThisRound) break;
	}
	return picked;
}

// Bounded per-scenario wall time. `--timeout` asks the CLI itself to give up
// at this many seconds; the JS-side killTimer is a backstop in case a stuck
// subagent chain (observed 2026-07-23: the "coding" tools profile can spawn
// a subagent that loops many LLM rounds before calling a tool) doesn't
// respect that flag reliably in --local mode.
const PER_SCENARIO_TIMEOUT_S = 180;

/**
 * Without `--local`, tool execution happens INSIDE the persistent gateway
 * process, not the spawned CLI client — verified live 2026-07-24: zero
 * `[meshkore-tool]` lines ever appear in the client's own stdout, but they
 * DO appear in the gateway's own daily JSON log
 * (`/tmp/openclaw/openclaw-<date>.log`). Read that file, windowed to
 * [startedAt, finishedAt] so results from a concurrent/earlier scenario
 * don't bleed into this one.
 */
async function extractGatewayLogToolCalls(startedAt, finishedAt) {
	const calls = [];
	const dates = new Set([startedAt.toISOString().slice(0, 10), finishedAt.toISOString().slice(0, 10)]);
	for (const date of dates) {
		const path = `/tmp/openclaw/openclaw-${date}.log`;
		let text;
		try {
			text = await readFile(path, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const t = entry.time ? new Date(entry.time) : null;
			if (!t || t < startedAt || t > finishedAt) continue;
			const msg = entry["0"] || entry.message || "";
			const m = /\[meshkore-tool\]\s+(\S+)\s+args=/.exec(String(msg));
			if (m) calls.push(m[1]);
		}
	}
	return calls;
}

function runOnce(scenario, sessionKey) {
	return new Promise((resolve) => {
		const args = [
			"agent",
			"--agent",
			"main",
			"--session-key",
			sessionKey,
			"--message",
			scenario.prompt,
			// NOT --local (found live 2026-07-24, OCP13): --local is a separate
			// embedded runtime that does NOT resolve tools.profile/alsoAllow the
			// same way the real persistent gateway does — a plugin's tools can be
			// silently invisible to a real gateway-backed agent (behind
			// tools.profile: "coding" without tools.alsoAllow: ["group:plugins"])
			// while --local still calls them fine, making --local a false-positive
			// proxy for exactly the kind of bug this harness exists to catch.
			// Requires a running `openclaw gateway run` — see README.
			"--timeout",
			String(PER_SCENARIO_TIMEOUT_S)
		];
		// `detached: true` puts the child in its OWN process group. Found live
		// 2026-07-23: a plain `child.kill()` only signals the immediate
		// `run-openclaw.sh`/openclaw CLI process — any subagent processes IT
		// spawns internally survive as orphans (confirmed: two `node ...
		// scenarios/run.js` processes kept running for 3+ hours after their
		// parent runs had long since "completed", 0% CPU, never reaped). Kill
		// the whole group with `process.kill(-pid, ...)` instead.
		// Found live 2026-07-24 (OCP13) — the single biggest bug in this whole
		// harness: `run-openclaw.sh` does NOT manage its own Node version; it
		// assumes the calling shell already has a compatible `node` on PATH via
		// nvm. Spawning it directly (as this file always did) inherits whatever
		// `node` this very script is running under, which can be — and on this
		// machine's ambient default IS — an incompatible version (v24.1.0 vs
		// the required >=24.15.0). The openclaw binary then exits(1) instantly
		// with a version-mismatch message, and every scenario silently reads as
        // "wrong tool called" (empty actualTools) instead of "the CLI never
		// even ran." Wrap in bash with nvm sourced + the right version
		// selected, passing the real args through argv (not string-interpolated
		// into the script) so scenario prompts never need shell-escaping.
		const bashScript = `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm use 24.18.0 >/dev/null 2>&1; exec "$0" "$@"`;
		const child = spawn("bash", ["-c", bashScript, RUN_SCRIPT, ...args], { env: process.env, detached: true });
		let out = "";
		let settled = false;
		const killTimer = setTimeout(() => {
			if (settled) return;
			out += "\nRUNNER_KILLED_AFTER_TIMEOUT";
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL"); // fallback if the group kill itself fails
			}
		}, (PER_SCENARIO_TIMEOUT_S + 30) * 1000);
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("close", () => {
			settled = true;
			clearTimeout(killTimer);
			resolve(out);
		});
		child.on("error", (err) => {
			settled = true;
			clearTimeout(killTimer);
			resolve(`SPAWN_ERROR: ${err.message}`);
		});
	});
}

function extractLoggedToolCalls(output) {
	const calls = [];
	const re = /\[meshkore-tool\]\s+(\S+)\s+args=/g;
	let m;
	while ((m = re.exec(output))) calls.push(m[1]);
	return calls;
}

/**
 * Fallback evidence when no `[meshkore-tool]` lines are found at all — found
 * during dogfooding (2026-07-23) that the "coding" tools profile can delegate
 * real tool execution to an internal SUBAGENT whose own log output never
 * reaches the parent `--local` process's stdout, even though the action
 * genuinely happened (verified: a real `post_to_board` call succeeded,
 * returned a real `p_...` id, with zero `[meshkore-tool]` lines in the
 * capturing process's output). Real MeshKore ids (`c_`/`b_`/`p_`/`int_`,
 * fixed hex-suffix shapes the relay generates server-side) are a much
 * stronger signal than free text — an LLM narrating a plausible-sounding
 * fake id is possible but far less likely than it echoing a real one back.
 */
const FINGERPRINTS = {
	join_cluster: /\bc_[0-9a-f]{20}\b/,
	discover_clusters: /\bc_[0-9a-f]{20}\b/,
	list_boards: /\bb_[0-9a-f]{16}\b/,
	read_board: /\bb_[0-9a-f]{16}\b/,
	post_to_board: /\bp_[0-9a-f]{16}\b/,
	create_board: /\bb_[0-9a-f]{16}\b/,
	create_cluster: /\bc_[0-9a-f]{20}\b/,
	watch_interest: /\bint_\S+\b/,
	list_online_agents: /\bopenclaw-[0-9a-f]{6,}\b/
	// broadcast/dm/get_cluster_invite/reveal_admin_token/delete_cluster have no
	// reliable id fingerprint in a text reply — left unmatched on purpose
	// rather than guessing; a scenario expecting only these tools falls back
	// to "no evidence" (fail) when no [meshkore-tool] line exists, which is
	// visible and honest in the report rather than silently assumed passing.
};

function extractFingerprintEvidence(finalText, expectedTools) {
	const found = [];
	for (const tool of expectedTools) {
		const pattern = FINGERPRINTS[tool];
		if (pattern && pattern.test(finalText)) found.push(tool);
	}
	return found;
}

async function extractToolCalls(output, expectedTools, startedAt, finishedAt) {
	const logged = extractLoggedToolCalls(output);
	if (logged.length > 0) return { calls: logged, evidence: "log" };
	// No direct log line in the client's own stdout — expected when NOT
	// running --local (tool execution happens gateway-side, OCP13) or when
	// the "coding" profile delegated to a subagent. Check the gateway's own
	// log file for the same window before falling back to fingerprints.
	const gatewayLogged = await extractGatewayLogToolCalls(startedAt, finishedAt);
	if (gatewayLogged.length > 0) return { calls: gatewayLogged, evidence: "gateway-log" };
	// Still nothing — fall back to id-fingerprint evidence in the final text,
	// in the ORDER expectedTools lists them (can't recover true call order
	// from text alone).
	const finalText = output.split("\n").slice(-40).join("\n");
	const found = extractFingerprintEvidence(finalText, expectedTools);
	return { calls: found, evidence: found.length ? "fingerprint" : "none" };
}

/** Ordered subsequence check: every expected tool must appear, in order, among the actual calls. */
function matchesSubsequence(expected, actual) {
	let i = 0;
	for (const call of actual) {
		if (i < expected.length && call === expected[i]) i++;
	}
	return i === expected.length;
}

async function runScenario(scenario, index) {
	const sessionKey = `qa-run-${scenario.id}-${index}`;
	const startedAt = new Date(Date.now() - 2000); // 2s slack for clock/log-flush skew
	let output = await runOnce(scenario, sessionKey);
	let retried = false;
	if (IDLE_TIMEOUT_MARKERS.some((marker) => output.includes(marker))) {
		retried = true;
		output = await runOnce(scenario, `${sessionKey}-retry`);
	}
	const finishedAt = new Date(Date.now() + 2000);
	const { calls: actualTools, evidence } = await extractToolCalls(output, scenario.expected_tools, startedAt, finishedAt);
	const pass = matchesSubsequence(scenario.expected_tools, actualTools);
	const providerFlake = !pass && IDLE_TIMEOUT_MARKERS.some((marker) => output.includes(marker));
	return { scenario, pass, actualTools, evidence, retried, providerFlake };
}

async function main() {
	const { full, n, category } = parseArgs(process.argv.slice(2));
	const fullCatalog = JSON.parse(await readFile(join(HERE, "catalog.json"), "utf8"));
	const catalog = category ? fullCatalog.filter((s) => s.category === category) : fullCatalog;
	const selected = full || category ? catalog : sampleStratified(catalog, n);

	console.log(
		`Running ${selected.length}/${fullCatalog.length} scenarios (${
			category ? `category=${category}` : full ? "FULL catalog" : `sample, n=${n}`
		})...\n`
	);

	const results = [];
	for (let i = 0; i < selected.length; i++) {
		const scenario = selected[i];
		process.stdout.write(`[${i + 1}/${selected.length}] ${scenario.id} ... `);
		const result = await runScenario(scenario, i);
		results.push(result);
		const tag = result.pass ? `PASS (${result.evidence})` : result.providerFlake ? "FLAKE (provider timeout)" : "FAIL";
		console.log(tag);
	}

	const byCategory = {};
	for (const r of results) {
		const cat = r.scenario.category;
		byCategory[cat] = byCategory[cat] || { pass: 0, fail: 0, flake: 0 };
		if (r.pass) byCategory[cat].pass++;
		else if (r.providerFlake) byCategory[cat].flake++;
		else byCategory[cat].fail++;
	}

	console.log("\n=== Summary by category ===");
	for (const [cat, counts] of Object.entries(byCategory)) {
		console.log(`  ${cat}: ${counts.pass} pass, ${counts.fail} fail, ${counts.flake} provider-flake`);
	}

	const realFailures = results.filter((r) => !r.pass && !r.providerFlake);
	if (realFailures.length) {
		console.log("\n=== Wrong-tool failures (not provider flakes) ===");
		for (const r of realFailures) {
			console.log(`  ${r.scenario.id}: expected ${JSON.stringify(r.scenario.expected_tools)}, got ${JSON.stringify(r.actualTools)}`);
			console.log(`    prompt: "${r.scenario.prompt}"`);
		}
	}

	const totalPass = results.filter((r) => r.pass).length;
	const viaLog = results.filter((r) => r.pass && r.evidence === "log").length;
	const viaFingerprint = results.filter((r) => r.pass && r.evidence === "fingerprint").length;
	console.log(`\n${totalPass}/${results.length} passed (${results.filter((r) => r.providerFlake).length} excluded as provider flakes)`);
	console.log(`  evidence: ${viaLog} confirmed via direct tool log, ${viaFingerprint} via id-fingerprint fallback (subagent-delegated turns)`);
	process.exit(realFailures.length > 0 ? 1 : 0);
}

main();
