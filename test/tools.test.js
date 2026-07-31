import { test } from "node:test";
import assert from "node:assert/strict";
import { createMeshTools } from "../src/tools.js";
import { COMMONS_CLUSTER_ID } from "../src/mesh-client.js";

/** A fake {runtime, memory} pair with spies, matching the shape tools.js expects from getState(). */
function fakeState() {
	const calls = [];
	const runtime = {
		joinCluster: async (clusterId, opts) => {
			calls.push(["joinCluster", clusterId, opts]);
			return { session: {}, ready: { online: ["alice"], boards: [{ id: "b_1", slug: "buysell", about: "Sell stuff, tag [City, Country]." }] } };
		},
		listOnlineAgents: (clusterId) => {
			calls.push(["listOnlineAgents", clusterId]);
			return ["alice", "bob"];
		},
		broadcast: (clusterId, text) => calls.push(["broadcast", clusterId, text]),
		dm: (clusterId, handle, text) => calls.push(["dm", clusterId, handle, text]),
		listBoards: async (clusterId) => {
			calls.push(["listBoards", clusterId]);
			return { boards: [{ id: "b_1", slug: "buysell" }] };
		},
		readBoard: async (clusterId, boardId) => {
			calls.push(["readBoard", clusterId, boardId]);
			return { posts: [] };
		},
		postToBoard: async (clusterId, boardId, body) => {
			calls.push(["postToBoard", clusterId, boardId, body]);
			return { id: "p_1" };
		},
		deletePost: async (clusterId, boardId, postId) => {
			calls.push(["deletePost", clusterId, boardId, postId]);
			return { ok: true };
		},
		createBoard: async (clusterId, body) => {
			calls.push(["createBoard", clusterId, body]);
			return { board: { id: "b_new" } };
		},
		createCluster: async (params) => {
			calls.push(["createCluster", params]);
			return { cluster_id: "c_new", visibility: params.visibility || "public" };
		},
		getClusterInvite: (clusterId) => {
			calls.push(["getClusterInvite", clusterId]);
			return { cluster_id: clusterId, token: "ck_x" };
		},
		revealAdminToken: (clusterId) => {
			calls.push(["revealAdminToken", clusterId]);
			return { cluster_id: clusterId, admin_token: "ak_x" };
		},
		deleteOwnCluster: async (clusterId) => {
			calls.push(["deleteOwnCluster", clusterId]);
			return { ok: true };
		},
		discoverClusters: async () => {
			calls.push(["discoverClusters"]);
			return { clusters: [] };
		}
	};
	const memory = {
		addInterest: async ({ natural }) => {
			calls.push(["addInterest", natural]);
			return { id: "int_1", watching: [] };
		},
		watchBoard: async (interestId, clusterId, board) => {
			calls.push(["watchBoard", interestId, clusterId, board]);
		},
		interests: [
			{ id: "int_1", natural: "Honda Civic 2017+", status: "active", watching: [{ cluster_id: "c_cars", board: "buysell" }], last_match: null }
		],
		unwatchBoard: async (interestId, clusterId, board) => {
			calls.push(["unwatchBoard", interestId, clusterId, board]);
			return true;
		},
		muteFromFeedback: async (interestId, rule) => {
			calls.push(["muteFromFeedback", interestId, rule]);
			return { id: interestId, status: "muted_after_user_feedback" };
		}
	};
	const getState = () => ({ runtime, memory, ready: Promise.resolve() });
	return { getState, calls };
}

function toolByName(tools, name) {
	const t = tools.find((t) => t.name === name);
	assert.ok(t, `tool "${name}" not found`);
	return t;
}

test("all 18 tools are registered", () => {
	const { getState } = fakeState();
	const tools = createMeshTools(getState);
	assert.equal(tools.length, 18);
	const names = tools.map((t) => t.name).sort();
	assert.deepEqual(names, [
		"broadcast",
		"create_board",
		"create_cluster",
		"delete_cluster",
		"delete_post",
		"discover_clusters",
		"dm",
		"get_cluster_invite",
		"join_cluster",
		"list_boards",
		"list_interests",
		"list_online_agents",
		"mute_interest",
		"post_to_board",
		"read_board",
		"reveal_admin_token",
		"unwatch_interest",
		"watch_interest"
	]);
});

