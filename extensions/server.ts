/**
 * WebSocket server runtime for the pi-websocket extension.
 *
 * - HTTP on the same port: "/" serves the demo client (logged in) or the login page,
 *   plus the auth endpoints that mirror the control panel's vocabulary
 *   (/api/health, /api/session, /api/login/start, /api/login/verify, /api/logout).
 * - WebSocket upgrades are gated: a valid panel session cookie is required, the
 *   handshake Origin is checked, and blacklisted/soft-blocked IPs are refused.
 * - Clients choose granularity per-connection via { type: "subscribe", stream: boolean }.
 * - start()/stop() are idempotent and safe to call from session lifecycle events.
 *
 * The listener keeps binding every interface (host omitted) on purpose: the operator
 * asked for LAN reachability, and auth is the boundary instead of the bind address.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { PROTOCOL_VERSION, type WireEnvelope } from "./protocol";
import type { AuthApi } from "./auth";
import { isInlineSafeMime, type FileStore, type StoredFile } from "./files";

export interface WsClient {
	id: number;
	ws: WebSocket;
	/** Whether this client subscribed to token-level stream deltas. */
	stream: boolean;
	/** Session email captured at handshake time (audit trail). */
	email?: string;
}

const MAX_BODY_BYTES = 8 * 1024;

export interface FileLimits {
	allowUpload: boolean;
	maxUploadBytes: number;
	uploadRatePerMin: number;
}

function decodeSafe(value: string | string[] | undefined): string {
	const raw = Array.isArray(value) ? value[0] : value;
	if (!raw) return "file";
	try {
		return decodeURIComponent(String(raw));
	} catch {
		return String(raw);
	}
}

export class PiWsServer {
	private http: Server | undefined;
	private wss: WebSocketServer | undefined;
	private clients = new Set<WsClient>();
	private nextClientId = 1;
	private html: Record<string, string | undefined> = {};

	/** Actual listening port (0 until started). */
	port = 0;
	/** True between a successful start() and stop(). */
	running = false;

	constructor(private readonly auth: AuthApi) {}

	/** Attachment store + limits, enabled by index.ts (GET /f/<id>, POST /api/upload). */
	private files: FileStore | undefined;
	private fileLimits: FileLimits = { allowUpload: false, maxUploadBytes: 0, uploadRatePerMin: 0 };
	private uploadWindow = new Map<string, { n: number; resetAt: number }>();

	enableFiles(store: FileStore, limits: FileLimits): void {
		this.files = store;
		this.fileLimits = limits;
	}

	private uploadAllowed(ip: string): boolean {
		const limit = this.fileLimits.uploadRatePerMin;
		if (limit <= 0) return false;
		const now = Date.now();
		const key = ip || "?";
		const cur = this.uploadWindow.get(key);
		if (!cur || cur.resetAt <= now) {
			this.uploadWindow.set(key, { n: 1, resetAt: now + 60_000 });
			return true;
		}
		cur.n += 1;
		return cur.n <= limit;
	}

	/** Called after a client connects (index.ts sends hello + history). */
	onClientConnect: (client: WsClient) => void = () => {};
	/** Called for each parsed client message. */
	onClientMessage: (client: WsClient, data: Record<string, any>) => void = () => {};

