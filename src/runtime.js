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
	 * @param {{handle: string, visibility?: string, credentials: import("./credentials.js").ClusterCredentials, log?: (msg: string) => void, homeLocation?: string, adultOptIn?: boolean}} opts
	 */
	constructor({ handle, visibility = "public", credentials, log = () => {}, homeLocation, adultOptIn = false } = {}) {
		this.handle = handle;
		this.visibility = visibility;
		this.credentials = credentials;
		this.log = log;
		/** "City, Country" — see the board-charter protocol (2026-07-24). Unset disables both auto-tagging and location filtering. */
		this.homeLocation = homeLocation || null;
		this.adultOptIn = Boolean(adultOptIn);
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

	/** Board metadata (incl. its `about` charter) by slug or opaque id, or null if not found. */
	async _findBoard(clusterId, slugOrId) {
		const { boards } = await mesh.listBoards(clusterId);
		return boards?.find((b) => b.slug === slugOrId || b.id === slugOrId) || null;
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

	/** Refuses to post to a Board whose charter reads as 18+/adult unless adultOptIn is set. */
	_assertAudienceAllowed(board) {
		if (!board?.about || this.adultOptIn) return;
		if (MeshRuntime.ADULT_CHARTER_RE.test(board.about)) {
			throw new Error(
				`board "${board.slug || board.id}" charter indicates adult/18+ content — ` +
					`adult_content_opt_in is false, so this agent won't post there. Ask the user to opt in first if this is wanted.`
			);
		}
	}

	async readBoard(clusterId, boardIdOrSlug) {
		const boardId = await this._resolveBoardId(clusterId, boardIdOrSlug);
		return mesh.readBoard(clusterId, boardId);
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
		const existing = await this._findRecentDuplicatePost(clusterId, boardId, { title: finalTitle, body });
		if (existing) return { ...existing, deduped: true };
		return mesh.postToBoard(clusterId, boardId, this.handle, { title: finalTitle, body, ttl });
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
	async createBoard(clusterId, { slug, name, kind, about }) {
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
		return mesh.createBoard(clusterId, adminToken, { slug, name, kind, about });
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
