/**
 * runtime.js — MeshRuntime: the single shared session registry used by the
 * tool catalog (tools.js), the heartbeat service (heartbeat.js) and novelty
 * delivery (novelty.js). One MeshRuntime per OpenClaw plugin instance.
 *
 * 2026-07-22 deeper-testing pass: admin_token / private-cluster join tokens
 * are now backed by `ClusterCredentials` (persisted, mode 0o600) instead of
 * an in-memory Map — an OpenClaw restart no longer orphans clusters this
 * agent created, and it can now rejoin a private cluster automatically.
 */

import * as mesh from "./mesh-client.js";

export class MeshRuntime {
	/**
	 * @param {{handle: string, visibility?: string, credentials: import("./credentials.js").ClusterCredentials, log?: (msg: string) => void, homeLocation?: string, adultOptIn?: boolean, lang?: string, nearRadiusKm?: number, geocode?: (query: string) => Promise<{lat:number,lon:number,label:string}|null>}} opts
	 */
	constructor({
		handle,
		visibility = "public",
		credentials,
		log = () => {},
		homeLocation,
		adultOptIn = false,
		lang,
		nearRadiusKm = 50,
		geocode
	} = {}) {
		this.handle = handle;
		this.visibility = visibility;
		this.credentials = credentials;
		this.log = log;
		/** "City, Country" — see the board-charter protocol (2026-07-24). Unset disables both auto-tagging and location filtering. */
		this.homeLocation = homeLocation || null;
		this.adultOptIn = Boolean(adultOptIn);
		/** Working language ("en", "es", ...) — stamped on posts and used to filter board reads via the PROPS layer. Unset disables both. */
		this.lang = lang || null;
		/** Radius (km) for the PROPS layer's `near=` filter once home_location is geocoded. */
		this.nearRadiusKm = nearRadiusKm || 50;
		/** Resolves "City, Country" -> {lat,lon,label}, once, cached — see geocode.js. No-op (geo filtering off) if not injected. */
		this.geocode = geocode || (async () => null);
		this._homeCoordsCache = undefined; // undefined = not yet resolved; null = resolved, no result
		/** @type {Map<string, import("./mesh-client.js").MeshClusterSession>} */
		this.sessions = new Map();
		this._boardsEnabled = new Set();
	}

	/**
	 * Join a cluster's Wall (idempotent — returns the existing session if
	 * already joined). Tokenless for a public cluster; for a PRIVATE cluster
	 * pass `token` explicitly the first time (a friend shared it out-of-band)
	 * — it's remembered from then on, so a restart rejoins automatically
	 * without asking the user again.
	 *
	 * Board-charter protocol (2026-07-24): a join ALSO fetches the cluster's
	 * Boards right away and attaches them (each with its `about` charter) to
	 * the returned `ready` object — "treat the charter list as the cluster's
	 * welcome prompt." This makes the charter-first rule structural rather
	 * than something the LLM has to remember to do as a second call.
	 */
	async joinCluster(clusterId = mesh.COMMONS_CLUSTER_ID, { vis = this.visibility, token } = {}) {
		const existing = this.sessions.get(clusterId);
		if (existing) return existing;
		const joinToken = token || this.credentials.joinToken(clusterId);
		if (token) await this.credentials.remember(clusterId, { token });
		const session = new mesh.MeshClusterSession(clusterId, { agent: this.handle, vis, token: joinToken });
		const readyFrame = new Promise((resolve) => {
			session.addEventListener("ready", (e) => resolve(e.detail), { once: true });
		});
		session.connect();
		this.sessions.set(clusterId, session);
		this.log(`joined cluster ${clusterId} as ${this.handle} (${vis}${joinToken ? ", private" : ""})`);
		const frame = await readyFrame;
		const boards = await this._safeListBoardsWithCharters(clusterId);
		return { session, ready: { ...frame, boards } };
	}