test("delete_post delegates to runtime.deletePost", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "delete_post");
	const result = await tool.execute({ cluster_id: "c_1", board_id: "b_1", post_id: "p_1" });
	assert.deepEqual(calls[0], ["deletePost", "c_1", "b_1", "p_1"]);
	assert.equal(result.ok, true);
});

test("list_interests returns a trimmed view of memory.interests", async () => {
	const { getState } = fakeState();
	const tool = toolByName(createMeshTools(getState), "list_interests");
	const result = await tool.execute({});
	assert.equal(result.interests.length, 1);
	assert.equal(result.interests[0].id, "int_1");
	assert.equal(result.interests[0].status, "active");
});

test("unwatch_interest delegates to memory.unwatchBoard", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "unwatch_interest");
	const result = await tool.execute({ interest_id: "int_1", cluster_id: "c_cars", board: "buysell" });
	assert.deepEqual(calls[0], ["unwatchBoard", "int_1", "c_cars", "buysell"]);
	assert.equal(result.unwatched, true);
});

test("mute_interest delegates to memory.muteFromFeedback with the user's rule", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "mute_interest");
	const result = await tool.execute({ interest_id: "int_1", rule: "user said no more karting" });
	assert.deepEqual(calls[0], ["muteFromFeedback", "int_1", "user said no more karting"]);
	assert.equal(result.status, "muted_after_user_feedback");
});

test("join_cluster — defaults to the Commons when no cluster_id given", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "join_cluster");
	const result = await tool.execute({});
	assert.deepEqual(calls[0], ["joinCluster", COMMONS_CLUSTER_ID, { vis: undefined, token: undefined }]);
	assert.equal(result.joined, COMMONS_CLUSTER_ID);
	assert.deepEqual(result.online_now, ["alice"]);
	assert.deepEqual(result.boards, [{ id: "b_1", slug: "buysell", about: "Sell stuff, tag [City, Country]." }]);
});

test("join_cluster — passes through an explicit cluster_id/vis/token", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "join_cluster");
	await tool.execute({ cluster_id: "c_1", vis: "ghost", token: "ck_x" });
	assert.deepEqual(calls[0], ["joinCluster", "c_1", { vis: "ghost", token: "ck_x" }]);
});

test("list_online_agents delegates and returns {online}", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "list_online_agents");
	const result = await tool.execute({ cluster_id: "c_1" });
	assert.deepEqual(calls[0], ["listOnlineAgents", "c_1"]);
	assert.deepEqual(result.online, ["alice", "bob"]);
});

test("broadcast delegates text to runtime.broadcast", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "broadcast");
	const result = await tool.execute({ cluster_id: "c_1", text: "hi all" });
	assert.deepEqual(calls[0], ["broadcast", "c_1", "hi all"]);
	assert.equal(result.sent, true);
});

test("dm delegates handle + text to runtime.dm", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "dm");
	const result = await tool.execute({ cluster_id: "c_1", handle: "bob", text: "psst" });
	assert.deepEqual(calls[0], ["dm", "c_1", "bob", "psst"]);
	assert.equal(result.to, "bob");
});

test("list_boards / read_board delegate and pass through the result", async () => {
	const { getState, calls } = fakeState();
	const tools = createMeshTools(getState);
	const boards = await toolByName(tools, "list_boards").execute({ cluster_id: "c_1" });
	assert.deepEqual(boards.boards, [{ id: "b_1", slug: "buysell" }]);
	const board = await toolByName(tools, "read_board").execute({ cluster_id: "c_1", board_id: "b_1" });
	assert.deepEqual(board.posts, []);
	assert.deepEqual(calls, [
		["listBoards", "c_1"],
		["readBoard", "c_1", "b_1"]
	]);
});

test("post_to_board passes title/body/ttl through", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "post_to_board");
	await tool.execute({ cluster_id: "c_1", board_id: "b_1", title: "Bike", body: "150€", ttl: "30d" });
	assert.deepEqual(calls[0], ["postToBoard", "c_1", "b_1", { title: "Bike", body: "150€", ttl: "30d" }]);
});

