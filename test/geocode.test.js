import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeoCache, geocodeLookup, createGeocoder } from "../src/geocode.js";

function tmpFile() {
	return join(tmpdir(), `meshkore-geocache-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test("GeoCache — get/set round-trip, distinguishes 'never looked up' from 'looked up, no result'", async () => {
	const cache = await new GeoCache(tmpFile()).load();
	assert.equal(cache.get("Seville, Spain"), undefined);
	await cache.set("Seville, Spain", { lat: 1, lon: 2, label: "Seville, Spain" });
	assert.deepEqual(cache.get("Seville, Spain"), { lat: 1, lon: 2, label: "Seville, Spain" });
	await cache.set("Nowhereville", null);
	assert.equal(cache.get("Nowhereville"), null);
});

test("GeoCache — persists across reload", async () => {
	const file = tmpFile();
	const cache = await new GeoCache(file).load();
	await cache.set("Seville, Spain", { lat: 1, lon: 2, label: "Seville, Spain" });
	const reloaded = await new GeoCache(file).load();
	assert.deepEqual(reloaded.get("Seville, Spain"), { lat: 1, lon: 2, label: "Seville, Spain" });
});

test("GeoCache — missing file loads as empty, not an error", async () => {
	const cache = await new GeoCache(join(tmpdir(), "does-not-exist-meshkore-geo.json")).load();
	assert.deepEqual(cache.entries, {});
});

test("geocodeLookup — never throws on a network failure", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("network down");
	};
	assert.equal(await geocodeLookup("Seville, Spain"), null);
	globalThis.fetch = originalFetch;
});

test("geocodeLookup — parses the first Nominatim hit into {lat, lon, label}", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		ok: true,
		json: async () => [{ lat: "37.3891", lon: "-5.9845" }]
	});
	const result = await geocodeLookup("Seville, Spain");
	assert.deepEqual(result, { lat: 37.3891, lon: -5.9845, label: "Seville, Spain" });
	globalThis.fetch = originalFetch;
});

test("geocodeLookup — no results returns null, not a crash", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: true, json: async () => [] });
	assert.equal(await geocodeLookup("Nowhereville"), null);
	globalThis.fetch = originalFetch;
});

test("createGeocoder — caches a hit and a miss, never re-hits the network on the same query", async () => {
	const cache = await new GeoCache(tmpFile()).load();
	let calls = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		calls++;
		return { ok: true, json: async () => [{ lat: "1", lon: "2" }] };
	};
	const geocode = createGeocoder(cache);
	assert.deepEqual(await geocode("Seville, Spain"), { lat: 1, lon: 2, label: "Seville, Spain" });
	assert.deepEqual(await geocode("Seville, Spain"), { lat: 1, lon: 2, label: "Seville, Spain" });
	assert.equal(calls, 1, "second call must be served from cache");
	globalThis.fetch = originalFetch;
});

test("createGeocoder — an empty/falsy query never hits the network", async () => {
	const cache = await new GeoCache(tmpFile()).load();
	let calls = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		calls++;
		return { ok: true, json: async () => [] };
	};
	const geocode = createGeocoder(cache);
	assert.equal(await geocode(""), null);
	assert.equal(await geocode(undefined), null);
	assert.equal(calls, 0);
	globalThis.fetch = originalFetch;
});