	/**
	 * Boards + their charters, fetched right after joining. Never throws — a
	 * cluster with Boards disabled, or a transient fetch error, just means an
	 * empty list, not a broken join.
	 */
	async _safeListBoardsWithCharters(clusterId) {
		try {
			const { boards } = await mesh.listBoards(clusterId);
			return boards || [];
		} catch {
			return [];
		}
	}

	leaveCluster(clusterId) {
		const session = this.sessions.get(clusterId);
		if (!session) return false;
		session.close();
		this.sessions.delete(clusterId);
		return true;
	}

	/** Who's online right now, per the ready.online snapshot + presence deltas. */
	listOnlineAgents(clusterId) {
		const session = this.sessions.get(clusterId);
		if (!session) throw new Error(`not joined to cluster ${clusterId} — call join_cluster first`);
		return [...session.online];
	}

	broadcast(clusterId, text) {
		const session = this.sessions.get(clusterId);
		if (!session) throw new Error(`not joined to cluster ${clusterId} — call join_cluster first`);
		session.broadcast(text);
	}

	dm(clusterId, toHandle, text) {
		const session = this.sessions.get(clusterId);
		if (!session) throw new Error(`not joined to cluster ${clusterId} — call join_cluster first`);
		session.dm(toHandle, text);
	}

	listBoards(clusterId) {
		return mesh.listBoards(clusterId);
	}

	/**
	 * Per-key downward inheritance over the PROPS layer (clusters.md §8):
	 * cluster -> board -> post, a value set at a lower level wins, an unset
	 * key inherits from the level above. Levels are merged left to right.
	 */
	static mergeProps(...levels) {
		const result = {};
		for (const level of levels) {
			if (!level) continue;
			for (const key of ["where", "lang", "entry", "limits"]) {
				if (level[key] !== undefined) result[key] = level[key];
			}
		}
		return result;
	}

	/** Board metadata (incl. its `about` charter and merged `effectiveProps`) by slug or opaque id, or null if not found. */
	async _findBoard(clusterId, slugOrId) {
		const { boards, cluster_props } = await mesh.listBoards(clusterId);
		const board = boards?.find((b) => b.slug === slugOrId || b.id === slugOrId);
		if (!board) return null;
		return { ...board, effectiveProps: MeshRuntime.mergeProps(cluster_props, board.props) };
	}

	/**
	 * Resolves `homeLocation` to real coordinates ONCE per runtime instance
	 * (in-memory memo on top of whatever disk cache `this.geocode` itself
	 * uses) — never re-geocodes on every board read/post. Returns null (geo
	 * filtering/stamping just turns off) when unset or unresolvable.
	 */
	async _resolveHomeCoords() {
		if (!this.homeLocation) return null;
		if (this._homeCoordsCache !== undefined) return this._homeCoordsCache;
		this._homeCoordsCache = (await this.geocode(this.homeLocation)) || null;
		return this._homeCoordsCache;
	}

	/** The `props` object to stamp on a new post (`{where, lang}`), or null if neither is configured. */
	async _effectivePostProps() {
		const coords = await this._resolveHomeCoords();
		const where = coords ? { lat: coords.lat, lon: coords.lon, label: coords.label || this.homeLocation } : undefined;
		if (!where && !this.lang) return null;
		return { ...(where ? { where } : {}), ...(this.lang ? { lang: this.lang } : {}) };
	}

	/**
	 * The REST path wants the board's opaque `id` (`b_…`), not its human `slug`
	 * — verified live 2026-07-22 (a slug in the path 404s: `board_not_found`).
	 * Every public method here accepts EITHER (matches how a human/LLM would
	 * say "the buysell board") and resolves to the real id via one list call.
	 */
	async _resolveBoardId(clusterId, slugOrId) {
		if (slugOrId.startsWith("b_")) return slugOrId;
		const match = await this._findBoard(clusterId, slugOrId);
		if (!match) throw new Error(`no board "${slugOrId}" found in cluster ${clusterId}`);
		return match.id;
	}

