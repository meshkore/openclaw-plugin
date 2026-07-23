import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterestsMemory } from "../src/memory.js";

function tmpFile() {
	return join(tmpdir(), `meshkore-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test("addInterest + watchBoard + activeWatches", async () => {
	const mem = await new InterestsMemory(tmpFile()).load();
	const interest = await mem.addInterest({ natural: "Honda Civic 2017+ under 10k€, Catalonia" });
	await mem.watchBoard(interest.id, "c_cars_es", "buysell");
	const watches = mem.activeWatches();
	assert.equal(watches.length, 1);
	assert.equal(watches[0].cluster_id, "c_cars_es");
	assert.equal(watches[0].board, "buysell");
});

test("muteFromFeedback removes the interest from activeWatches but keeps it on disk", async () => {
	const file = tmpFile();
	const mem = await new InterestsMemory(file).load();
	const interest = await mem.addInterest({ natural: "karting events nearby" });
	await mem.watchBoard(interest.id, "c_events", "events");
	await mem.muteFromFeedback(interest.id, "user said no more karting");
	assert.equal(mem.activeWatches().length, 0);

	const reloaded = await new InterestsMemory(file).load();
	assert.equal(reloaded.interests.length, 1);
	assert.equal(reloaded.interests[0].status, "muted_after_user_feedback");
});

test("unwatchBoard removes only the matching watch", async () => {
	const mem = await new InterestsMemory(tmpFile()).load();
	const interest = await mem.addInterest({ natural: "photography meetups" });
	await mem.watchBoard(interest.id, "c_photo", "events");
	await mem.watchBoard(interest.id, "c_photo", "buysell");
	await mem.unwatchBoard(interest.id, "c_photo", "events");
	const watches = mem.activeWatches();
	assert.equal(watches.length, 1);
	assert.equal(watches[0].board, "buysell");
});
