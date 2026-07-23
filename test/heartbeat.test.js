import { test } from "node:test";
import assert from "node:assert/strict";
import { createHeartbeatService } from "../src/heartbeat.js";

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("ticks on the active interval and stops on stop()", async () => {
	let ticks = 0;
	const config = { heartbeat_active_minutes: 0.001, heartbeat_idle_minutes: 10, heartbeat_idle_after_hours: 100 };
	const hb = createHeartbeatService({
		config,
		onTick: async () => {
			ticks++;
			return false;
		}
	});
	await hb.start();
	await wait(250);
	await hb.stop();
	assert.ok(ticks >= 2, `expected several ticks in 250ms at a 60ms interval, got ${ticks}`);
});

test("pause() stops ticking, resume() restarts it", async () => {
	let ticks = 0;
	const config = { heartbeat_active_minutes: 0.001, heartbeat_idle_minutes: 10, heartbeat_idle_after_hours: 100 };
	const hb = createHeartbeatService({
		config,
		onTick: async () => {
			ticks++;
			return false;
		}
	});
	await hb.start();
	await wait(120);
	hb.pause();
	const paused = ticks;
	await wait(150);
	assert.equal(ticks, paused, "no ticks should happen while paused");
	hb.resume();
	await wait(150);
	assert.ok(ticks > paused, "ticks should resume after resume()");
	await hb.stop();
});