	/** Leading "[City, ...]" (or "[City]") tag, case-insensitive-safe for comparison. Null if absent. */
	static LOCATION_TAG_RE = /^\s*\[([^,\]]+)/;
	/** Heuristic only — no structured audience field exists on the wire protocol yet (facets are "coming"). */
	static ADULT_CHARTER_RE = /\b18\s*\+|\badults?\b|\bnsfw\b/i;

	/** Auto-prefixes "[City, Country]" onto a post title that isn't already tagged, per the board-charter protocol. A no-op without a configured homeLocation, and never overrides a tag the caller already set. */
	_withLocationTag(title) {
		if (!this.homeLocation || MeshRuntime.LOCATION_TAG_RE.test(title || "")) return title;
		return `[${this.homeLocation}] ${title}`;
	}

	/**
	 * Refuses to read/post on a Board gated for adults unless adultOptIn is
	 * set — a client-side pre-check so the user gets a clear explanation
	 * instead of a raw 403 `age_gated` from the relay. Prefers the real,
	 * structured `entry.age_min` (clusters.md §8) merged via `effectiveProps`
	 * (set by `_findBoard`); falls back to the old charter-text heuristic
	 * only for a board with no structured `entry` at all (created before the
	 * PROPS layer shipped).
	 */
	_assertAudienceAllowed(board) {
		if (!board || this.adultOptIn) return;
		const ageMin = board.effectiveProps?.entry?.age_min;
		if (typeof ageMin === "number" && ageMin >= 18) {
			throw new Error(
				`board "${board.slug || board.id}" requires age_min ${ageMin} (adult/18+) — ` +
					`adult_content_opt_in is false, so this agent won't read or post there. Ask the user to opt in first if this is wanted.`
			);
		}
		if (ageMin === undefined && board.about && MeshRuntime.ADULT_CHARTER_RE.test(board.about)) {
			throw new Error(
				`board "${board.slug || board.id}" charter indicates adult/18+ content — ` +
					`adult_content_opt_in is false, so this agent won't post there. Ask the user to opt in first if this is wanted.`
			);
		}
	}

	/**
	 * Reads a Board's live posts through the PROPS layer's filtered endpoint
	 * (clusters.md §8: `GET .../posts?near=&km=&lang=&adult=`) instead of
	 * fetching everything and filtering client-side — this is what actually
	 * lets "search near me" scale to a board with listings from hundreds of
	 * cities. `near`/`km` come from the geocoded `homeLocation`; `lang` from
	 * the `lang` config; `adult=1` is sent automatically once the user has
	 * opted in (age-gated boards refuse reads without it, same as posts).
	 * Returns `{board, posts}` — `board` carries the charter/props, `posts`
	 * the (already server-filtered) live listings.
	 */
	async readBoard(clusterId, boardIdOrSlug) {
		const board = await this._findBoard(clusterId, boardIdOrSlug);
		const boardId = board?.id || boardIdOrSlug;
		this._assertAudienceAllowed(board);
		const coords = await this._resolveHomeCoords();
		const { posts } = await mesh.readPosts(clusterId, boardId, undefined, {
			near: coords ? `${coords.lat},${coords.lon}` : undefined,
			km: coords ? this.nearRadiusKm : undefined,
			lang: this.lang || undefined,
			adult: this.adultOptIn ? 1 : undefined
		});
		return { board, posts };
	}

	/**
	 * Found 2026-07-23 (scenario-catalog gap audit): `mesh.deletePost` existed
	 * in mesh-client.js since day one but nothing ever wired it up — a user
	 * asking "delete the post I made yesterday" had no tool that could do it.
	 * Author-only per the protocol (clusters.md §8: "deleting a post = its
	 * author... or admin") — the relay itself enforces this via the `agent`
	 * query param matching the post's stored author; passing this agent's own
	 * handle is what makes that check pass for a post this agent made.
	 */
	async deletePost(clusterId, boardIdOrSlug, postId) {
		const boardId = await this._resolveBoardId(clusterId, boardIdOrSlug);
		return mesh.deletePost(clusterId, boardId, postId, this.handle, this.credentials.joinToken(clusterId));
	}

