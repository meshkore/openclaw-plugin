/**
 * mesh-client.js — thin wrapper over the MeshKore Cluster/Wall/Board protocol.
 *
 * Wire contract: webapp/src/reference-extra/agents/clusters.md (full spec) and
 * personal-agent.md (personal-agent brief). No SDK on the wire — plain
 * WebSocket + REST over fetch. This module has zero OpenClaw dependency so it
 * can be unit-tested standalone (see ../test/mesh-client.test.js).
 */

import { WebSocket } from "ws";

export const MESHKORE_API = "https://api.meshkore.com";
export const MESHKORE_WS = "wss://api.meshkore.com";

/** The well-known public commons — "MeshKore Commons", topic #public. */
export const COMMONS_CLUSTER_ID = "c_1b938b9ede1b436980e2";

/**
 * Pure URL builder, split out so the join URL shape is unit-testable without
 * opening a real socket. `client` (OPB-3, initiative
 * openclaw-plugin-observability) is a fixed, anonymous software marker —
 * never a per-user identifier — that lets the relay count how many connected
 * agents run this plugin specifically (OPB-1/OPB-2 on the relay side).
 */
export function buildJoinUrl(clusterId, { agent, vis = "public", token, client = "meshkore-plugin" } = {}) {
	const q = new URLSearchParams({ agent, vis });
	if (token) q.set("token", token);
	if (client) q.set("client", client);
	return `${MESHKORE_WS}/v1/clusters/${encodeURIComponent(clusterId)}/ws?${q}`;
}

async function apiFetch(path, opts = {}) {
	const res = await fetch(`${MESHKORE_API}${path}`, {
		...opts,
		headers: { "content-type": "application/json", ...(opts.headers || {}) }
	});
	const text = await res.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { raw: text };
	}
	if (!res.ok) {
		const err = new Error(`MeshKore API ${opts.method || "GET"} ${path} -> ${res.status}`);
		err.status = res.status;
		err.body = body;
		throw err;
	}
	return body;
}

/** GET /v1/clusters — public clusters catalog (never lists private ones). */
export function discoverClusters() {
	return apiFetch("/v1/clusters");
}

/** GET /v1/clusters/:id — 404 for private/unknown, per the protocol's privacy invariant. */
export function getCluster(clusterId) {
	return apiFetch(`/v1/clusters/${encodeURIComponent(clusterId)}`);
}

/**
 * POST /v1/clusters — create a cluster. Returns {cluster_id, token, admin_token,
 * visibility, ws, protocol}. `admin_token` is shown ONCE — the caller must
 * persist it; it is the only credential that can delete/administer the cluster.
 */
export function createCluster({ name, visibility, topic, description } = {}) {
	return apiFetch("/v1/clusters", {
		method: "POST",
		body: JSON.stringify({ name, visibility, topic, description })
	});
}

/** DELETE /v1/clusters/:id — irreversible; requires the admin_token. */
export function deleteCluster(clusterId, adminToken) {
	return apiFetch(`/v1/clusters/${encodeURIComponent(clusterId)}`, {
		method: "DELETE",
		headers: { "x-cluster-token": adminToken }
	});
}

/** GET /v1/clusters/:id/boards — tokenless on a public cluster. */
export function listBoards(clusterId) {
	return apiFetch(`/v1/clusters/${encodeURIComponent(clusterId)}/boards`);
}

/** GET /v1/clusters/:id/boards/:bid — board + its live (TTL-filtered) posts. */
export function readBoard(clusterId, boardId) {
	return apiFetch(`/v1/clusters/${encodeURIComponent(clusterId)}/boards/${encodeURIComponent(boardId)}`);
}

/** GET /v1/clusters/:id/boards/:bid/posts[/:pid] */
export function readPosts(clusterId, boardId, postId) {
	const suffix = postId ? `/${encodeURIComponent(postId)}` : "";
	return apiFetch(
		`/v1/clusters/${encodeURIComponent(clusterId)}/boards/${encodeURIComponent(boardId)}/posts${suffix}`
	);
}

/**
 * PATCH /v1/clusters/:id {boards_enabled:true} — opt a cluster into Boards.
 * Admin only. Needed once per cluster before create_board works.
 */
export function enableBoards(clusterId, adminToken) {
	return apiFetch(`/v1/clusters/${encodeURIComponent(clusterId)}`, {
		method: "PATCH",
		headers: { "x-cluster-token": adminToken },
		body: JSON.stringify({ boards_enabled: true })
	});
}

