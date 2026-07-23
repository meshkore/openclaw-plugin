/**
 * heartbeat.js — OCP2: the plugin's own pulse, independent of user chat.
 * Shape matches OpenClawPluginService ({id, start(ctx), stop(ctx)}, verified
 * against the Browser plugin's own registerService usage in
 * node_modules/openclaw/dist/plugin-registration-*.js).
 *
 * Phase 1 = no LLM judgment here (that's OCP10/Phase 2) — each tick just
 * calls `onTick`, which OCP5 (novelty.js) wires to a rule-based diff.
 */

export function createHeartbeatService({
	config,
	onTick,
	log = () => {}
}) {
	let timer = null;
	let lastNoveltyAt = Date.now();

	const activeMs = (config.heartbeat_active_minutes ?? 10) * 60_000;
	const idleMs = (config.heartbeat_idle_minutes ?? 60) * 60_000;
	const idleAfterMs = (config.heartbeat_idle_after_hours ?? 4) * 3_600_000;

	function currentInterval() {
		return Date.now() - lastNoveltyAt > idleAfterMs ? idleMs : activeMs;
	}

	async function tick() {
		if (config.paused) {
			log("heartbeat: paused, skipping tick");
			scheduleNext();
			return;
		}
		try {
			const hadNovelty = await onTick();
			if (hadNovelty) lastNoveltyAt = Date.now();
		} catch (err) {
			log(`heartbeat: tick failed — ${err.message}`);
		}
		scheduleNext();
	}

	function scheduleNext() {
		clearTimeout(timer);
		timer = setTimeout(tick, currentInterval());
		timer.unref?.();
	}

	return {
		id: "meshkore-heartbeat",
		async start() {
			log("heartbeat: starting");
			scheduleNext();
		},
		async stop() {
			log("heartbeat: stopping");
			clearTimeout(timer);
			timer = null;
		},
		/** Manual pause/resume — mirrors the `paused` config flag for a live toggle. */
		pause() {
			config.paused = true;
		},
		resume() {
			config.paused = false;
			scheduleNext();
		},
		isIdle() {
			return Date.now() - lastNoveltyAt > idleAfterMs;
		}
	};
}