	/**
	 * OPQ-6: the protocol has no idempotency key (verified against
	 * clusters.md), and a stalled-then-retried LLM turn can call this tool
	 * twice for the identical post (found live 2026-07-23: AIMLAPI/OpenClaw
	 * occasionally retries a turn after a slow response, even when the first
	 * attempt's tool call already landed server-side). Guard client-side:
	 * skip posting — and return the existing post — if this same agent
	 * already has a live post with the same title+body on this board from
	 * within the last `DEDUPE_WINDOW_MS`.
	 */
	async postToBoard(clusterId, boardIdOrSlug, { title, body, ttl }) {
		const board = await this._findBoard(clusterId, boardIdOrSlug);
		const boardId = board?.id || boardIdOrSlug;
		this._assertAudienceAllowed(board);
		const finalTitle = this._withLocationTag(title);
		this._assertWithinPostLimit(board, { title: finalTitle, body });
		const existing = await this._findRecentDuplicatePost(clusterId, boardId, { title: finalTitle, body });
		if (existing) return { ...existing, deduped: true };
		// PROPS layer (clusters.md §8, "WRITE: stamp every located post") — without
		// this, this agent's own posts never surface in anyone else's `near=` read.
		const props = await this._effectivePostProps();
		return mesh.postToBoard(clusterId, boardId, this.handle, {
			title: finalTitle,
			body,
			ttl,
			...(props ? { props } : {}),
			...(this.adultOptIn ? { adult: 1 } : {})
		});
	}

	/**
	 * Client-side pre-check against `effectiveProps.limits.post_max_chars`
	 * (clusters.md §8: "ENFORCED at post create (422)") — fails fast with a
	 * specific, actionable message instead of letting a raw 422
	 * `post_too_long` reach the LLM. Conservative: counts title+body combined
	 * since the relay's exact split isn't documented. A board with no
	 * structured `limits` is unrestricted here (the relay is still the real
	 * enforcement point either way).
	 */
	_assertWithinPostLimit(board, { title, body }) {
		const maxChars = board?.effectiveProps?.limits?.post_max_chars;
		if (typeof maxChars !== "number") return;
		const length = (title || "").length + (body || "").length;
		if (length > maxChars) {
			throw new Error(
				`post is ${length} chars, over board "${board.slug || board.id}"'s limit of ${maxChars} ` +
					`(props.limits.post_max_chars) — shorten the title/body before posting.`
			);
		}
	}

	static DEDUPE_WINDOW_MS = 5 * 60 * 1000;

	async _findRecentDuplicatePost(clusterId, boardId, { title, body }) {
		let boardData;
		try {
			boardData = await mesh.readBoard(clusterId, boardId);
		} catch {
			return null; // can't check — fall through to a normal post attempt
		}
		const posts = boardData.posts || boardData.board?.posts || [];
		const cutoff = Date.now() / 1000 - MeshRuntime.DEDUPE_WINDOW_MS / 1000;
		return (
			posts.find(
				(p) =>
					p.author === this.handle &&
					p.title === title &&
					p.body === body &&
					(p.created_at == null || p.created_at >= cutoff)
			) || null
		);
	}

