/**
 * pi-websocket: stream every pi session event to WebSocket clients in real time.
 *
 * - Passive by design: hooks into the extension event bus only. The model never
 *   decides what gets sent, and broadcasting costs zero context tokens.
 * - Two granularities per client: message-level (default) and token-level
 *   ("stream") deltas computed from message_update events.
 * - New connections receive a hello + current theme + history replay of the
 *   active session branch, then live events.
 * - Bidirectional: clients may inject user messages via pi.sendUserMessage().
 * - Auth reuses the control panel's login stack (email + OTP + session cookie,
 *   IP blacklist / LAN soft-block) — see extensions/auth.ts. The WebSocket and
 *   the page are both gated; only the login endpoints are public.
 *
 * Load locally without touching ~/.pi:
 *   pi --extension <this-dir>          (or: pi install --local <this-dir>)
 *   pi --extension <this-dir> --ws-port 18100
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PiWsServer, type WsClient } from "./server";
import { getAuth, type AuthApi } from "./auth";
import { FileStore, type StoredFile } from "./files";
import { serializeMessage, serializeEntry, serializeTheme, concatAssistantBlocks, capText, type ImageResolver } from "./serialize";

const DEFAULT_PORT = 18100;
/** Fallbacks when the config file does not set `historyEntries` / `historyByteBudget`. */
const DEFAULT_HISTORY_ENTRIES = 200;
const DEFAULT_HISTORY_BYTES = 1_500_000;
/** Images above this are handed to the agent as a path instead of an inline block. */
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/** Run an optional Pi API call without letting a missing capability break the channel. */
function safeCall<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	/** Created lazily so auth load failures cannot leave a listener running. */
	let server: PiWsServer | undefined;
	let auth: AuthApi | undefined;
	/** Shared by uploads (browser -> agent) and publishing (agent -> browser). */
	let store: FileStore | undefined;
	/** sha256(base64) -> /f/<id>, so history replay can show the user's own images. */
	const imageUrls = new Map<string, string>();
	const resolveImage: ImageResolver = (b64) => {
		const url = imageUrls.get(createHash("sha256").update(b64).digest("hex"));
		return url ? { url } : undefined;
	};
	let sweepTimer: ReturnType<typeof setInterval> | undefined;

	/** Most recent extension context, set on session_start, cleared on session_shutdown. */
	let currentCtx: ExtensionContext | undefined;

	/** Length tracker for token-level deltas of the streaming assistant message. */
	let streamTextLen = 0;
	let streamThinkingLen = 0;

	function notify(ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error"): void {
		if (!ctx || !ctx.hasUI) return;
		try {
			ctx.ui.notify(message, type);
		} catch {
			// UI unavailable in this mode
		}
	}

	function currentTheme() {
		const ctx = currentCtx;
		if (!ctx) return undefined;
		try {
			return serializeTheme((ctx.ui as unknown as Record<string, unknown>).theme);
		} catch {
			return undefined;
		}
	}

	function modelInfo(ctx: ExtensionContext | undefined): Record<string, unknown> | undefined {
		const m = ctx?.model as Record<string, any> | undefined;
		if (!m) return undefined;
		return { provider: m.provider ?? m.providerId, id: m.id, name: m.name };
	}

	/** Session control a logged-in client may run. Anything else is refused. */
	const COMMAND_ACTIONS = new Set([
		"state",
		"files",
		"commands",
		"models",
		"model_set",
		"thinking_set",
		"tools_get",
		"tools_set",
		"compact",
		"reload",
		"new",
		"exec",
		"bash",
	]);

	/** Actions that replace the session need an explicit confirm from the client. */
	const CONFIRM_ACTIONS = new Set(["reload", "new"]);

	/** Pi's ThinkingLevel union; anything else is rejected instead of silently accepted. */
	const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

	function resolvePort(): number {
		const raw = pi.getFlag("ws-port");
		const source = typeof raw === "string" && raw ? raw : process.env.PI_WS_PORT ?? String(DEFAULT_PORT);
		const port = Number.parseInt(source, 10);
		if (Number.isInteger(port) && port > 0 && port < 65536) return port;
		return DEFAULT_PORT;
	}

	/** Per-client command budget; the login limiter does not cover this channel. */
	const cmdWindow = new Map<number, { n: number; resetAt: number }>();

	function commandAllowed(client: WsClient): boolean {
		const now = Date.now();
		const w = cmdWindow.get(client.id) ?? { n: 0, resetAt: now + 60_000 };
		if (now > w.resetAt) {
			w.n = 0;
			w.resetAt = now + 60_000;
		}
		w.n += 1;
		cmdWindow.set(client.id, w);
		return w.n <= (auth?.commandRatePerMin ?? 30);
	}

	function stateSnapshot(ctx: ExtensionContext): Record<string, unknown> {
		let usage: unknown = null;
		try {
			usage = ctx.getContextUsage() ?? null;
		} catch {
			/* tokens are unknown right after a compaction */
		}
		return {
			sessionId: ctx.sessionManager.getSessionId(),
			sessionName: safeCall(() => pi.getSessionName()) ?? null,
			usage,
			model: modelInfo(ctx) ?? null,
			thinking: safeCall(() => pi.getThinkingLevel()) ?? null,
			tools: safeCall(() => pi.getActiveTools()) ?? [],
			scopedModels: (ctx.scopedModels ?? [])
				.map((m) => {
					const r = m as Record<string, any>;
					return { provider: r.provider, id: r.id, name: r.name };
				}),
		};
	}

	function chatModelList(ctx: ExtensionContext): Array<Record<string, unknown>> {
		const list = (safeCall(() => ctx.modelRegistry.getModelsOfType("chat") as readonly Record<string, any>[]) ?? []) as readonly Record<string, any>[];
		return list
			.map((m) => ({
				provider: m.provider,
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: m.reasoning === true,
			}))
			.sort((a, b) => `${String(a.provider)}/${String(a.id)}`.localeCompare(`${String(b.provider)}/${String(b.id)}`));
	}

	/**
	 * Models offered in the web picker: the ones whose provider actually has
	 * credentials (getAvailableOfType), falling back to the full registry.
	 */
	async function pickableModels(ctx: ExtensionContext): Promise<{ models: Array<Record<string, unknown>>; source: string; total: number }> {
		const all = chatModelList(ctx);
		const avail = (await safeCall(() => ctx.modelRegistry.getAvailableOfType("chat") as Promise<readonly Record<string, any>[]>)) ?? [];
		const usable = (Array.isArray(avail) ? avail : [])
			.map((m) => ({
				provider: m.provider,
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: m.reasoning === true,
			}))
			.sort((a, b) => `${String(a.provider)}/${String(a.id)}`.localeCompare(`${String(b.provider)}/${String(b.id)}`));
		if (usable.length) return { models: usable.slice(0, 400), source: "available", total: usable.length };
		return { models: all.slice(0, 400), source: "all", total: all.length };
	}

	function findModel(ctx: ExtensionContext, want: string): Record<string, any> | undefined {
		const all = (safeCall(() => ctx.modelRegistry.getModelsOfType("chat") as readonly Record<string, any>[]) ?? []) as readonly Record<string, any>[];
		const key = want.toLowerCase();
		return all.find((m) => `${String(m.provider)}/${String(m.id)}`.toLowerCase() === key) ?? all.find((m) => String(m.id).toLowerCase() === key);
	}

	/**
	 * The command channel: a logged-in client asks to control the session.
	 * Everything is whitelisted, rate limited, and audited to stdout.
	 */
	async function handleCommand(s: PiWsServer, client: WsClient, data: Record<string, any>): Promise<void> {
		const action = String(data.action ?? "");
		const arg = typeof data.arg === "string" ? data.arg : "";
		const id = data.id;
		const reply = (ok: boolean, extra: Record<string, unknown> = {}): void => {
			s.send(client, "command_result", { id, action, ok, ...extra });
		};

		if (!COMMAND_ACTIONS.has(action)) {
			console.warn(`[pi-websocket] cmd_denied email=${client.email ?? "?"} action=${capText(action, 40)}`);
			return reply(false, { error: `action 不在白名单: ${action}` });
		}
		if (!commandAllowed(client)) {
			console.warn(`[pi-websocket] cmd_rate_limited email=${client.email ?? "?"} action=${action}`);
			return reply(false, { error: "命令过于频繁，请稍后再试" });
		}
		const ctx = currentCtx;
		if (!ctx) return reply(false, { error: "会话上下文不可用（可能正在重载）" });
		if (CONFIRM_ACTIONS.has(action) && data.confirm !== true) {
			return reply(false, { error: `${action} 会替换当前会话，需要 confirm: true` });
		}
		console.log(`[pi-websocket] cmd email=${client.email ?? "?"} action=${action}${arg ? ` arg=${capText(arg, 80)}` : ""}`);

		try {
			switch (action) {
				case "state":
					s.send(client, "state", { state: stateSnapshot(ctx) });
					return reply(true);
				case "commands":
					s.send(client, "commands", {
						commands:
							safeCall(() =>
								pi
									.getCommands()
									.map((c) => {
										const r = c as Record<string, any>;
										return { name: r.name, description: r.description ?? "", source: r.source ?? "" };
									}),
						) ?? [],
					});
					return reply(true);
				case "models": {
					const picked = await pickableModels(ctx);
					s.send(client, "models", { models: picked.models, source: picked.source, total: picked.total });
					return reply(true, { count: picked.models.length, source: picked.source, total: picked.total });
				}
				case "model_set": {
					const want = arg.trim().toLowerCase();
					if (!want) return reply(false, { error: "model_set 需要 provider/id 或 id" });
					const raw = findModel(ctx, want);
					if (!raw) return reply(false, { error: `找不到模型: ${arg}` });
					const ok = await pi.setModel(raw as never);
					return reply(ok, ok ? { model: { provider: raw.provider, id: raw.id, name: raw.name } } : { error: "该模型的 provider 没有可用凭据" });
				}
				case "thinking_set": {
					const level = arg.trim().toLowerCase();
					if (!THINKING_LEVELS.includes(level)) return reply(false, { error: `thinking_set 只接受: ${THINKING_LEVELS.join("|")}` });
					pi.setThinkingLevel(level as never);
					return reply(true, { thinking: safeCall(() => pi.getThinkingLevel()) ?? level });
				}
				case "tools_get":
					return reply(true, {
						tools: safeCall(() => pi.getActiveTools()) ?? [],
						all: (safeCall(() => pi.getAllTools().map((t) => (t as Record<string, any>).name)) ?? []).filter(Boolean),
					});
				case "tools_set": {
					const names = arg
						.split(",")
						.map((x) => x.trim())
						.filter(Boolean);
					if (!names.length) return reply(false, { error: "tools_set 需要逗号分隔的工具名" });
					pi.setActiveTools(names);
					return reply(true, { tools: safeCall(() => pi.getActiveTools()) ?? names });
				}
				case "compact": {
					ctx.compact({
						customInstructions: arg.trim() ? arg.trim() : undefined,
						onComplete: (r) => console.log(`[pi-websocket] compact done summaryChars=${(r as Record<string, any>)?.summary?.length ?? 0}`),
						onError: (e) => console.warn(`[pi-websocket] compact failed: ${e instanceof Error ? e.message : String(e)}`),
					});
					return reply(true, { started: true });
				}
				case "reload":
				case "new": {
					// ctx.reload() / ctx.newSession() only exist on a command context, so
					// dispatch our own extension command and run it there.
					pi.sendUserMessage(`/piws ${action}`, { expandPromptTemplates: true });
					return reply(true, { dispatched: action });
				}
				case "files": {
					const st = ensureStore();
					const list = (st?.list() ?? []).map((f) => ({
						id: f.id,
						name: f.name,
						mime: f.mime,
						size: f.size,
						kind: f.kind,
						dir: f.dir,
						url: `/f/${f.id}`,
					}));
					s.send(client, "files", { files: list, stats: st?.stats() ?? null });
					return reply(true, { count: list.length });
				}
				case "exec":
				case "bash": {
					const allow = auth?.allowExec ?? [];
					if (!allow.length) return reply(false, { error: "exec 未开启（在配置文件里加 allowExec 白名单）" });
					const parts = arg.trim().split(/\s+/).filter(Boolean);
					const bin = parts[0];
					if (!bin || !allow.includes(bin)) return reply(false, { error: `exec 只允许: ${allow.join(", ")}` });
					const r = await pi.exec(bin, parts.slice(1), { timeout: 15_000, cwd: ctx.cwd });
					return reply(true, { code: r.code, killed: r.killed, stdout: capText(r.stdout, 8000), stderr: capText(r.stderr, 2000) });
				}
				default:
					return reply(false, { error: `unhandled action: ${action}` });
			}
		} catch (err) {
			return reply(false, { error: err instanceof Error ? err.message : String(err) });
		}
	}

	/** Lazily create the shared file store once auth/config is known. */
	function ensureStore(): FileStore | undefined {
		const pol = auth?.files;
		if (!pol) return undefined;
		if (!store) {
			const dir = pol.dir || join(homedir(), ".pi", "pi-websocket-files");
			store = new FileStore({
				dir,
				ttlSec: pol.ttlSec,
				maxUploadBytes: pol.maxUploadBytes,
				maxPublishBytes: pol.maxPublishBytes,
				maxFiles: pol.maxFiles,
				maxStoreBytes: pol.maxStoreBytes,
			});
		}
		return store;
	}

	/** Publish a local file to the browser (send_image_to_web / send_file_to_web). */
	function publishFile(filePath: unknown, fileName: unknown, wantImage: boolean): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
		const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
		const pol = auth?.files;
		if (!pol?.allowPublish) return text("❌ 网页端文件发布已关闭（配置 allowPublish: false）");
		const st = ensureStore();
		if (!st) return text("❌ 文件存储不可用（鉴权未就绪）");
		const ctx = currentCtx;
		const roots = [ctx?.cwd ?? process.cwd(), ...(pol.publishRoots ?? [])];
		const r = st.publishFrom(filePath, roots, fileName);
		if (!r.ok) return text(`❌ ${r.error}`);
		const f = r.file;
		if (wantImage && f.kind !== "image") return text(`❌ 这不是图片（${f.mime}），请用 send_file_to_web`);
		server?.broadcast("file_ready", {
			id: f.id,
			name: f.name,
			mime: f.mime,
			size: f.size,
			kind: f.kind,
			url: `/f/${f.id}`,
			inline: f.kind === "image",
		});
		console.log(`[pi-websocket] published name=${f.name} bytes=${f.size} kind=${f.kind} url=/f/${f.id}`);
		return text(`✅ 已发布到网页端：${f.name}（${(f.size / 1024).toFixed(1)} KB）→ http://localhost:${server?.port ?? 0}/f/${f.id}`);
	}

	// --------------------------------------------------------------------------
	// Server wiring (hello + history replay, client messages)
	// --------------------------------------------------------------------------

	function wireServer(s: PiWsServer): void {
		s.onClientConnect = (client: WsClient) => {
			const ctx = currentCtx;
			s.send(client, "hello", {
				sessionId: ctx?.sessionManager.getSessionId(),
				sessionFile: ctx?.sessionManager.getSessionFile(),
				cwd: ctx?.cwd,
				model: modelInfo(ctx),
				theme: currentTheme(),
				email: client.email,
				authRequired: auth?.required ?? false,
			});

			if (ctx) {
				try {
					const branch = ctx.sessionManager.getBranch();
					const policy = auth?.history ?? { entries: DEFAULT_HISTORY_ENTRIES, byteBudget: DEFAULT_HISTORY_BYTES };
					const cap = policy.entries > 0 ? policy.entries : DEFAULT_HISTORY_ENTRIES;
					const budget = policy.byteBudget > 0 ? policy.byteBudget : DEFAULT_HISTORY_BYTES;
					const sliced = branch.length > cap ? branch.slice(-cap) : branch;
					const built = sliced.map((e) => serializeEntry(e, resolveImage)).filter((e) => e !== null);
					// Trim from the oldest end until the payload fits the byte budget, so a
					// reconnect can never hand the browser an unbounded blob of tool output.
					let entries = built;
					let bytes = 0;
					let droppedByBytes = 0;
					for (let i = built.length - 1; i >= 0; i--) {
						bytes += JSON.stringify(built[i]).length;
						if (bytes > budget) {
							droppedByBytes = i + 1;
							entries = built.slice(i + 1);
							break;
						}
					}
					// A single oversized entry (e.g. one huge tool result) must not blank the
					// screen: always keep the newest entry even if it alone exceeds budget.
					if (entries.length === 0 && built.length > 0) {
						entries = built.slice(-1);
						droppedByBytes = Math.max(0, built.length - 1);
					}
					s.send(client, "history", {
						entries,
						total: branch.length,
						truncated: branch.length > sliced.length || droppedByBytes > 0,
					});
				} catch (err) {
					s.send(client, "error", { error: `history replay failed: ${err instanceof Error ? err.message : String(err)}` });
				}
			}
			s.send(client, "history_end", {});
		};

		s.onClientMessage = (client: WsClient, data: Record<string, any>) => {
			switch (data.type) {
				case "subscribe": {
					client.stream = data.stream === true;
					s.send(client, "subscribed", { stream: client.stream });
					break;
				}
				case "user_message": {
					const text = typeof data.text === "string" ? data.text : "";
					const ids = Array.isArray(data.attachments) ? data.attachments.slice(0, 8).map((x) => String(x)) : [];
					const picked: StoredFile[] = [];
					for (const id of ids) {
						const f = store?.get(id);
						if (f && !f.consumed) picked.push(f);
					}
					if (!text.trim() && !picked.length) {
						s.send(client, "error", { error: "user_message.text is empty" });
						break;
					}
					const deliverAs = data.deliverAs === "followUp" ? "followUp" : "steer";
					const expand = data.expandPromptTemplates === true ? true : undefined;
					if (!picked.length) {
						pi.sendUserMessage(text, { deliverAs, expandPromptTemplates: expand });
					} else {
						const content: Array<Record<string, unknown>> = [];
						const notes: string[] = [];
						for (const f of picked) {
							if (f.kind === "image" && f.size <= MAX_INLINE_IMAGE_BYTES) {
								try {
									const b64 = readFileSync(f.path).toString("base64");
					content.push({ type: "image", data: b64, mimeType: f.mime });
					imageUrls.set(createHash("sha256").update(b64).digest("hex"), `/f/${f.id}`);
					if (imageUrls.size > 200) imageUrls.delete(imageUrls.keys().next().value as string);
								} catch (err) {
									notes.push(`[附件读取失败] ${f.name}: ${err instanceof Error ? err.message : String(err)}`);
								}
							} else if (f.kind === "image") {
								notes.push(`[图片过大未内联] ${f.name} (${f.size} B) 已保存到 ${f.path}`);
							} else {
								notes.push(`[附件] ${f.name} (${f.mime}, ${f.size} B) 已保存到 ${f.path}`);
							}
						}
						const body = [text.trim(), ...notes].filter(Boolean).join("\n\n");
						if (body) content.push({ type: "text", text: body });
						pi.sendUserMessage(content as never, { deliverAs, expandPromptTemplates: expand });
						for (const f of picked) store?.markConsumed(f.id);
						console.log(
							`[pi-websocket] attachments -> agent email=${client.email ?? "?"} n=${picked.length} names=${picked.map((f) => capText(f.name, 40)).join(",")}`,
						);
					}
					s.send(client, "ack", { for: "user_message", deliverAs, attachments: picked.length });
					break;
				}
				case "ping": {
					s.send(client, "pong", { id: data.id });
					break;
				}
				case "get_theme": {
					const theme = currentTheme();
					if (theme) s.send(client, "theme", { theme });
					else s.send(client, "error", { error: "theme unavailable" });
					break;
				}
				case "command": {
					void handleCommand(s, client, data);
					break;
				}
				default:
					s.send(client, "error", { error: `unknown message type: ${String(data.type)}` });
			}
		};
	}

	/**
	 * Create the server (loading the panel auth first) and listen.
	 * Fail-closed: when auth cannot be loaded the listener never starts.
	 */
	async function ensureStarted(ctx: ExtensionContext | undefined): Promise<void> {
		console.log(`[pi-websocket] ensureStarted tag=${BUILD_TAG} pid=${process.pid} hadServer=${server ? 1 : 0} running=${server?.running ? 1 : 0}`);
		if (server?.running) return;

		if (!server) {
			try {
				auth = await getAuth();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[pi-websocket] refusing to start: ${msg}`);
				notify(ctx, `pi-websocket: 未启动（鉴权不可用）— ${msg}`, "error");
				return;
			}
			if (auth.openAccess) {
				const warn = "pi-websocket: auth is DISABLED (PI_WS_AUTH=off) — anyone who can reach the port can drive this session";
				console.warn(`[pi-websocket] ${warn}`);
				notify(ctx, warn, "warning");
			}
			server = new PiWsServer(auth);
			wireServer(server);
			const st = ensureStore();
			if (st && auth) {
				server.enableFiles(st, {
					allowUpload: auth.files.allowUpload,
					maxUploadBytes: auth.files.maxUploadBytes,
					uploadRatePerMin: auth.files.uploadRatePerMin,
				});
			}
			if (!sweepTimer) {
				sweepTimer = setInterval(() => {
					const n = store?.sweep() ?? 0;
					if (n) console.log(`[pi-websocket] 清理过期文件 ${n} 个`);
				}, 10 * 60 * 1000);
				sweepTimer.unref?.();
			}
		}

		const port = resolvePort();
		// A web-triggered /reload can race the previous listener closing, so retry briefly.
		let lastErr: unknown;
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				await server.start(port);
				lastErr = undefined;
				break;
			} catch (err) {
				lastErr = err;
				await new Promise((r) => setTimeout(r, 400));
			}
		}
		if (lastErr === undefined) {
			console.log(`[pi-websocket] listening tag=${BUILD_TAG} pid=${process.pid} port=${server.port} auth=${auth?.required ? "on" : "off"}`);
			notify(
				ctx,
				`pi-websocket: listening on http://localhost:${server.port}${auth?.required ? ` (auth: 配置文件 ${auth.configPath})` : " (NO AUTH)"}`,
				auth?.required ? "info" : "warning",
			);
		} else {
			console.error(`[pi-websocket] listen failed tag=${BUILD_TAG} pid=${process.pid} port=${port} err=${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
			notify(ctx, `pi-websocket: failed to listen on port ${port} (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`, "error");
		}
	}

	// --------------------------------------------------------------------------
	// Flag & commands
	// --------------------------------------------------------------------------

	pi.registerFlag("ws-port", {
		type: "string",
		description: `pi-websocket listen port (default ${DEFAULT_PORT}; env PI_WS_PORT also honored)`,
	});

	pi.registerTool({
		name: "send_image_to_web",
		label: "Send Image to Web",
		description:
			"发送项目目录中的图片到网页端（pi-websocket 客户端），登录浏览器里会内联显示。用于把 AI 生成的图表/截图直接给用户看。",
		promptSnippet: "发送图片到网页对话（内联预览）",
		promptGuidelines: [
			"需要用户在网页上看到图片时，先生成图片文件再用 send_image_to_web。",
			"只能发送会话工作目录（或配置 publishRoots）内的文件。",
			"发送失败不要重试超过 1 次。",
		],
		parameters: Type.Object({
			imagePath: Type.String({ description: "图片路径（会话工作目录内的绝对或相对路径，png/jpg/gif/webp）" }),
			fileName: Type.Optional(Type.String({ description: "网页上显示的文件名（可选）" })),
		}),
		async execute(_toolCallId: string, params: { imagePath: string; fileName?: string }) {
			return publishFile(params.imagePath, params.fileName, true);
		},
	});

	pi.registerTool({
		name: "send_file_to_web",
		label: "Send File to Web",
		description: "发送项目目录中的文件到网页端，浏览器里得到下载链接。用于把报告/代码/视频等产物交给用户。",
		promptSnippet: "发送文件到网页对话（下载链接）",
		promptGuidelines: [
			"需要用户拿到文件时，先写入文件再用 send_file_to_web。",
			"只能发送会话工作目录（或配置 publishRoots）内的文件。",
			"发送失败不要重试超过 1 次。",
		],
		parameters: Type.Object({
			filePath: Type.String({ description: "要发送的文件路径（会话工作目录内的绝对或相对路径）" }),
			fileName: Type.Optional(Type.String({ description: "下载时显示的文件名（可选）" })),
		}),
		async execute(_toolCallId: string, params: { filePath: string; fileName?: string }) {
			return publishFile(params.filePath, params.fileName, false);
		},
	});

	pi.registerCommand("ws", {
		description: "Show pi-websocket server status",
		handler: async (_args, ctx) => {
			if (!server?.running) {
				notify(ctx, `pi-websocket: not running (use /ws-start)`, "warning");
				return;
			}
			const clients = server
				.clientList()
				.map((c) => `#${c.id}${c.stream ? "+stream" : ""}${c.email ? ` (${c.email})` : ""}`)
				.join(", ");
			const authInfo = auth?.required ? `auth: 配置文件 ${auth.configPath}` : "auth: OFF";
			notify(
				ctx,
				`pi-websocket: http://localhost:${server.port} | ${authInfo} | clients: ${server.clientCount}${clients ? ` (${clients})` : ""}` +
					(store ? ` | 文件: ${store.stats().count} 个 ${(store.stats().bytes / 1024 / 1024).toFixed(1)} MB @ ${store.stats().dir}` : ""),
				auth?.required ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("ws-start", {
		description: "Start the pi-websocket server now (also starts automatically on session start)",
		handler: async (_args, ctx) => {
			currentCtx = currentCtx ?? ctx;
			if (server?.running) {
				notify(ctx, `pi-websocket: already running on port ${server.port}`, "info");
				return;
			}
			await ensureStarted(ctx);
		},
	});

	pi.registerCommand("ws-stop", {
		description: "Stop the pi-websocket server",
		handler: async (_args, ctx) => {
			await server?.stop();
			notify(ctx, "pi-websocket: stopped", "info");
		},
	});

	/**
	 * Internal command used by the web command channel: reload / new need the
	 * ExtensionCommandContext (only command handlers get one).
	 */
	pi.registerCommand("piws", {
		description: "pi-websocket 内部命令（网页端派发）：reload | new",
		handler: async (args, ctx) => {
			const action = String(args ?? "").trim();
			if (action === "reload") {
				server?.broadcast("command_result", { action: "reload", ok: true, note: "正在重载扩展/技能/提示/主题/上下文文件" });
				await ctx.reload();
				return;
			}
			if (action === "new") {
				server?.broadcast("command_result", { action: "new", ok: true, note: "正在开启新会话" });
				const r = await ctx.newSession();
				server?.broadcast("command_result", { action: "new", ok: !r.cancelled, cancelled: r.cancelled === true });
				return;
			}
			notify(ctx, `pi-websocket: /piws 未知动作 "${action}"`, "warning");
		},
	});

	// --------------------------------------------------------------------------
	// Lifecycle: start/stop the server with the session
	// --------------------------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		await ensureStarted(ctx);
		if (!server?.running) return;
		server.broadcast("session_start", {
			reason: event.reason,
			sessionId: ctx.sessionManager.getSessionId(),
			model: modelInfo(ctx),
		});
		const theme = currentTheme();
		if (theme) server.broadcast("theme", { theme });
	});

	pi.on("session_shutdown", async (event) => {
		console.log(`[pi-websocket] session_shutdown tag=${BUILD_TAG} pid=${process.pid} reason=${(event as any)?.reason ?? "?"} wasRunning=${server?.running ? 1 : 0}`);
		currentCtx = undefined;
		if (sweepTimer) {
			clearInterval(sweepTimer);
			sweepTimer = undefined;
		}
		await server?.stop();
	});

	pi.on("session_info_changed", async (event) => {
		server?.broadcast("session_info_changed", { name: event.name });
	});

	// --------------------------------------------------------------------------
	// Agent & turn lifecycle
	// --------------------------------------------------------------------------

	pi.on("agent_start", async () => {
		server?.broadcast("agent_start", {});
	});

	pi.on("agent_end", async () => {
		server?.broadcast("agent_end", {});
	});

	pi.on("agent_settled", async (event) => {
		server?.broadcast("agent_settled", { aborted: event.aborted });
	});

	pi.on("turn_start", async (event) => {
		server?.broadcast("turn_start", { turnIndex: event.turnIndex, timestamp: event.timestamp });
	});

	pi.on("turn_end", async (event) => {
		server?.broadcast("turn_end", { turnIndex: event.turnIndex, messageEntryId: event.messageEntryId });
	});

	// --------------------------------------------------------------------------
	// Messages: message-level (everyone) + token-level deltas (stream subscribers)
	// --------------------------------------------------------------------------

	pi.on("message_start", async (event) => {
		if (event.message && (event.message as Record<string, any>).role === "assistant") {
			streamTextLen = 0;
			streamThinkingLen = 0;
		}
		const message = serializeMessage(event.message, resolveImage);
		if (message) server?.broadcast("message_start", { message });
	});

	pi.on("message_update", async (event) => {
		const role = (event.message as Record<string, any> | undefined)?.role;
		if (role !== "assistant") return;
		const text = concatAssistantBlocks(event.message, "text");
		const thinking = concatAssistantBlocks(event.message, "thinking");
		const textDelta = text.length >= streamTextLen ? text.slice(streamTextLen) : "";
		const thinkingDelta = thinking.length >= streamThinkingLen ? thinking.slice(streamThinkingLen) : "";
		streamTextLen = Math.max(streamTextLen, text.length);
		streamThinkingLen = Math.max(streamThinkingLen, thinking.length);
		if (textDelta || thinkingDelta) {
			server?.broadcastStream("stream", { textDelta, thinkingDelta });
		}
	});

	pi.on("message_end", async (event) => {
		const role = (event.message as Record<string, any> | undefined)?.role;
		if (role === "assistant") {
			streamTextLen = 0;
			streamThinkingLen = 0;
		}
		const message = serializeMessage(event.message, resolveImage);
		if (message) server?.broadcast("message_end", { message });
	});

	// --------------------------------------------------------------------------
	// Raw user input (fires for interactive, rpc, and extension-injected input)
	// --------------------------------------------------------------------------

	pi.on("input", async (event) => {
		server?.broadcast("input", {
			text: capText(event.text),
			source: event.source,
			streamingBehavior: event.streamingBehavior,
		});
	});

	// --------------------------------------------------------------------------
	// Tools
	// --------------------------------------------------------------------------

	pi.on("tool_call", async (event) => {
		server?.broadcast("tool_call", {
			toolCallId: event.toolCallId,
			parentToolCallId: event.parentToolCallId,
			toolName: event.toolName,
			input: sanitizeInput(event.input),
		});
	});

	pi.on("tool_execution_start", async (event) => {
		server?.broadcast("tool_execution_start", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			parentToolCallId: event.parentToolCallId,
		});
	});

	// 诊断标记：旧代码里没有这个字符串。终端里出现带 tag 的行就说明扩展真的重新导入了；
	// 不出现就说明还是同一个旧实例在服务（改 TS 要靠重启 pi，见运维报告 20261102）。
	const BUILD_TAG = "20261102-revert1";
	pi.on("tool_execution_update", async (event) => {
		// Partial tool output only goes to stream subscribers (can be noisy).
		// 2026-11-02 试过给全体客户端送尾部文本，用户要求回撤 ⇒ 恢复只发 id+名字、只发流式订阅者。
		server?.broadcastStream("tool_execution_update", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
		});
	});

	pi.on("tool_execution_end", async (event) => {
		server?.broadcast("tool_execution_end", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
			durationMs: event.durationMs,
			parentToolCallId: event.parentToolCallId,
		});
	});

	pi.on("tool_result", async (event) => {
		server?.broadcast("tool_result", {
			toolCallId: event.toolCallId,
			parentToolCallId: event.parentToolCallId,
			toolName: event.toolName,
			isError: event.isError,
			content: sanitizeContent(event.content),
		});
	});

	pi.on("model_select", async (event) => {
		const m = event.model as Record<string, any> | undefined;
		server?.broadcast("model_select", {
			model: m ? { provider: m.provider ?? m.providerId, id: m.id, name: m.name } : undefined,
			source: event.source,
		});
	});

	pi.on("thinking_level_select", async (event) => {
		server?.broadcast("thinking_level_select", { level: (event as Record<string, any>).level });
	});

	pi.on("session_compact", async (event) => {
		const e = event as Record<string, any>;
		const c = (e.compactionEntry ?? {}) as Record<string, any>;
		server?.broadcast("session_compact", {
			reason: e.reason ?? "",
			tokensBefore: c.tokensBefore,
			summaryChars: typeof c.summary === "string" ? c.summary.length : undefined,
			fromExtension: e.fromExtension === true,
		});
	});

	pi.on("session_compact_failed", async (event) => {
		const e = event as Record<string, any>;
		server?.broadcast("session_compact_failed", {
			reason: e.reason ?? "",
			errorMessage: e.errorMessage ?? "",
			aborted: e.aborted === true,
		});
	});
}

/** Cap tool call input for the wire. */
function sanitizeInput(input: unknown): unknown {
	try {
		const s = JSON.stringify(input ?? {});
		if (typeof s === "string" && s.length <= 32_000) return JSON.parse(s);
		return { note: "input omitted (too large)", size: s.length };
	} catch {
		return { note: "input not serializable" };
	}
}

/** Cap tool result content blocks for the wire. */
function sanitizeContent(content: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(content)) return [];
	const out: Array<Record<string, unknown>> = [];
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const b = raw as Record<string, any>;
		if (b.type === "text" && typeof b.text === "string") {
			const text = b.text.length > 100_000 ? `${b.text.slice(0, 100_000)}\n…[truncated by pi-websocket]` : b.text;
			out.push({ type: "text", text, ...(b.text.length > 100_000 ? { truncated: true } : {}) });
		} else if (b.type === "image" && typeof b.data === "string") {
			out.push({ type: "image", mimeType: b.mimeType ?? "image/png", bytes: b.data.length });
		}
	}
	return out;
}