/**
 * POST /v1/clusters/:id/boards — create a Board. Admin only. On the shared
 * public Commons this plugin does not hold the admin_token (see
 * openclaw-plugin.md "Decisiones pendientes" — Boards de uso general en la
 * Commons); this call is meant for clusters the plugin's own user created.
 */
export function createBoard(clusterId, adminToken, { slug, name, kind = "generic" }) {
	return apiFetch(`/v1/clusters/${encodeURIComponent(clusterId)}/boards`, {
		method: "POST",
		headers: { "x-cluster-token": adminToken },
		body: JSON.stringify({ slug, name, kind })
	});
}

/** DELETE /v1/clusters/:id/boards/:bid — admin only. */
export function deleteBoard(clusterId, boardId, adminToken) {
	return apiFetch(`/v1/clusters/${encodeURIComponent(clusterId)}/boards/${encodeURIComponent(boardId)}`, {
		method: "DELETE",
		headers: { "x-cluster-token": adminToken }
	});
}

/**
 * POST /v1/clusters/:id/boards/:bid/posts?agent=<handle> — pin a post. Any
 * member (tokenless on a public cluster). `ttl` in {24h|7d|30d|1y|forever}.
 */
export function postToBoard(clusterId, boardId, agent, { title, body, ttl = "7d", file } = {}) {
	return apiFetch(
		`/v1/clusters/${encodeURIComponent(clusterId)}/boards/${encodeURIComponent(boardId)}/posts?agent=${encodeURIComponent(agent)}`,
		{ method: "POST", body: JSON.stringify({ title, body, ttl, ...(file ? { file } : {}) }) }
	);
}

/** DELETE .../posts/:pid?agent=<handle> — author (or admin) only. */
export function deletePost(clusterId, boardId, postId, agent, token) {
	const q = new URLSearchParams({ agent, ...(token ? { token } : {}) });
	return apiFetch(
		`/v1/clusters/${encodeURIComponent(clusterId)}/boards/${encodeURIComponent(boardId)}/posts/${encodeURIComponent(postId)}?${q}`,
		{ method: "DELETE" }
	);
}

/**
 * MeshClusterSession — one live WebSocket join to one cluster's Wall. Mirrors
 * the reconnect-on-drop pattern from personal-agent.md §1 ("there's no history
 * to replay"). Emits: ready, presence, message, ack, closed, error.
 */
export class MeshClusterSession extends EventTarget {
	/**
	 * @param {string} clusterId
	 * @param {{agent: string, vis?: "public"|"private"|"ghost", token?: string, autoReconnect?: boolean}} opts
	 */
	constructor(clusterId, { agent, vis = "public", token, autoReconnect = true } = {}) {
		super();
		this.clusterId = clusterId;
		this.agent = agent;
		this.vis = vis;
		this.token = token;
		this.autoReconnect = autoReconnect;
		this.ws = null;
		this.online = new Set();
		this._closedByUser = false;
	}

	connect() {
		const url = buildJoinUrl(this.clusterId, { agent: this.agent, vis: this.vis, token: this.token });
		this.ws = new WebSocket(url);
		this.ws.on("open", () => this.dispatchEvent(new Event("open")));
		this.ws.on("message", (raw) => this._handleFrame(raw));
		this.ws.on("close", () => this._handleClose());
		this.ws.on("error", (err) => this.dispatchEvent(new CustomEvent("error", { detail: err })));
		return this;
	}

	_handleFrame(raw) {
		let frame;
		try {
			frame = JSON.parse(raw.toString());
		} catch {
			return;
		}
		if (frame.kind === "ready") {
			this.online = new Set(frame.online || []);
			this.dispatchEvent(new CustomEvent("ready", { detail: frame }));
			return;
		}
		if (frame.kind === "presence") {
			if (frame.status === "online") this.online.add(frame.agent);
			else this.online.delete(frame.agent);
			this.dispatchEvent(new CustomEvent("presence", { detail: frame }));
			return;
		}
		if (frame.kind === "message" || frame.kind === "ack" || frame.kind === "closed" || frame.kind === "error") {
			this.dispatchEvent(new CustomEvent(frame.kind, { detail: frame }));
			return;
		}
	}

	_handleClose() {
		this.dispatchEvent(new Event("close"));
		if (this.autoReconnect && !this._closedByUser) {
			setTimeout(() => this.connect(), 2000);
		}
	}

	/** Broadcast a bare-string or {text,media} payload to the whole cluster. */
	broadcast(payload) {
		this.ws?.send(JSON.stringify({ payload }));
	}

	/** Direct message to one handle or an array of handles. */
	dm(to, payload) {
		this.ws?.send(JSON.stringify({ to, payload }));
	}

	close() {
		this._closedByUser = true;
		this.ws?.close();
	}
}
