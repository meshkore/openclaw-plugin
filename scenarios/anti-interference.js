/**
 * anti-interference.js — OPQ-5: installs a DECOY unrelated plugin (a fake
 * car-rental service, test/fixtures/decoy-car-rental-plugin/) alongside
 * meshkore, then runs a handful of deliberately ambiguous "car"/"moto"
 * prompts to check whether OpenClaw's LLM picks the right tool family —
 * meshkore's mesh-network tools when the intent is genuinely about the
 * shared network, the decoy's rental/dealer tools when it's a plain
 * rental/purchase-service ask. ALWAYS uninstalls the decoy afterward, even
 * on failure, so it never lingers in a real dev environment.
 *
 * Usage: node scenarios/anti-interference.js
 * Requires the OpenClaw runtime at ~/Documents/Prj/asimovia/openclaw/.
 */

import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const DECOY_PATH = join(PLUGIN_ROOT, "test/fixtures/decoy-car-rental-plugin");
const OPENCLAW_ROOT = process.env.OPENCLAW_ROOT || join(process.env.HOME, "Documents/Prj/asimovia/openclaw");
const RUN_SCRIPT = join(OPENCLAW_ROOT, "scripts/run-openclaw.sh");

const SCENARIOS = [
	{
		id: "rental-clear",
		prompt: "Alquílame un coche para el fin de semana en Madrid, del viernes al domingo.",
		expectMesh: false,
		expectDecoy: true,
		note: "clearly a rental-service ask — should NOT touch the mesh network"
	},
	{
		id: "mesh-clear-watch",
		prompt: "Vigila en la red MeshKore si alguien vende un Honda Civic 2017 o más nuevo.",
		expectMesh: true,
		expectDecoy: false,
		note: "explicit network context — should call watch_interest, not the rental tools"
	},
	{
		id: "mesh-clear-discover",
		prompt: "Busca en los clusters de la mesh si hay alguien vendiendo una moto de enduro.",
		expectMesh: true,
		expectDecoy: false,
		note: "explicit cluster/mesh context — should call discover_clusters/read_board"
	},
	{
		id: "ambiguous-bare",
		prompt: "Búscame un coche.",
		expectMesh: null,
		expectDecoy: null,
		note: "genuinely ambiguous with no context — exploratory, not scored pass/fail; just report what fires"
	}
];

// NOTE (found 2026-07-23, real bug fixed): do NOT match the bare word
// "meshkore" — the plugin logs `[meshkore] ready — handle=...` on EVERY
// single run regardless of whether any mesh tool was actually used, which
// caused a false "mesh=true" on a purely web_search-based rental answer.
// Strip those boilerplate log lines before matching, and require a REAL
// tool-name/id signal, not the plugin's own name.
const MESH_FINGERPRINT = /\b(c_[0-9a-f]{20}|b_[0-9a-f]{16}|int_\S+|join_cluster|watch_interest|discover_clusters|post_to_board|MeshKore Commons)\b/i;
const DECOY_FINGERPRINT = /\b(search_car_rentals|buy_new_car|rental agency|dealership|decoy fixture)\b/i;

function stripPluginBoilerplate(output) {
	return output
		.split("\n")
		.filter((line) => !/^\[meshkore\]/.test(line))
		.join("\n");
}

function installDecoy() {
	execFileSync(RUN_SCRIPT, ["plugins", "install", "--link", DECOY_PATH], { stdio: "pipe" });
}
function uninstallDecoy() {
	try {
		execFileSync(RUN_SCRIPT, ["plugins", "uninstall", "decoy-car-rental", "--force"], { stdio: "pipe" });
	} catch (err) {
		console.error(`WARNING: failed to uninstall decoy plugin — remove it manually: ${err.message}`);
	}
}

function runOnce(prompt, sessionKey) {
	return new Promise((resolve) => {
		// detached + group-kill: see the note in scenarios/run.js — a plain
		// child.kill() leaves orphaned subagent processes running for hours.
		const child = spawn(RUN_SCRIPT, ["agent", "--agent", "main", "--session-key", sessionKey, "--message", prompt, "--local", "--timeout", "180"], {
			env: process.env,
			detached: true
		});
		let out = "";
		const killTimer = setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, 210_000);
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("close", () => {
			clearTimeout(killTimer);
			resolve(out);
		});
		child.on("error", (err) => {
			clearTimeout(killTimer);
			resolve(`SPAWN_ERROR: ${err.message}`);
		});
	});
}

async function main() {
	console.log("Installing decoy car-rental plugin for the duration of this test run...");
	installDecoy();
	try {
		for (let i = 0; i < SCENARIOS.length; i++) {
			const s = SCENARIOS[i];
			process.stdout.write(`[${i + 1}/${SCENARIOS.length}] ${s.id} ... `);
			const output = await runOnce(s.prompt, `opq5-${s.id}`);
			const cleaned = stripPluginBoilerplate(output);
			const gotMesh = MESH_FINGERPRINT.test(cleaned);
			const gotDecoy = DECOY_FINGERPRINT.test(cleaned);
			let verdict;
			if (s.expectMesh === null) {
				verdict = `EXPLORATORY (mesh=${gotMesh}, decoy=${gotDecoy})`;
			} else {
				const correct = gotMesh === s.expectMesh && gotDecoy === s.expectDecoy;
				verdict = correct ? "PASS" : `FAIL (mesh=${gotMesh}, decoy=${gotDecoy}, expected mesh=${s.expectMesh}/decoy=${s.expectDecoy})`;
			}
			console.log(verdict);
			console.log(`    note: ${s.note}`);
		}
	} finally {
		console.log("\nUninstalling decoy plugin...");
		uninstallDecoy();
	}
}

main();
