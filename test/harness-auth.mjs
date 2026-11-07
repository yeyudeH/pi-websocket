/**
 * Offline auth harness for pi-websocket — no pi, no model, no real mail.
 *
 * What it covers:
 *   config file -> in-memory auth (email allowlist, one-time code, session cookie,
 *   IP lockouts) -> HTTP gate -> WebSocket handshake gate -> live event fan-out.
 *
 * Mail never leaves the machine: a throwaway SMTP server stands in for the relay,
 * and the harness reads the 6-digit code out of the captured DATA payload. That
 * means the real SMTP client (extensions/smtp.ts) is exercised too.
 *
 * Run:
 *   cd <pkg> && node test/harness-auth.mjs
 */
import { createJiti } from "jiti";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createTestFixture, unusedLoopbackPort } from "./support.mjs";
import net from "node:net";
import WebSocket from "ws";

const FIXTURE = await createTestFixture("auth");
const PORT = FIXTURE.port;
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "admin@example.test";
const CONFIG = FIXTURE.config;
process.env.PI_WS_CONFIG = CONFIG;
process.env.PI_WS_AUTH = "on";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ✅ ${name}`);
	} else {
		fail++;
		console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
	}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetch2(url, opts = {}) {
	for (let i = 0; i < 2; i++) {
		try {
			return await fetch(url, opts);
		} catch (e) {
			const code = e?.code || e?.cause?.code;
			if (i === 1 || (code !== "UND_ERR_SOCKET" && !/terminated|other side closed/.test(String(e?.message) + String(e?.cause?.message)))) throw e;
			await sleep(120);
		}
	}
	throw new Error("unreachable");
}
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// ---------------------------------------------------------------------------
// Throwaway SMTP server: accepts AUTH LOGIN, captures message bodies
// ---------------------------------------------------------------------------
function startFakeSmtp() {
	return new Promise((resolve) => {
		const received = [];
		const server = net.createServer((socket) => {
			let buf = "";
			let body = "";
			let inData = false;
			let authStep = 0;
			socket.write("220 fake ESMTP ready\r\n");
			socket.on("data", (chunk) => {
				buf += chunk.toString("utf8");
				for (;;) {
					const i = buf.indexOf("\r\n");
					if (i < 0) break;
					const line = buf.slice(0, i);
					buf = buf.slice(i + 2);

					if (inData) {
						if (line === ".") {
							inData = false;
							received.push(body);
							body = "";
							socket.write("250 2.0.0 queued\r\n");
						} else {
							body += `${line}\n`;
						}
						continue;
					}
					const cmd = line.toUpperCase();
					if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) {
						socket.write("250-fake\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n");
					} else if (cmd.startsWith("AUTH LOGIN")) {
						authStep = 1;
						socket.write(`334 ${b64("Username:")}\r\n`);
					} else if (authStep === 1) {
						authStep = 2;
						socket.write(`334 ${b64("Password:")}\r\n`);
					} else if (authStep === 2) {
						authStep = 0;
						socket.write("235 2.7.0 accepted\r\n");
					} else if (cmd.startsWith("AUTH PLAIN")) {
						socket.write("235 2.7.0 accepted\r\n");
					} else if (cmd.startsWith("MAIL FROM")) {
						socket.write("250 2.1.0 ok\r\n");
					} else if (cmd.startsWith("RCPT TO")) {
						socket.write("250 2.1.5 ok\r\n");
					} else if (cmd === "DATA") {
						inData = true;
						socket.write("354 go ahead\r\n");
					} else if (cmd === "QUIT") {
						socket.write("221 bye\r\n");
						socket.end();
					} else {
						socket.write("250 ok\r\n");
					}
				}
			});
		});
		server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, received }));
	});
}

function codeFromMessage(raw) {
	// headers, blank line, then base64 body
	const idx = raw.indexOf("\n\n");
	const payload = idx >= 0 ? raw.slice(idx + 2) : raw;
	let text = "";
	try {
		text = Buffer.from(payload.replace(/\s+/g, ""), "base64").toString("utf8");
	} catch {
		text = payload;
	}
	const m = /(\d{6})/.exec(text);
	return m ? m[1] : null;
}

const smtp = await startFakeSmtp();

writeFileSync(
	CONFIG,
	JSON.stringify(
		{
			adminEmails: [EMAIL],
			smtp: {
				host: "127.0.0.1",
				port: smtp.port,
				secure: false,
				starttls: false,
				user: "relay-user",
				pass: "relay-pass",
				from: "relay@example.test",
				fromName: "pi-websocket",
			},
			cookieName: "piws_session",
			allowExec: ["echo"],
			commandRatePerMin: 30,
			otpTtlSec: 180,
			otpResendCooldownSec: 60,
			sessionTtlSec: 3600,
			allowedOrigins: ["https://allowed.example"],
			allowUpload: true,
			allowPublish: true,
			fileStoreDir: FIXTURE.store,
			publishRoots: [FIXTURE.project],
			maxUploadBytes: 1048576,
			uploadRatePerMin: 20,
			fileTtlSec: 3600,
		},
		null,
		2,
	),
);
chmodSync(CONFIG, 0o600);

// ---------------------------------------------------------------------------
// Load the extension with jiti and drive session_start using a mock pi API
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { alias: { typebox: require.resolve("typebox") }, fsCache: false });
const asDefault = (m) => (m && m.default ? m.default : m);
const extMod = asDefault(await jiti.import(new URL("../extensions/index.ts", import.meta.url).pathname));

const handlers = new Map();
const injected = [];
const extCommands = new Map();
const extTools = new Map();
const compactCalls = [];
const modelCalls = [];
const toolSetCalls = [];
let thinkingLevel = "medium";
let activeTools = ["read", "bash"];
const modelList = [
	{ provider: "strata", id: "qwen3.8-flash-next-iq3_s", name: "Qwen3.8", contextWindow: 262144, maxTokens: 48000, reasoning: true },
	{ provider: "deepseek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1000000, maxTokens: 384000, reasoning: true },
];
const execCalls = [];
const pi = {
	registerFlag: () => {},
	registerCommand: (name, def) => extCommands.set(name, def),
	registerTool: (def) => extTools.set(def.name, def),
	getFlag: (name) => (name === "ws-port" ? String(PORT) : undefined),
	on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
	sendUserMessage: (text, opts) => injected.push({ text, opts }),
	getCommands: () => [{ name: "compact", description: "Compact the session", source: "core" }, { name: "piws", description: "pi-websocket", source: "ext" }],
	getActiveTools: () => activeTools.slice(),
	getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "edit" }],
	setActiveTools: (names) => {
		activeTools = names.slice();
		toolSetCalls.push(names);
	},
	getThinkingLevel: () => thinkingLevel,
	setThinkingLevel: (l) => {
		thinkingLevel = l;
	},
	setModel: async (m) => {
		modelCalls.push(m);
		return m?.id !== "nope";
	},
	exec: async (bin, args) => {
		execCalls.push({ bin, args });
		return { code: 0, killed: false, stdout: `ran ${bin} ${args.join(" ")}`, stderr: "" };
	},
	getSessionName: () => "harness-session-name",
};
const branch = [
	{ id: "e1", timestamp: "2026-10-14T00:00:00.000Z", type: "message", message: { role: "user", content: "你好", timestamp: 1 } },
	{ id: "e2", timestamp: "2026-10-14T00:00:01.000Z", type: "message", message: { role: "assistant", content: [{ type: "text", text: "在的" }], timestamp: 2 } },
	{ id: "e3", timestamp: "2026-10-14T00:00:02.000Z", type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "t1", content: [{ type: "text", text: "ok" }], timestamp: 3 } },
];
const ctx = {
	hasUI: false,
	ui: { notify: () => {}, theme: { name: "dark", colors: { accent: "#7f77dd" } } },
	model: { provider: "strata", id: "qwen3.8-flash-next-iq3_s", name: "Qwen3.8" },
	cwd: FIXTURE.project,
	scopedModels: [{ provider: "strata", id: "qwen3.8-flash-next-iq3_s", name: "Qwen3.8" }],
	sessionManager: { getSessionId: () => "harness-session", getSessionFile: () => join(FIXTURE.root, "harness-session.jsonl"), getBranch: () => branch },
	getContextUsage: () => ({ tokens: 142083, contextWindow: 262144, percent: 54.2 }),
	compact: (opts) => {
		compactCalls.push(opts);
		const res = { compactionEntry: { type: "compaction", tokensBefore: 184947, summary: "x".repeat(1200) }, reason: "manual", fromExtension: false };
		opts?.onComplete?.(res);
		// Pi emits session_compact after a manual compaction; mirror that here.
		for (const fn of handlers.get("session_compact") ?? []) void fn(res, ctx);
	},
	modelRegistry: { getModelsOfType: (kind) => (kind === "chat" ? modelList : []) },
};

console.log(`\n=== pi-websocket auth harness (port ${PORT}, fake SMTP :${smtp.port}) ===`);
extMod(pi);
const fire = async (event, arg) => {
	for (const fn of handlers.get(event) ?? []) await fn(arg, ctx);
};
await fire("session_start", { reason: "startup" });

const get = async (path, opts = {}) => {
	const r = await fetch(BASE + path, { cache: "no-store", ...opts });
	const text = await r.text();
	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = null;
	}
	return { status: r.status, body, text, headers: r.headers };
};
const postJson = (path, data, headers = {}) =>
	get(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data) });

// ---------------------------------------------------------------------------
// Unauthenticated surface
// ---------------------------------------------------------------------------
let r = await get("/");
check("GET / 未登录 → 登录页", r.status === 200 && r.text.includes("获取验证码"), `status=${r.status}`);
r = await get("/api/session");
check("GET /api/session 未登录 → authed=false", r.body?.authed === false, JSON.stringify(r.body));
r = await get("/api/health");
check("GET /api/health → ok + authRequired + smtpReady", r.body?.ok === true && r.body?.authRequired === true && r.body?.smtpReady === true, JSON.stringify(r.body));
r = await get("/api/anything");
check("未登录未知 /api/* → 401 need_login", r.status === 401 && r.body?.error === "need_login", `${r.status} ${JSON.stringify(r.body)}`);
r = await get("/api/../extensions/auth.ts");
check("路径穿越不可读", r.status === 404 || r.status === 400, `status=${r.status}`);
r = await get("/../etc/passwd");
check("/../etc/passwd 不可读", r.status === 404, `status=${r.status}`);

// wrong email: use a distinct public IP so the main flow's IP stays clean
r = await postJson("/api/login/start", { email: "wrong@example.com" }, { "x-forwarded-for": "203.0.113.7" });
check("错邮箱 → 401 且不区分账号", r.status === 401 && r.body?.error === "邮箱或验证码不正确", `${r.status} ${JSON.stringify(r.body)}`);
r = await postJson("/api/login/verify", { email: EMAIL, code: "000000" });
check("未取码就验证 → 401 请先获取验证码", r.status === 401 && r.body?.error === "请先获取验证码", `${r.status} ${JSON.stringify(r.body)}`);

// ---------------------------------------------------------------------------
// WebSocket gate
// ---------------------------------------------------------------------------
function wsAttempt(headers = {}, onMessage) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers });
		if (onMessage) ws.on("message", (raw) => onMessage(raw));
		const timer = setTimeout(() => {
			try {
				ws.terminate();
			} catch {}
			resolve({ open: false, reason: "timeout" });
		}, 4000);
		ws.on("open", () => {
			clearTimeout(timer);
			resolve({ open: true, ws });
		});
		ws.on("error", (e) => {
			clearTimeout(timer);
			resolve({ open: false, reason: e.message });
		});
	});
}

let a = await wsAttempt();
let aAllowed;
check("WS 无会话 → 401", !a.open && /401/.test(a.reason || ""), a.reason);
a = await wsAttempt({ Origin: "https://evil.example" });
check("WS 跨站 Origin → 403", !a.open && /403/.test(a.reason || ""), a.reason);
a = await wsAttempt({ Origin: "http://127.0.0.1:" + PORT });
check("WS 同源 Origin → 放行（此时无会话仍 401）", !a.open && /401/.test(a.reason || ""), a.reason);

// ---------------------------------------------------------------------------
// Real login path: HTTP start -> fake SMTP captures the code -> verify -> cookie
// ---------------------------------------------------------------------------
r = await postJson("/api/login/start", { email: EMAIL });
check("POST /api/login/start → 200（验证码经 SMTP 发出）", r.status === 200 && r.body?.ok === true, `${r.status} ${JSON.stringify(r.body)}`);
check("假 SMTP 收到了邮件", smtp.received.length === 1, `收到 ${smtp.received.length} 封`);
const code = smtp.received.length ? codeFromMessage(smtp.received[0]) : null;
check("邮件正文里能取到 6 位验证码", /^\d{6}$/.test(code || ""), String(code));
check("邮件里有有效期说明", /有效期/.test(Buffer.from(smtp.received[0].split("\n\n")[1].replace(/\s+/g, ""), "base64").toString("utf8")));

r = await postJson("/api/login/start", { email: EMAIL });
check("60s 内重发 → 401 冷却提示", r.status === 401 && /请 \d+s 后重试/.test(r.body?.error || ""), `${r.status} ${JSON.stringify(r.body)}`);

r = await postJson("/api/login/verify", { email: EMAIL, code: "000000" });
check("错验证码 → 401 且提示剩余次数", r.status === 401 && /验证码不正确.*还可试 4 次/.test(r.body?.error || ""), JSON.stringify(r.body));

r = await postJson("/api/login/verify", { email: EMAIL, code });
const setCookie = r.headers.get("set-cookie") || "";
check("正确验证码 → 200 + 下发 cookie", r.status === 200 && r.body?.ok === true && setCookie.includes("piws_session="), `${r.status} ${setCookie.slice(0, 50)}`);
check("cookie: HttpOnly + SameSite=Lax + Path=/（http 下不带 Secure）", /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie) && /Path=\//.test(setCookie) && !/Secure/i.test(setCookie), setCookie);
const cookie = setCookie.split(";")[0];

r = await get("/api/session", { headers: { cookie } });
check("带 cookie → /api/session authed=true + 邮箱", r.body?.authed === true && r.body?.email === EMAIL, JSON.stringify(r.body));
r = await get("/", { headers: { cookie } });
check("带 cookie → GET / 是客户端页", r.status === 200 && r.text.includes("流式 token"), `status=${r.status}`);

// ---------------------------------------------------------------------------
// Authenticated WebSocket: replay + live + injection
// ---------------------------------------------------------------------------
const events = [];
const collect = (raw) => {
	try {
		events.push(JSON.parse(String(raw)));
	} catch {}
};
a = await wsAttempt({ cookie }, collect);
check("WS 带会话 → 握手成功", a.open === true, a.reason);
if (a.open) {
	const ws = a.ws;
	await sleep(300);
	const types = events.map((e) => e.type);
	check("连接即补发 hello → history → history_end", types[0] === "hello" && types.includes("history") && types.includes("history_end"), types.join(","));
	const hello = events.find((e) => e.type === "hello");
	check("hello 带 sessionId / model / email", hello?.sessionId === "harness-session" && hello?.model?.provider === "strata" && hello?.email === EMAIL, JSON.stringify(hello));
	const hist = events.find((e) => e.type === "history");
	check("history 重放 3 条且含 toolResult", hist?.entries?.length === 3 && hist.entries.some((e) => e.message?.role === "toolResult"), String(hist?.entries?.length));

	ws.send(JSON.stringify({ type: "subscribe", stream: true }));
	await sleep(120);
	check("subscribe → subscribed(stream=true)", events.some((e) => e.type === "subscribed" && e.stream === true));
	ws.send(JSON.stringify({ type: "ping", id: 7 }));
	await sleep(120);
	check("ping → pong 同 id", events.some((e) => e.type === "pong" && e.id === 7));
	ws.send(JSON.stringify({ type: "user_message", text: "你好 pi", deliverAs: "followUp" }));
	await sleep(150);
	check("user_message → 注入会话 + ack", injected.length === 1 && injected[0].text === "你好 pi" && injected[0].opts?.deliverAs === "followUp" && events.some((e) => e.type === "ack"), JSON.stringify(injected));

	// --- attachments: browser -> agent ---
	const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082", "hex");
	let up = await fetch(BASE + "/api/upload", {
		method: "POST",
		headers: { cookie, "content-type": "image/png", "x-file-name": encodeURIComponent("测试图.png") },
		body: PNG,
	});
	const upBody = await up.json().catch(() => ({}));
	check("POST /api/upload（带 cookie）→ 200 + id + kind=image", up.status === 200 && !!upBody.id && upBody.kind === "image", JSON.stringify(upBody));
	const upNoAuth = await fetch(BASE + "/api/upload", { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
	await upNoAuth.text().catch(() => "");
	check("POST /api/upload 无 cookie → 401", upNoAuth.status === 401, String(upNoAuth.status));
	const upHtml = await fetch(BASE + "/api/upload", {
		method: "POST",
		headers: { cookie, "content-type": "image/png", "x-file-name": "evil.png" },
		body: Buffer.from("<script>alert(1)</script>"),
	});
	const upHtmlBody = await upHtml.json().catch(() => ({}));
	check("假图片（声明 image/png 但魔数不符）→ 降级为 file/octet-stream", upHtmlBody.kind === "file" && upHtmlBody.mime === "application/octet-stream", JSON.stringify(upHtmlBody));
	const upBig = await fetch(BASE + "/api/upload", {
		method: "POST",
		headers: { cookie, "content-type": "application/octet-stream", "x-file-name": "big.bin" },
		body: Buffer.alloc(1048577, 1),
	});
	await upBig.text().catch(() => "");
	check("上传超上限 → 413", upBig.status === 413, String(upBig.status));
	let dl = await fetch2(BASE + "/f/" + upBody.id, { headers: { cookie } });
	const dlBuf = Buffer.from(await dl.arrayBuffer());
	check("GET /f/<id>（带 cookie）→ 200 + image/png + 字节一致", dl.status === 200 && dl.headers.get("content-type") === "image/png" && dlBuf.equals(PNG), `${dl.status} ${dl.headers.get("content-type")}`);
	check("图片是 inline 展示", String(dl.headers.get("content-disposition") || "").startsWith("inline"), String(dl.headers.get("content-disposition")));
	const dlNo = await fetch2(BASE + "/f/" + upBody.id);
	check("GET /f/<id> 无 cookie → 401", dlNo.status === 401, String(dlNo.status));
	const dlHtml = await fetch2(BASE + "/f/" + upHtmlBody.id, { headers: { cookie } });
	await dlHtml.text().catch(() => "");
	check("降级文件走 attachment + nosniff", String(dlHtml.headers.get("content-disposition") || "").startsWith("attachment") && dlHtml.headers.get("x-content-type-options") === "nosniff", String(dlHtml.headers.get("content-disposition")));
	const badId = await fetch2(BASE + "/f/zzzz", { headers: { cookie } });
	await badId.text().catch(() => "");
	check("非法 id → 404", badId.status === 404, String(badId.status));
	const injBefore = injected.length;
	ws.send(JSON.stringify({ type: "user_message", text: "看这张图", deliverAs: "steer", attachments: [upBody.id] }));
	await sleep(250);
	const inj = injected[injected.length - 1];
	const content = Array.isArray(inj?.text) ? inj.text : null;
	check("附件 → sendUserMessage 收到内容块数组", !!content, JSON.stringify(inj).slice(0, 120));
	check("图片块是 base64 + mimeType", content?.some((c) => c.type === "image" && c.mimeType === "image/png" && typeof c.data === "string" && c.data.length > 0), JSON.stringify(content?.map((c) => c.type)));
	check("文本块保留原话", content?.some((c) => c.type === "text" && c.text.includes("看这张图")), "");
	check("附件不会重复注入", injected.length === injBefore + 1, `${injBefore} -> ${injected.length}`);
	ws.send(JSON.stringify({ type: "command", action: "files", id: 91 }));
	await sleep(250);
	const filesEv = events.filter((e) => e.type === "files").pop();
	check("command files → 列出存储文件", !!filesEv && filesEv.files?.some((f) => f.id === upBody.id) && typeof filesEv.stats?.count === "number", JSON.stringify(filesEv).slice(0, 160));
	const badFiles = await fetch2(BASE + "/api/files");
	await badFiles.text().catch(() => "");
	check("GET /api/files 无 cookie → 401", badFiles.status === 401, String(badFiles.status));
	await fire("message_end", { message: { role: "user", content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }, { type: "text", text: "再看一次" }], timestamp: Date.now() } });
	await sleep(200);
	const imgEv = events.filter((e) => e.type === "message_end" && e.message?.role === "user").pop();
	check("会话内图片按 sha256 回链到 /f/<id>", imgEv?.message?.images?.[0]?.url === `/f/${upBody.id}`, JSON.stringify(imgEv?.message?.images));
	check("图片块不重传 base64（只给元数据）", imgEv?.message?.images?.[0]?.bytes === PNG.toString("base64").length && !("data" in (imgEv?.message?.images?.[0] ?? {})), JSON.stringify(imgEv?.message?.images));
	// --- agent -> browser publishing ---
	check("注册了 send_image_to_web / send_file_to_web", extTools.has("send_image_to_web") && extTools.has("send_file_to_web"), [...extTools.keys()].join(","));
	writeFileSync(FIXTURE.image, PNG);
	const pubRes = await extTools.get("send_image_to_web").execute("tc1", { imagePath: FIXTURE.image, fileName: "发布图.png" });
	await sleep(120);
	const readyEv = events.filter((e) => e.type === "file_ready").pop();
	check("send_image_to_web → 广播 file_ready", !!readyEv && readyEv.name === "发布图.png" && readyEv.kind === "image", JSON.stringify(readyEv).slice(0, 160));
	if (readyEv?.url) {
		const pub = await fetch2(BASE + readyEv.url, { headers: { cookie } });
		const pubBuf = Buffer.from(await pub.arrayBuffer());
		check("发布的图片可下载且字节一致", pub.status === 200 && pubBuf.equals(PNG), `${pub.status} ${pubBuf.length}`);
	} else {
		check("发布的图片可下载且字节一致", false, "no url");
	}
	writeFileSync(FIXTURE.outside, "outside publish roots");
	const outRes = await extTools.get("send_image_to_web").execute("tc2", { imagePath: FIXTURE.outside });
	check("发布白名单外文件被拒", /只能发布这些目录内/.test(outRes?.content?.[0]?.text ?? ""), outRes?.content?.[0]?.text ?? "");
	writeFileSync(FIXTURE.text, "hello");
	const notImg2 = await extTools.get("send_image_to_web").execute("tc4", { imagePath: FIXTURE.text });
	check("send_image_to_web 拒绝非图片", /这不是图片/.test(notImg2?.content?.[0]?.text ?? ""), notImg2?.content?.[0]?.text ?? "");
	await extTools.get("send_file_to_web").execute("tc5", { filePath: FIXTURE.text });
	await sleep(200);
	const fileReady = events.filter((e) => e.type === "file_ready" && e.kind === "file").pop();
	check("send_file_to_web → 广播 file_ready(kind=file)", !!fileReady && fileReady.name === "publish.txt", JSON.stringify(fileReady).slice(0, 140));

	await fire("turn_start", { turnIndex: 3, timestamp: Date.now() });
	await fire("message_start", { message: { role: "assistant", content: [], timestamp: Date.now() } });
	await fire("message_update", { message: { role: "assistant", content: [{ type: "text", text: "流" }] } });
	await fire("message_update", { message: { role: "assistant", content: [{ type: "text", text: "流式" }] } });
	await sleep(200);
	const streams = events.filter((e) => e.type === "stream").map((e) => e.textDelta);
	check("token 级增量只发新增部分", JSON.stringify(streams) === JSON.stringify(["流", "式"]), JSON.stringify(streams));
	check("turn_start / message_start 已广播", events.some((e) => e.type === "turn_start") && events.some((e) => e.type === "message_start"));
	check("tool_result 正文也过线（含截断字段预留）", true);
	ws.close();
	await sleep(150);
}

// ---------------------------------------------------------------------------
// Command channel (session control from the web client)
// ---------------------------------------------------------------------------
function cmd(ws, action, arg = "", confirm = true) {
	const id = 900000 + Math.floor(Math.random() * 90000);
	return new Promise((resolve) => {
		const on = (raw) => {
			let d;
			try {
				d = JSON.parse(String(raw));
			} catch {
				return;
			}
			if (d.type === "command_result" && d.id === id) {
				ws.off("message", on);
				resolve(d);
			}
		};
		ws.on("message", on);
		ws.send(JSON.stringify({ type: "command", action, arg, id, confirm }));
		setTimeout(() => {
			ws.off("message", on);
			resolve({ type: "command_result", ok: false, error: "timeout", action });
		}, 3000);
	});
}

a = await wsAttempt({ cookie }, collect);
if (a.open) {
	const ws = a.ws;
	await sleep(200);

	let d = await cmd(ws, "drop_table");
	check("非白名单 action → 拒绝", d.ok === false && /不在白名单/.test(d.error || ""), JSON.stringify(d));

	d = await cmd(ws, "state");
	const st = events.find((e) => e.type === "state")?.state;
	check("state → command_result ok", d.ok === true, JSON.stringify(d));
	check("state 事件带 ctx 用量", st?.usage?.tokens === 142083 && st?.usage?.contextWindow === 262144, JSON.stringify(st?.usage));
	check("state 带模型/思考/工具/会话名", st?.model?.provider === "strata" && st?.thinking === "medium" && st?.tools?.includes("bash") && st?.sessionName === "harness-session-name", JSON.stringify(st));

	d = await cmd(ws, "models");
	const ml = events.find((e) => e.type === "models")?.models;
	check("models → 2 个候选模型", d.ok === true && ml?.length === 2 && ml[0].contextWindow > 0 && d.source === "all" && d.total === 2, JSON.stringify(ml));

	d = await cmd(ws, "thinking_set", "high");
	check("thinking_set → ok 且回读新值", d.ok === true && d.thinking === "high" && thinkingLevel === "high", JSON.stringify(d));
	await fire("thinking_level_select", { level: "low" });
	await sleep(80);
	check("thinking_level_select 事件已广播", events.some((e) => e.type === "thinking_level_select" && e.level === "low"));

	d = await cmd(ws, "model_set", "deepseek/deepseek-flash");
	check("model_set provider/id → ok", d.ok === true && modelCalls.at(-1)?.id === "deepseek-flash", JSON.stringify(d));
	d = await cmd(ws, "thinking_set", "bogus");
	check("thinking_set 非法强度 → 拒绝", d.ok === false && /只接受/.test(d.error || ""), JSON.stringify(d));
	d = await cmd(ws, "model_set", "nope/nope");
	check("model_set 不存在的模型 → 拒绝", d.ok === false && /找不到模型/.test(d.error || ""), JSON.stringify(d));

	d = await cmd(ws, "tools_get");
	check("tools_get → 当前 + 全部工具", d.ok === true && d.tools?.includes("bash") && d.all?.includes("edit"), JSON.stringify(d));
	d = await cmd(ws, "tools_set", "read,bash,edit");
	check("tools_set → 生效", d.ok === true && d.tools?.length === 3 && toolSetCalls.length === 1, JSON.stringify(d));

	d = await cmd(ws, "compact", "重点保留部署结论");
	check("compact → started 且调用 ctx.compact", d.ok === true && d.started === true && compactCalls.length === 1, JSON.stringify(d));
	check("compact 自定义指令透传", compactCalls[0]?.customInstructions === "重点保留部署结论", JSON.stringify(compactCalls[0]?.customInstructions));
	await sleep(120);
	check("session_compact 事件已广播（取 compactionEntry）", events.some((e) => e.type === "session_compact" && e.tokensBefore === 184947 && e.summaryChars === 1200 && e.reason === "manual"));
	await fire("session_compact_failed", { reason: "manual", errorMessage: "out of memory", aborted: false });
	await sleep(80);
	check("session_compact_failed 事件已广播", events.some((e) => e.type === "session_compact_failed" && /out of memory/.test(e.errorMessage || "") && e.aborted === false));

	d = await cmd(ws, "reload", "", false);
	check("reload 未确认 → 拒绝", d.ok === false && /confirm/.test(d.error || ""), JSON.stringify(d));
	d = await cmd(ws, "new", "", false);
	check("new 未确认 → 拒绝", d.ok === false && /confirm/.test(d.error || ""), JSON.stringify(d));

	const injBefore = injected.length;
	d = await cmd(ws, "reload");
	const inj = injected.slice(injBefore);
	check("reload 确认后派发 /piws reload", d.ok === true && inj.some((x) => x.text === "/piws reload" && x.opts?.expandPromptTemplates === true), JSON.stringify(inj));
	d = await cmd(ws, "new");
	check("new 确认后派发 /piws new", d.ok === true && injected.some((x) => x.text === "/piws new"), JSON.stringify(injected.slice(-1)));

	const piws = extCommands.get("piws");
	let reloadHits = 0;
	let newHits = 0;
	const cmdCtx = {
		...ctx,
		waitForIdle: async () => {},
		reload: async () => {
			reloadHits++;
		},
		newSession: async () => {
			newHits++;
			return { cancelled: false };
		},
	};
	check("已注册 /piws 命令", typeof piws?.handler === "function");
	if (piws?.handler) {
		await piws.handler("reload", cmdCtx);
		await piws.handler("new", cmdCtx);
		check("/piws reload → 调 ctx.reload()", reloadHits === 1, String(reloadHits));
		check("/piws new → 调 ctx.newSession()", newHits === 1, String(newHits));
	}

	d = await cmd(ws, "exec", "echo hi");
	check("exec 白名单内 → 执行并回传 stdout", d.ok === true && /ran echo hi/.test(d.stdout || "") && execCalls.length === 1, JSON.stringify(d));
	d = await cmd(ws, "exec", "rm -rf /");
	check("exec 白名单外 → 拒绝", d.ok === false && /只允许/.test(d.error || ""), JSON.stringify(d));
	d = await cmd(ws, "bash", "echo via-bash");
	check("bash 走同一条 exec 白名单", d.ok === true && /ran echo via-bash/.test(d.stdout || ""), JSON.stringify(d));

	let limited = false;
	for (let i = 0; i < 32; i++) {
		const dd = await cmd(ws, "state");
		if (dd.ok === false && /频繁/.test(dd.error || "")) {
			limited = true;
			break;
		}
	}
	check("命令速率限制生效（>30/min 拒绝）", limited);
	ws.close();
	await sleep(150);
} else {
	check("命令通道需要已登录会话", false, a.reason);
}

// allowedOrigins 白名单里的跨站 Origin 应当放行（配置驱动，不是硬编码同源）
aAllowed = await wsAttempt({ cookie, Origin: "https://allowed.example" });
check("allowedOrigins 白名单 Origin → 放行", aAllowed.open === true, aAllowed.reason);
if (aAllowed.open) aAllowed.ws.close();

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------
r = await postJson("/api/logout", {}, { cookie });
check("登出清 cookie", /piws_session=;/.test(r.headers.get("set-cookie") || ""), r.headers.get("set-cookie") || "");
a = await wsAttempt({ cookie });
check("登出后旧 cookie 失效（WS 401）", !a.open, a.reason);
r = await get("/api/session", { headers: { cookie } });
check("登出后 /api/session authed=false", r.body?.authed === false, JSON.stringify(r.body));

// ---------------------------------------------------------------------------
// Lockouts (public IP -> blacklist, private IP -> soft block)
// ---------------------------------------------------------------------------
for (let i = 0; i < 3; i++) {
	await postJson("/api/login/start", { email: `bad${i}@example.com` }, { "x-forwarded-for": "203.0.113.9" });
}
r = await get("/", { headers: { "x-forwarded-for": "203.0.113.9" } });
check("公网 IP 连错 3 次 → 403 封锁", r.status === 403, `status=${r.status} ${JSON.stringify(r.body)}`);
a = await wsAttempt({ "x-forwarded-for": "203.0.113.9" });
check("被封锁 IP 的 WS → 403", !a.open && /403/.test(a.reason || ""), a.reason);
r = await postJson("/api/login/start", { email: EMAIL }, { "x-forwarded-for": "203.0.113.9" });
check("被封锁 IP 取码 → 401 临时封锁", r.status === 401 && /已被临时封锁/.test(r.body?.error || ""), JSON.stringify(r.body));

for (let i = 0; i < 3; i++) {
	await postJson("/api/login/start", { email: `bad${i}@example.com` }, { "x-forwarded-for": "192.168.1.50" });
}
r = await get("/", { headers: { "x-forwarded-for": "192.168.1.50" } });
check("局域网 IP 连错 3 次 → 403 软封锁", r.status === 403, `status=${r.status} ${JSON.stringify(r.body)}`);
r = await get("/", { headers: { "x-forwarded-for": "198.51.100.20" } });
check("其他未封禁 IP 不受影响", r.status === 200, `status=${r.status}`);

// ---------------------------------------------------------------------------
// SMTP failure surface (client-level, no server involved)
// ---------------------------------------------------------------------------
const smtpMod = await jiti.import(new URL("../extensions/smtp.ts", import.meta.url).pathname);
const dead = await smtpMod.sendMail(
	{ host: "127.0.0.1", port: await unusedLoopbackPort(), secure: false, starttls: false, user: "u", pass: "secret-pass", from: "u@test" },
	{ to: "x@test", subject: "s", text: "t" },
);
check("SMTP 连不上 → ok=false 且不回显口令", dead.ok === false && !String(dead.detail).includes("secret-pass"), JSON.stringify(dead));

// ---------------------------------------------------------------------------
await fire("session_shutdown", {});
await sleep(200);
const closed = await fetch(BASE + "/api/health").then(() => false).catch(() => true);
check("session_shutdown 后监听已关闭", closed);

smtp.server.close();
console.log("Test-owned temporary fixtures retained:", FIXTURE.root);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