	/**
	 * Create a Board. Only works on a cluster where this runtime holds the
	 * admin_token (i.e. a cluster the plugin's own user created via
	 * create_cluster) — see openclaw-plugin.md's open decision about Boards on
	 * the shared public Commons.
	 */
	async createBoard(clusterId, { slug, name, kind, about, location, lang, minAge, maxPostChars }) {
		const adminToken = this.credentials.adminToken(clusterId);
		if (!adminToken) {
			throw new Error(
				`no admin_token held for cluster ${clusterId} — this agent did not create it, so it cannot ` +
					`declare Boards here (the shared public Commons is admin-owned by MeshKore, not by this plugin). ` +
					`Create your own public cluster first (create_cluster) if you need a Board of your own.`
			);
		}
		if (!this._boardsEnabled.has(clusterId)) {
			await mesh.enableBoards(clusterId, adminToken); // PATCH boards_enabled:true — required once per cluster (verified live: 409 boards_disabled otherwise)
			this._boardsEnabled.add(clusterId);
		}
		const props = await this._buildBoardProps({ location, lang, minAge, maxPostChars });
		return mesh.createBoard(clusterId, adminToken, { slug, name, kind, about, ...(props ? { props } : {}) });
	}

	/**
	 * Assembles a board-level PROPS object (clusters.md §8) from human-friendly
	 * inputs so a user creating their OWN themed board can set its location,
	 * language, age gate and post-length limit — the write-side complement of
	 * the read/post filtering. `location` is geocoded (same cached geocoder as
	 * home_location); the rest map straight through. Returns null when nothing
	 * was specified (an unconstrained board, exactly as before).
	 */
	async _buildBoardProps({ location, lang, minAge, maxPostChars } = {}) {
		const props = {};
		if (location) {
			const coords = await this.geocode(location);
			if (coords) props.where = { lat: coords.lat, lon: coords.lon, label: coords.label || location };
		}
		if (lang) props.lang = lang;
		if (typeof minAge === "number") props.entry = { age_min: minAge };
		if (typeof maxPostChars === "number") props.limits = { post_max_chars: maxPostChars };
		return Object.keys(props).length ? props : null;
	}

	/**
	 * Create a new cluster — public (listed, tokenless) or private
	 * (token-gated, for a closed friend group). Credentials are PERSISTED
	 * (`ClusterCredentials`) — survives an OpenClaw restart. The join `token`
	 * (private only) and `admin_token` are never returned raw from this
	 * method's callers in tools.js; see `getClusterInvite`/`revealAdminToken`
	 * for the explicit, deliberate reveal path.
	 */
	async createCluster({ name, visibility, topic, description }) {
		const created = await mesh.createCluster({ name, visibility, topic, description });
		await this.credentials.remember(created.cluster_id, {
			adminToken: created.admin_token,
			token: created.token,
			name,
			visibility: created.visibility
		});
		return created;
	}

	/**
	 * The join token for a PRIVATE cluster — meant to be handed to a friend
	 * out-of-band (WhatsApp, in person, …) so their agent can join too.
	 * Deliberately separate from admin_token (which can delete the cluster).
	 */
	getClusterInvite(clusterId) {
		const token = this.credentials.joinToken(clusterId);
		if (!token) throw new Error(`no join token held for cluster ${clusterId} (is it public, or not yours?)`);
		return { cluster_id: clusterId, token };
	}

	/** High-risk reveal — the ONLY credential that can delete/administer a cluster. */
	revealAdminToken(clusterId) {
		const adminToken = this.credentials.adminToken(clusterId);
		if (!adminToken) throw new Error(`no admin_token held for cluster ${clusterId} — this agent did not create it`);
		return { cluster_id: clusterId, admin_token: adminToken };
	}

	async deleteOwnCluster(clusterId) {
		const adminToken = this.credentials.adminToken(clusterId);
		if (!adminToken) throw new Error(`no admin_token held for cluster ${clusterId} — cannot delete a cluster this agent didn't create`);
		const result = await mesh.deleteCluster(clusterId, adminToken);
		await this.credentials.forget(clusterId);
		this.leaveCluster(clusterId);
		return result;
	}

	discoverClusters() {
		return mesh.discoverClusters();
	}

	shutdown() {
		for (const session of this.sessions.values()) session.close();
		this.sessions.clear();
	}
}
