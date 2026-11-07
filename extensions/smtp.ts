/**
 * Minimal SMTP client: implicit TLS (465) or plain + optional STARTTLS (25/587),
 * AUTH LOGIN / AUTH PLAIN, UTF-8 bodies via base64.
 *
 * Written with node:net / node:tls on purpose:
 *   - no npm dependency, no jiti/native build step
 *   - the password never reaches argv, a temp file, or a log line
 */
import net from "node:net";
import tls from "node:tls";
import type { SmtpConfig } from "./config";

const STEP_TIMEOUT_MS = 15_000;

export interface OutgoingMail {
	to: string;
	subject: string;
	text: string;
}

export type SendResult = { ok: true } | { ok: false; detail: string };

type Socket = net.Socket | tls.TLSSocket;

/** Line-oriented reader with a small queue so responses can be awaited in order. */
class LineReader {
	private buf = "";
	private lines: string[] = [];
	private waiters: Array<(line: string) => void> = [];

	constructor(private socket: Socket) {
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.push(chunk));
	}

	private push(chunk: string): void {
		this.buf += chunk;
		for (;;) {
			const i = this.buf.indexOf("\n");
			if (i < 0) return;
			const line = this.buf.slice(0, i).replace(/\r$/, "");
			this.buf = this.buf.slice(i + 1);
			const w = this.waiters.shift();
			if (w) w(line);
			else this.lines.push(line);
		}
	}

	next(): Promise<string> {
		const queued = this.lines.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("SMTP 超时")), STEP_TIMEOUT_MS);
			this.waiters.push((line) => {
				clearTimeout(timer);
				resolve(line);
			});
		});
	}

	/** Read a full reply, following "\d{3}-" continuation lines. Ends at "\d{3} ". */
	async reply(): Promise<{ code: number; text: string }> {
		const first = await this.next();
		const m = /^(\d{3})([ -])(.*)$/.exec(first);
		if (!m) return { code: 0, text: first };
		const code = Number(m[1]);
		const parts = [m[3]];
		let last = m[2];
		while (last === "-") {
			const line = await this.next();
			const mm = /^(\d{3})([ -])(.*)$/.exec(line);
			parts.push(mm ? mm[3] : line);
			last = mm ? mm[2] : " ";
		}
		return { code, text: parts.join("\n") };
	}
}

function connect(cfg: SmtpConfig): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const opts = { host: cfg.host, port: cfg.port };
		const socket = cfg.secure ? tls.connect({ ...opts, servername: cfg.host }) : net.connect(opts);
		const event = cfg.secure ? "secureConnect" : "connect";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`连接 ${cfg.host}:${cfg.port} 超时`));
		}, STEP_TIMEOUT_MS);
		socket.once(event, () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

function upgradeToTls(socket: Socket, host: string): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		const secured = tls.connect({ socket: socket as net.Socket, servername: host }, () => resolve(secured));
		secured.once("error", reject);
	});
}

function b64(s: string): string {
	return Buffer.from(s, "utf8").toString("base64");
}

function rfc2822Date(d = new Date()): string {
	return d.toUTCString().replace(/GMT$/, "+0000");
}

/** UTF-8 safe subject (RFC 2047) plus a base64 body, so any language survives. */
function buildMessage(cfg: SmtpConfig, mail: OutgoingMail): string {
	const fromHeader = cfg.fromName ? `"${cfg.fromName.replace(/"/g, "")}" <${cfg.from}>` : `<${cfg.from}>`;
	const bodyB64 = (Buffer.from(mail.text, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
	const headers = [
		`From: ${fromHeader}`,
		`To: <${mail.to}>`,
		`Subject: =?UTF-8?B?${b64(mail.subject)}?=`,
		`Date: ${rfc2822Date()}`,
		`Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2, 10)}@pi-websocket>`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
	];
	return `${headers.join("\r\n")}\r\n\r\n${bodyB64}`;
}

export function smtpConfigured(cfg: SmtpConfig | undefined): boolean {
	return Boolean(cfg?.host && cfg?.user && cfg?.pass);
}

export async function sendMail(cfg: SmtpConfig, mail: OutgoingMail): Promise<SendResult> {
	let socket: Socket | undefined;
	try {
		socket = await connect(cfg);
		let reader = new LineReader(socket);

		const say = async (line: string): Promise<{ code: number; text: string }> => {
			socket!.write(`${line}\r\n`);
			return reader.reply();
		};
		const expect = async (line: string, codes: number[], label: string) => {
			const r = await say(line);
			if (!codes.includes(r.code)) throw new Error(`${label}: ${r.code} ${r.text.replace(/\s+/g, " ").slice(0, 160)}`);
			return r;
		};

		const greeting = await reader.reply();
		if (greeting.code !== 220) throw new Error(`服务端问候异常: ${greeting.code} ${greeting.text}`);

		await expect(`EHLO ${cfg.host}`, [250], "EHLO");

		if (!cfg.secure && cfg.starttls) {
			await expect("STARTTLS", [220], "STARTTLS");
			const secured = await upgradeToTls(socket, cfg.host);
			socket.removeAllListeners("data");
			socket = secured;
			reader = new LineReader(socket);
			await expect(`EHLO ${cfg.host}`, [250], "EHLO(TLS)");
		}

		const auth = await say("AUTH LOGIN");
		if (auth.code === 334) {
			await expect(b64(cfg.user), [334], "AUTH 用户名");
			await expect(b64(cfg.pass), [235], "AUTH 口令");
		} else if (auth.code === 503) {
			// already authenticated (rare, but some relays allow it)
		} else {
			await expect(`AUTH PLAIN ${b64(`\u0000${cfg.user}\u0000${cfg.pass}`)}`, [235], "AUTH PLAIN");
		}

		await expect(`MAIL FROM:<${cfg.from}>`, [250], "MAIL FROM");
		await expect(`RCPT TO:<${mail.to}>`, [250, 251], "RCPT TO");
		await expect("DATA", [354], "DATA");

		const message = buildMessage(cfg, mail).replace(/^\./gm, "..");
		const done = await say(`${message}\r\n.`);
		if (done.code !== 250) throw new Error(`投递失败: ${done.code} ${done.text.replace(/\s+/g, " ").slice(0, 160)}`);

		try {
			socket.write("QUIT\r\n");
			socket.end();
		} catch {
			// best effort
		}
		return { ok: true };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		// never echo the password: strip it if the server happened to quote it back
		const safe = cfg.pass ? detail.split(cfg.pass).join("***") : detail;
		return { ok: false, detail: safe };
	} finally {
		try {
			socket?.destroy();
		} catch {
			// already closed
		}
	}
}