	async start(port: number): Promise<void> {
		if (this.running) return;
		this.html = {
			client: this.readClientFile("index.html"),
			login: this.readClientFile("login.html"),
		};

		await new Promise<void>((resolve, reject) => {
			const http = createServer((req, res) => {
				this.handleHttp(req, res).catch((err) => {
					console.warn(`[pi-websocket] http_error path=${req.url} err=${err instanceof Error ? err.message : String(err)}`);
					if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
					res.end("internal error");
				});
			});
			http.on("error", reject);
			// A browser tab idles for minutes; Node's 5s default would reset the
			// keep-alive socket and make the next fetch fail.
			http.keepAliveTimeout = 65_000;
			http.headersTimeout = 70_000;
			http.requestTimeout = 120_000;
			// Bind every interface (host intentionally omitted); auth is the boundary.
			http.listen(port, () => resolve());

			const wss = new WebSocketServer({ noServer: true });
			http.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head, wss));
			wss.on("connection", (ws, req) => this.handleConnection(ws, req as IncomingMessage));

			this.http = http;
			this.wss = wss;
		});

		const addr = this.http?.address();
		this.port = typeof addr === "object" && addr ? addr.port : port;
		this.running = true;
	}

	async stop(): Promise<void> {
		if (!this.http && !this.wss) return;
		this.running = false;
		const wss = this.wss;
		const http = this.http;
		this.wss = undefined;
		this.http = undefined;

		for (const c of this.clients) {
			try {
				c.ws.close(1001, "pi-websocket shutting down");
			} catch {
				// already closed
			}
		}
		this.clients.clear();

		await new Promise<void>((resolve) => {
			if (!wss) return resolve();
			try {
				wss.close(() => resolve());
			} catch {
				resolve();
			}
		});
		await new Promise<void>((resolve) => {
			if (!http) return resolve();
			try {
				http.close(() => resolve());
				// force-close any lingering idle keep-alive sockets
				http.closeAllConnections?.();
			} catch {
				resolve();
			}
		});
		this.port = 0;
	}

	get clientCount(): number {
		return this.clients.size;
	}

	clientList(): WsClient[] {
		return [...this.clients];
	}

	send(client: WsClient, type: string, payload: Record<string, unknown> = {}): void {
		this.rawSend(client.ws, type, payload);
	}

	/** Send an event to every connected client. */
	broadcast(type: string, payload: Record<string, unknown> = {}): void {
		if (!this.wss) return;
		const data = this.encode(type, payload);
		if (!data) return;
		for (const c of this.clients) {
			if (c.ws.readyState === WebSocket.OPEN) {
				try {
					c.ws.send(data);
				} catch {
					// drop on send failure
				}
			}
		}
	}

	/** Send an event only to clients subscribed to token-level streaming. */
	broadcastStream(type: string, payload: Record<string, unknown> = {}): void {
		if (!this.wss) return;
		let any = false;
		for (const c of this.clients) if (c.stream) any = true;
		if (!any) return;
		const data = this.encode(type, payload);
		if (!data) return;
		for (const c of this.clients) {
			if (c.stream && c.ws.readyState === WebSocket.OPEN) {
				try {
					c.ws.send(data);
				} catch {
					// drop on send failure
				}
			}
		}
	}

	// --------------------------------------------------------------------------
	// HTTP: auth endpoints + page serving
	// --------------------------------------------------------------------------

	private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = req.url ?? "/";
		const path = url.split("?")[0];
		const method = req.method ?? "GET";

		if (path.startsWith("/api/")) {
			await this.handleApi(method, path, req, res);
			return;
		}

		if (path.startsWith("/f/")) {
			if (method !== "GET" && method !== "HEAD") {
				this.text(res, 405, "method not allowed");
				return;
			}
			this.serveFile(path.slice(3), req, res, method === "HEAD");
			return;
		}

		if (method !== "GET" && method !== "HEAD") {
			this.text(res, 405, "method not allowed");
			return;
		}

		if (path !== "/" && path !== "/index.html") {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("not found");
			return;
		}

		// Blacklisted / soft-blocked IPs never see either page.
		const blocked = this.auth.required ? this.auth.blockState(req) : null;
		if (blocked) {
			this.json(res, 403, { ok: false, error: blocked.error });
			return;
		}

		const session = this.auth.required ? this.auth.sessionOf(req) : null;
		if (this.auth.required && !session) {
			const login = this.html.login;
			if (!login) {
				this.text(res, 500, "pi-websocket: login.html not found next to the extension");
				return;
			}
			this.htmlOk(res, login);
			return;
		}

		const page = this.html.client;
		if (!page) {
			this.text(res, 500, "pi-websocket: client/index.html not found next to the extension");
			return;
		}
		this.htmlOk(res, page);
	}

	private async handleApi(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
		const secure = this.isSecure(req);
		const ip = this.auth.required ? this.auth.ipOf(req) : "";

		if (path === "/api/health" && method === "GET") {
			this.json(res, 200, {
				ok: true,
				ts: Math.floor(Date.now() / 1000),
				authed: this.auth.required ? Boolean(this.auth.sessionOf(req)) : true,
				authRequired: this.auth.required,
				smtpReady: this.auth.smtpReady(),
				version: PROTOCOL_VERSION,
			});
			return;
		}

		if (path === "/api/session" && method === "GET") {
			const s = this.auth.required ? this.auth.sessionOf(req) : null;
			this.json(res, 200, {
				authed: this.auth.required ? Boolean(s) : true,
				email: s?.email ?? null,
				expiresAt: s?.expires_at ?? null,
			});
			return;
		}

		if (path === "/api/login/start" && method === "POST") {
			const body = await this.readBody(req);
			if (!body) return this.json(res, 400, { ok: false, error: "bad_body" });
			if (!this.auth.required) return this.json(res, 400, { ok: false, error: "auth disabled" });
			const r = await this.auth.startLogin(body.email, ip);
			this.json(res, r.status, { ok: r.ok, error: r.ok ? null : r.error });
			return;
		}

		if (path === "/api/login/verify" && method === "POST") {
			const body = await this.readBody(req);
			if (!body) return this.json(res, 400, { ok: false, error: "bad_body" });
			if (!this.auth.required) return this.json(res, 400, { ok: false, error: "auth disabled" });
			const r = this.auth.verifyLogin(body.email, body.code, ip);
			if (r.ok && r.token) res.setHeader("Set-Cookie", this.auth.cookieHeader(r.token, secure));
			this.json(res, r.status, { ok: r.ok, error: r.ok ? null : r.error, email: r.email ?? null });
			return;
		}

		if (path === "/api/logout" && method === "POST") {
			if (this.auth.required) this.auth.logout(req, ip);
			res.setHeader("Set-Cookie", this.auth.clearCookieHeader());
			this.json(res, 200, { ok: true });
			return;
		}

		if (path === "/api/upload" && method === "POST") {
			if (!this.files) return this.json(res, 404, { ok: false, error: "uploads disabled" });
			if (!this.fileLimits.allowUpload) return this.json(res, 403, { ok: false, error: "uploads disabled" });
			if (this.auth.required) {
				if (!this.auth.originAllowed(req)) return this.json(res, 403, { ok: false, error: "origin not allowed" });
				if (!this.auth.sessionOf(req)) return this.json(res, 401, { ok: false, error: "need_login" });
				if (!this.uploadAllowed(ip)) return this.json(res, 429, { ok: false, error: "上传过于频繁" });
			}
			const raw = await this.readRaw(req, this.fileLimits.maxUploadBytes);
			if (raw === undefined) {
				return this.json(res, 413, { ok: false, error: `上传超过上限 ${Math.floor(this.fileLimits.maxUploadBytes / 1024)} KB` });
			}
			const declaredName = decodeSafe(req.headers["x-file-name"]);
			const mime = String(req.headers["content-type"] ?? "");
			const r = this.files.putUpload(declaredName, mime, raw);
			if (!r.ok) return this.json(res, 400, { ok: false, error: r.error });
			console.log(
				`[pi-websocket] upload ip=${ip || "?"} email=${this.auth.sessionOf(req)?.email ?? "?"} name=${r.file.name} bytes=${r.file.size} kind=${r.file.kind}`,
			);
			this.json(res, 200, {
				ok: true,
				id: r.file.id,
				name: r.file.name,
				mime: r.file.mime,
				size: r.file.size,
				kind: r.file.kind,
			});
			return;
		}

		if (path === "/api/files" && method === "GET") {
			if (this.auth.required && !this.auth.sessionOf(req)) return this.json(res, 401, { ok: false, error: "need_login" });
			if (!this.files) return this.json(res, 200, { ok: true, files: [] });
			this.json(res, 200, {
				ok: true,
				files: this.files.list().map((f) => ({
					id: f.id,
					name: f.name,
					mime: f.mime,
					size: f.size,
					kind: f.kind,
					dir: f.dir,
					createdAt: f.createdAt,
					url: `/f/${f.id}`,
				})),
				stats: this.files.stats(),
			});
			return;
		}

		if (!this.auth.required || this.auth.sessionOf(req)) {
			this.json(res, 404, { ok: false, error: "not_found" });
			return;
		}
		this.json(res, 401, { ok: false, error: "need_login" });
	}

	// --------------------------------------------------------------------------
	// WebSocket upgrade gate
	// --------------------------------------------------------------------------

	private handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer, wss: WebSocketServer): void {
		if (this.auth.required) {
			if (!this.auth.originAllowed(req)) {
				this.rejectUpgrade(socket, 403, "Forbidden");
				return;
			}
			const blocked = this.auth.blockState(req);
			if (blocked) {
				this.rejectUpgrade(socket, 403, "Forbidden");
				return;
			}
			const session = this.auth.sessionOf(req);
			if (!session) {
				this.rejectUpgrade(socket, 401, "Unauthorized");
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				(ws as WebSocket & { sessionEmail?: string }).sessionEmail = session.email;
				wss.emit("connection", ws, req);
			});
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
	}

	private rejectUpgrade(socket: import("node:stream").Duplex, status: number, reason: string): void {
		try {
			socket.write(
				`HTTP/1.1 ${status} ${reason}\r\n` +
					"Connection: close\r\n" +
					"Content-Length: 0\r\n" +
					`X-Pi-Ws-Reject: ${status === 401 ? "need_login" : "forbidden"}\r\n\r\n`,
			);
		} catch {
			// socket already gone
		}
		socket.destroy();
	}

	// --------------------------------------------------------------------------
	// Published files (agent -> browser)
	// --------------------------------------------------------------------------

	private serveFile(id: string, req: IncomingMessage, res: ServerResponse, headOnly: boolean): void {
		if (!this.files) {
			this.text(res, 404, "not found");
			return;
		}
		if (this.auth.required) {
			const blocked = this.auth.blockState(req);
			if (blocked) return this.json(res, 403, { ok: false, error: blocked.error });
			if (!this.auth.sessionOf(req)) return this.json(res, 401, { ok: false, error: "need_login" });
		}
		const f: StoredFile | undefined = this.files.get(id);
		if (!f || !existsSync(f.path)) {
			this.text(res, 404, "not found");
			return;
		}
		let size = f.size;
		try {
			size = statSync(f.path).size;
		} catch {
			this.text(res, 404, "not found");
			return;
		}
		const inline = f.kind === "image" && isInlineSafeMime(f.mime);
		const dispo = inline ? "inline" : "attachment";
		// Never let a markup-capable type render on this origin, even as a download.
		const unsafe = new Set(["text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml"]);
		const ctype = unsafe.has(f.mime) ? "application/octet-stream" : f.mime;
		// Header values must be ASCII; the real (possibly CJK) name goes in RFC 5987 form.
		const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "").slice(0, 120) || "file";
		const disposition = `${dispo}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`;
		res.writeHead(200, {
			"content-type": ctype,
			"content-length": String(size),
			"content-disposition": disposition,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		});
		if (headOnly) return res.end();
		const stream = createReadStream(f.path);
		stream.on("error", () => {
			try {
				res.destroy();
			} catch {
				// already gone
			}
		});
		stream.pipe(res);
	}

	// --------------------------------------------------------------------------
	// Wire helpers
	// --------------------------------------------------------------------------

	private encode(type: string, payload: Record<string, unknown>): string | undefined {
		try {
			return JSON.stringify({ v: PROTOCOL_VERSION, t: Date.now(), type, ...payload } satisfies WireEnvelope);
		} catch {
			return undefined;
		}
	}

	private rawSend(ws: WebSocket, type: string, payload: Record<string, unknown>): void {
		if (ws.readyState !== WebSocket.OPEN) return;
		const data = this.encode(type, payload);
		if (!data) return;
		try {
			ws.send(data);
		} catch {
			// drop on send failure
		}
	}

	private handleConnection(ws: WebSocket, req: IncomingMessage): void {
		const email = (ws as WebSocket & { sessionEmail?: string }).sessionEmail;
		const client: WsClient = { id: this.nextClientId++, ws, stream: false, email };
		this.clients.add(client);

		ws.on("message", (raw: unknown) => {
			let data: Record<string, any>;
			try {
				const parsed = JSON.parse(String(raw));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
				data = parsed as Record<string, any>;
			} catch {
				this.send(client, "error", { error: "invalid JSON message" });
				return;
			}
			try {
				this.onClientMessage(client, data);
			} catch (err) {
				this.send(client, "error", { error: `handler failed: ${err instanceof Error ? err.message : String(err)}` });
			}
		});

		const drop = () => {
			this.clients.delete(client);
		};
		ws.on("close", drop);
		ws.on("error", drop);

		this.onClientConnect(client);
	}

	private isSecure(req: IncomingMessage): boolean {
		const proto = req.headers["x-forwarded-proto"];
		return String(proto ?? "").split(",")[0].trim() === "https";
	}

	private async readBody(req: IncomingMessage): Promise<Record<string, any> | undefined> {
		const chunks: Buffer[] = [];
		let size = 0;
		try {
			for await (const chunk of req) {
				size += (chunk as Buffer).length;
				if (size > MAX_BODY_BYTES) return undefined;
				chunks.push(chunk as Buffer);
			}
		} catch {
			return undefined;
		}
		if (!chunks.length) return {};
		try {
			const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	private async readRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
		const chunks: Buffer[] = [];
		let size = 0;
		let overflow = false;
		try {
			for await (const chunk of req) {
				size += (chunk as Buffer).length;
				if (size > maxBytes) {
					overflow = true;
					// keep draining so the socket stays parseable; give up far above the cap
					if (size > maxBytes * 4) {
						req.destroy();
						break;
					}
					continue;
				}
				chunks.push(chunk as Buffer);
			}
		} catch {
			return undefined;
		}
		if (overflow) return undefined;
		return Buffer.concat(chunks);
	}

	private json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
		const data = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"content-length": Buffer.byteLength(data),
		});
		res.end(data);
	}

	private htmlOk(res: ServerResponse, body: string): void {
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			// The demo client is fully self-contained; keep the surface tight.
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:",
		});
		res.end(body);
	}

	private text(res: ServerResponse, status: number, body: string): void {
		res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
		res.end(body);
	}

	/** Locate a file in client/ relative to this file (../client/<name>). */
	private readClientFile(name: string): string | undefined {
		const dirs: string[] = [];
		try {
			dirs.push(dirname(fileURLToPath(import.meta.url)));
		} catch {
			// import.meta.url unavailable
		}
		try {
			const dn = (globalThis as Record<string, any>).__dirname;
			if (typeof dn === "string") dirs.push(dn);
		} catch {
			// no __dirname
		}
		for (const d of dirs) {
			const p = join(d, "..", "client", name);
			if (existsSync(p)) {
				try {
					return readFileSync(p, "utf8");
				} catch {
					// fall through
				}
			}
		}
		return undefined;
	}
}
