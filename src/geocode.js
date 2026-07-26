/**
 * geocode.js — resolve a free-text `home_location` ("City, Country") to
 * {lat, lon, label} ONCE, cached to disk. Needed because the cluster
 * protocol's `near=<lat,lon>&km=<radius>` post filter (clusters.md §8,
 * "PROPS — the structured property layer") wants real coordinates, and the
 * plugin only ever collects a human-typed city string from the user — never
 * ask them for their own lat/lon (operator's explicit call, 2026-07-26).
 *
 * Uses OpenStreetMap's Nominatim (no API key). Never throws: a network
 * failure or an unresolvable location just means geo filtering turns off
 * (permissive fallback, matching the rest of the board-charter protocol's
 * philosophy) rather than breaking the plugin.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

export class GeoCache {
	/** @param {string} filePath — e.g. `${stateDir}/geo-cache.json` */
	constructor(filePath) {
		this.filePath = filePath;
		/** @type {Record<string, {lat:number,lon:number,label:string}|null>} */
		this.entries = {};
	}

	async load() {
		try {
			this.entries = JSON.parse(await readFile(this.filePath, "utf8"));
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
			this.entries = {};
		}
		return this;
	}

	async save() {
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, JSON.stringify(this.entries, null, 2), { encoding: "utf8", mode: 0o600 });
	}

	/** `undefined` = never looked up; `null` = looked up, no result (still cached — don't hammer Nominatim on a bad city every tick). */
	get(query) {
		return this.entries[query];
	}

	async set(query, value) {
		this.entries[query] = value;
		await this.save();
	}
}

/** One live Nominatim lookup. Returns {lat, lon, label} or null — never throws. */
export async function geocodeLookup(query) {
	try {
		const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;
		const res = await fetch(url, {
			headers: { "user-agent": "meshkore-openclaw-plugin (https://meshkore.com/plugin/openclaw)" }
		});
		if (!res.ok) return null;
		const results = await res.json();
		const hit = results?.[0];
		if (!hit?.lat || !hit?.lon) return null;
		return { lat: Number(hit.lat), lon: Number(hit.lon), label: query };
	} catch {
		return null;
	}
}

/**
 * Builds a `geocode(query) => Promise<{lat,lon,label}|null>` function backed
 * by `cache` — a cache hit (including a cached miss) never touches the
 * network. Pass this into `MeshRuntime({ geocode })`.
 */
export function createGeocoder(cache) {
	return async function geocode(query) {
		if (!query) return null;
		const cached = cache.get(query);
		if (cached !== undefined) return cached;
		const value = await geocodeLookup(query);
		await cache.set(query, value);
		return value;
	};
}