test("create_board passes slug/name/kind through", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "create_board");
	await tool.execute({ cluster_id: "c_1", slug: "events", name: "Events", kind: "events" });
	assert.deepEqual(calls[0], ["createBoard", "c_1", { slug: "events", name: "Events", kind: "events" }]);
});

test("create_board passes an about charter through when given", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "create_board");
	await tool.execute({ cluster_id: "c_1", slug: "events", name: "Events", kind: "events", about: "Post events with date/time." });
	assert.deepEqual(calls[0], ["createBoard", "c_1", { slug: "events", name: "Events", kind: "events", about: "Post events with date/time." }]);
});

test("create_board maps location/lang/min_age/max_post_chars to runtime board-props inputs", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "create_board");
	await tool.execute({
		cluster_id: "c_1",
		slug: "cars",
		name: "Seville cars",
		kind: "buysell",
		location: "Seville, Spain",
		lang: "es",
		min_age: 18,
		max_post_chars: 400
	});
	assert.deepEqual(calls[0], [
		"createBoard",
		"c_1",
		{ slug: "cars", name: "Seville cars", kind: "buysell", location: "Seville, Spain", lang: "es", minAge: 18, maxPostChars: 400 }
	]);
});

test("create_cluster — public cluster note doesn't mention join token", async () => {
	const { getState } = fakeState();
	const tool = toolByName(createMeshTools(getState), "create_cluster");
	const result = await tool.execute({ name: "Cars club", visibility: "public" });
	assert.equal(result.cluster_id, "c_new");
	assert.match(result.note, /admin_token/);
});

test("create_cluster — private cluster note mentions get_cluster_invite", async () => {
	const { getState } = fakeState();
	const tool = toolByName(createMeshTools(getState), "create_cluster");
	const result = await tool.execute({ name: "Friends trip", visibility: "private" });
	assert.match(result.note, /get_cluster_invite/);
});

test("get_cluster_invite / reveal_admin_token / delete_cluster / discover_clusters delegate correctly", async () => {
	const { getState, calls } = fakeState();
	const tools = createMeshTools(getState);
	const invite = await toolByName(tools, "get_cluster_invite").execute({ cluster_id: "c_1" });
	assert.equal(invite.token, "ck_x");
	const admin = await toolByName(tools, "reveal_admin_token").execute({ cluster_id: "c_1" });
	assert.equal(admin.admin_token, "ak_x");
	const del = await toolByName(tools, "delete_cluster").execute({ cluster_id: "c_1" });
	assert.equal(del.ok, true);
	const discovered = await toolByName(tools, "discover_clusters").execute({});
	assert.deepEqual(discovered.clusters, []);
	assert.deepEqual(
		calls.map((c) => c[0]),
		["getClusterInvite", "revealAdminToken", "deleteOwnCluster", "discoverClusters"]
	);
});

test("watch_interest adds an interest and, with cluster_id+board, watches it", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "watch_interest");
	const result = await tool.execute({
		natural_language: "Honda Civic 2017+ under 10k€",
		cluster_id: "c_cars",
		board: "buysell"
	});
	assert.equal(result.interest_id, "int_1");
	assert.deepEqual(calls, [
		["addInterest", "Honda Civic 2017+ under 10k€"],
		["watchBoard", "int_1", "c_cars", "buysell"]
	]);
});

test("watch_interest without cluster_id/board only adds the interest, no watch", async () => {
	const { getState, calls } = fakeState();
	const tool = toolByName(createMeshTools(getState), "watch_interest");
	await tool.execute({ natural_language: "karting events nearby" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], "addInterest");
});

test("every tool waits on ready before touching state", async () => {
	let resolveReady;
	const ready = new Promise((r) => {
		resolveReady = r;
	});
	let readyAwaited = false;
	const getState = () => ({
		runtime: {
			discoverClusters: async () => {
				assert.equal(readyAwaited, true, "discoverClusters ran before ready resolved");
				return { clusters: [] };
			}
		},
		memory: {},
		ready
	});
	const tool = toolByName(createMeshTools(getState), "discover_clusters");
	const pending = tool.execute({});
	readyAwaited = true;
	resolveReady();
	await pending;
});
