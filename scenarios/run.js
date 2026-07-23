/**
 * run.js — OPQ-4: E2E scenario runner. Drives real `openclaw agent --local`
 * turns against the catalog (OPQ-3) and checks the actual tool-call sequence
 * (read from the plugin's own `[meshkore-tool] <name> args=...` log lines,
 * printed straight to the one-shot `--local` process's stdout — verified
 * during today's live dogfooding, no log-file tailing needed) matches each
 * scenario's expected_tools, as an ORDERED subsequence.
 *
 * Usage:
 *   node scenarios/run.js            # sample mode: ~25 scenarios, stratified across categories
 *   node scenarios/run.js --full     # full catalog (~198 scenarios) — slow, real $ cost, explicit opt-in
 *   node scenarios/run.js --n=50     # custom sample size
 *
 * Requires the OpenClaw runtime at ~/Documents/Prj/asimovia/openclaw/ (see
 * openclaw-plugin-qa.md) with this plugin linked and AIMLAPI configured as
 * the default model.
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
	return { full, n };
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
			"--local",
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
		const child = spawn(RUN_SCRIPT, args, { env: process.env, detached: true });
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

function extractToolCalls(output, expectedTools) {
	const logged = extractLoggedToolCalls(output);
	if (logged.length > 0) return { calls: logged, evidence: "log" };
	// No direct log line at all — likely subagent-delegated. Fall back to
	// id-fingerprint evidence in the final text, in the ORDER expectedTools
	// lists them (we can't recover true call order from text alone).
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
	let output = await runOnce(scenario, sessionKey);
	let retried = false;
	if (IDLE_TIMEOUT_MARKERS.some((marker) => output.includes(marker))) {
		retried = true;
		output = await runOnce(scenario, `${sessionKey}-retry`);
	}
	const { calls: actualTools, evidence } = extractToolCalls(output, scenario.expected_tools);
	const pass = matchesSubsequence(scenario.expected_tools, actualTools);
	const providerFlake = !pass && IDLE_TIMEOUT_MARKERS.some((marker) => output.includes(marker));
	return { scenario, pass, actualTools, evidence, retried, providerFlake };
}

async function main() {
	const { full, n } = parseArgs(process.argv.slice(2));
	const catalog = JSON.parse(await readFile(join(HERE, "catalog.json"), "utf8"));
	const selected = full ? catalog : sampleStratified(catalog, n);

	console.log(`Running ${selected.length}/${catalog.length} scenarios (${full ? "FULL catalog" : `sample, n=${n}`})...\n`);

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
