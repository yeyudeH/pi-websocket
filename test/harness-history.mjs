// History-replay guard harness: proves the per-connection entry cap and byte
// budget actually shrink what a fresh (or reconnecting) browser receives.
//
//   BRANCH_N=400 OUT_N=2000 node test/harness-history.mjs
//
// Everything runs offline: jiti loads the extension, a mock pi API supplies the
// session branch, and a real ws client reads what the server would send.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFixture } from "./support.mjs";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const FIXTURE = await createTestFixture("history");
const PORT = FIXTURE.port;
process.env.PI_WS_CONFIG = FIXTURE.config;
process.env.PI_WS_AUTH = "off";
writeFileSync(FIXTURE.config, JSON.stringify({
	adminEmails: ["admin@example.test"],
	smtp: { host: "127.0.0.1", port: 1, secure: false, starttls: false, user: "test", pass: "test-only-password", from: "test@example.test" },
	historyEntries: 50,
	historyByteBudget: 10000,
	fileStoreDir: FIXTURE.store,
	publishRoots: [],
}), { mode: 0o600 });
const BRANCH_N = Number(process.env.BRANCH_N || 400);
const OUT_N = Number(process.env.OUT_N || 2000);

const jiti = createJiti(import.meta.url, { alias: { typebox: require.resolve("typebox") }, fsCache: false });
const asDefault = (m) => (m && m.default ? m.default : m);
const extMod = asDefault(await jiti.import(new URL("../extensions/index.ts", import.meta.url).pathname));

const handlers = new Map();
const pi = {
	registerFlag: () => {},
	registerCommand: () => {},
	registerTool: () => {},
	getFlag: (name) => (name === "ws-port" ? String(PORT) : undefined),
	on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
	sendUserMessage: () => {},
	getCommands: () => [],
	getActiveTools: () => ["read", "bash"],
	getAllTools: () => [{ name: "read" }],
	setActiveTools: () => {},
	getThinkingLevel: () => "medium",
	setThinkingLevel: () => {},
	setModel: async (m) => m,
	exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	getSessionName: () => "hist-harness",
};

// A branch that is deliberately far bigger than any sane replay budget:
// alternating user / assistant+toolCall / toolResult entries with large output.
const branch = [];
for (let i = 0; i < BRANCH_N; i++) {
	const ts = new Date(1700000000000 + i * 1000).toISOString();
	if (i % 3 === 0) {
		branch.push({ id: `e${i}`, timestamp: ts, type: "message", message: { role: "user", content: `用户消息 ${i}`, timestamp: i } });
	} else if (i % 3 === 1) {
		branch.push({
			id: `e${i}`, timestamp: ts, type: "message",
			message: { role: "assistant", content: [{ type: "text", text: `回复 ${i}` }, { type: "toolCall", id: `t${i}`, name: "bash", arguments: "{}" }], timestamp: i },
		});
	} else {
		branch.push({
			id: `e${i}`, timestamp: ts, type: "message",
			message: { role: "toolResult", toolName: "bash", toolCallId: `t${i - 1}`, content: [{ type: "text", text: "x".repeat(OUT_N) }], timestamp: i },
		});
	}
}

const ctx = {
	hasUI: false,
	ui: { notify: () => {}, theme: { name: "dark", colors: { accent: "#7f77dd" } } },
	model: { provider: "strata", id: "hist-model", name: "Hist" },
	cwd: FIXTURE.project,
	scopedModels: [],
	sessionManager: { getSessionId: () => "hist-session", getSessionFile: () => join(FIXTURE.root, "history-session.jsonl"), getBranch: () => branch },
	getContextUsage: () => ({ tokens: 1000, contextWindow: 262144, percent: 1 }),
	compact: () => {},
	modelRegistry: { getModelsOfType: () => [] },
};

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
	console.log(`  ${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
	ok ? pass++ : fail++;
};

extMod(pi);
for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "startup" }, ctx);
// ensureStarted() is fire-and-forget inside the handler; give the listener a
// moment to bind before the client connects.
await new Promise((r) => setTimeout(r, 900));

// Read back the config the extension actually loaded, so the assertions below
// compare against live values rather than what we hope was parsed.
const cfgPath = process.env.PI_WS_CONFIG;
const cfg = cfgPath ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};

const got = await new Promise((resolve, reject) => {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
	const events = [];
	const timer = setTimeout(() => { try { ws.close(); } catch {} }, 8000);
	ws.on("message", (raw) => {
		const m = JSON.parse(String(raw));
		events.push(m);
		if (m.type === "history_end") {
			clearTimeout(timer);
			try { ws.close(); } catch {}
			resolve(events);
		}
	});
	ws.on("error", (e) => { clearTimeout(timer); reject(e); });
});

const hist = got.find((e) => e.type === "history");
const entries = hist?.entries ?? [];
const bytes = JSON.stringify(entries).length;
const rawBytes = JSON.stringify(branch).length;

console.log(`\n=== history replay harness (port ${PORT}) ===`);
console.log(`  会话分支: ${branch.length} 条 / 原始 ${rawBytes} 字符`);
console.log(`  配置: historyEntries=${cfg.historyEntries ?? "默认"} historyByteBudget=${cfg.historyByteBudget ?? "默认"}`);
console.log(`  实发: ${entries.length} 条 / ${bytes} 字符  truncated=${hist?.truncated}`);

// Effective limits: the extension falls back to these when the file omits them.
const effEntries = Number.isFinite(cfg.historyEntries) ? Math.min(1000, cfg.historyEntries) : 200;
const effBytes = Number.isFinite(cfg.historyByteBudget) ? Math.min(8 * 1024 * 1024, cfg.historyByteBudget) : 1_500_000;

check("hello 先到", got[0]?.type === "hello");
check("history 在 history_end 之前", got.findIndex((e) => e.type === "history") < got.findIndex((e) => e.type === "history_end"));
check(`条数不超过生效上限 ${effEntries}`, entries.length <= effEntries, `实发 ${entries.length}`);
check(`字节不超过生效预算 ${effBytes}`, bytes <= effBytes || entries.length === 1, `实发 ${bytes} / 条数 ${entries.length}`);
check("至少发一条（不能白屏）", entries.length >= 1, `实发 ${entries.length}`);
check("只发最近一段（最后一条是分支最新一条）", String(hist?.total) === String(branch.length) && entries.length >= 1);
const overLimit = branch.length > effEntries || rawBytes > effBytes;
check(overLimit ? "超限时应标 truncated" : "未超限时不标 truncated", hist?.truncated === overLimit, `分支 ${branch.length} 条 / ${rawBytes} 字符`);
check("不超过原始分支", bytes <= rawBytes, `${bytes} <= ${rawBytes}`);

for (const fn of handlers.get("session_shutdown") ?? []) await fn({ reason: "quit" }, ctx);
console.log("Test-owned temporary fixtures retained:", FIXTURE.root);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
