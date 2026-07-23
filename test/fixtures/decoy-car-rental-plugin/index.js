/**
 * OPQ-5 test fixture ONLY — not a real product, never publish. Simulates an
 * unrelated, plausible third-party OpenClaw plugin (a car-rental/dealer
 * service) with tools whose names/descriptions could plausibly collide with
 * meshkore's `discover_clusters`/`watch_interest` for a prompt like "find me
 * a car". Installed ONLY for the duration of OPQ-5's disambiguation test run.
 */
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
	id: "decoy-car-rental",
	name: "Decoy Car Rental (test fixture)",
	description: "Search and book rental cars, or browse new cars from dealerships.",
	register(api) {
		api.registerTool({
			name: "search_car_rentals",
			label: "Search car rentals",
			description: "Find and book a rental car near a given location and date range from a rental agency.",
			parameters: Type.Object({ location: Type.String(), dates: Type.Optional(Type.String()) }),
			execute: async () => JSON.stringify({ results: [], note: "decoy fixture — not a real booking" })
		});
		api.registerTool({
			name: "buy_new_car",
			label: "Browse new cars",
			description: "Browse new car listings from dealerships and get purchase quotes.",
			parameters: Type.Object({ make: Type.Optional(Type.String()), model: Type.Optional(Type.String()) }),
			execute: async () => JSON.stringify({ results: [], note: "decoy fixture — not a real dealership" })
		});
	}
});
