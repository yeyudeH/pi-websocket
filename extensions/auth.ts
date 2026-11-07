/**
 * pi-websocket auth: email allowlist + one-time code over SMTP + session cookie,
 * with IP lockouts. Everything lives in memory — no database, nothing persisted.
 *
 * Deliberate consequences of the in-memory design:
 *   - restarting pi clears sessions, pending codes and lockouts (by design)
 *   - the only durable artifact is the config file (SMTP account + allowlist)
 *   - cookies/codes are stored as sha256(salt|value); the salt is per-process
 *
 * Guards mirror the control panel's wording and thresholds so the UX matches:
 * unknown email and wrong code are reported identically (no account probing),
 * a 60s resend cooldown, 5 wrong codes invalidate, per-hour send/attempt caps,
 * private-range IPs get an in-memory soft-block instead of a persistent ban.
 *
 * Env:
 *   PI_WS_CONFIG=<path>          explicit config file
 *   PI_WS_AUTH=on|off            default on; off = no auth at all (trusted local only)
 */
import crypto from "node:crypto";
import { loadConfig, type PiWsConfig } from "./config";
import { sendMail, smtpConfigured } from "./smtp";

type AnyRecord = Record<string, any>;

export interface AuthSession {
	email: string;
	expires_at: number;
	last_seen: number;
}

export interface AuthResult {
	ok: boolean;
	status: number;
	error?: string | null;
	token?: string;
	email?: string;
	expiresAt?: number;
	retryIn?: number;
}

export interface AuthApi {
	required: boolean;
	openAccess: boolean;
	cookieName: string;
	sessionTtlSec: number;
	/** Path of the config file in use, for startup output. */
	configPath: string;
	smtpReady(): boolean;
	ipOf(req: AnyRecord): string;
	blockState(req: AnyRecord): { error: string; retryIn?: number } | null;
	sessionOf(req: AnyRecord): AuthSession | null;
	startLogin(email: unknown, ip: string): Promise<AuthResult>;
	verifyLogin(email: unknown, code: unknown, ip: string): AuthResult;
	logout(req: AnyRecord, ip: string): void;
	cookieHeader(token: string, secure: boolean): string;
	clearCookieHeader(): string;
	originAllowed(req: AnyRecord): boolean;
	/** Command-channel policy pulled from the same config file (see index.ts). */
	allowExec: string[];
	commandRatePerMin: number;
	/** History replay size for a fresh connection (see index.ts). */
	history: HistoryPolicy;
	/** Attachment / published-file policy (see extensions/files.ts). */
	files: FilePolicy;
}

export interface HistoryPolicy {
	/** Max session entries sent per connection. */
	entries: number;
	/** Max JSON length of one history payload. */
	byteBudget: number;
}

export interface FilePolicy {
	allowUpload: boolean;
	allowPublish: boolean;
	dir: string;
	ttlSec: number;
	maxUploadBytes: number;
	maxPublishBytes: number;
	maxFiles: number;
	maxStoreBytes: number;
	publishRoots: string[];
	uploadRatePerMin: number;
}

// Same user-facing wording as the control panel's login route.
const START_MSG: Record<string, string | ((r: AnyRecord) => string)> = {
	bad_credentials: "邮箱或验证码不正确",
	cooldown: (r) => `请 ${r.retryIn}s 后重试`,
	too_many_sends: "本小时发送次数已达上限",
	blacklisted: "该 IP 已被临时封锁",
};
const VERIFY_MSG: Record<string, string | ((r: AnyRecord) => string)> = {
	bad_code: (r) => `验证码不正确${r.left ? `，还可试 ${r.left} 次` : ""}`,
	expired: "验证码已过期，请重新获取",
	no_otp: "请先获取验证码",
	locked: "错误次数过多，该 IP 已被封锁",
	bad_credentials: "邮箱或验证码不正确",
	blacklisted: "该 IP 已被临时封锁",
};

function textOf(map: Record<string, string | ((r: AnyRecord) => string)>, reason: string, r: AnyRecord): string {
	const m = map[reason];
	if (typeof m === "function") return m(r);
	return m || reason;
}

const now = () => Math.floor(Date.now() / 1000);

function isPrivateIp(ip: string): boolean {
	if (!ip) return true;
	if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
	if (ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
	if (ip.startsWith("169.254.")) return true;
	return false;
}

interface OtpRow {
	codeHash: string;
	createdAt: number;
	expiresAt: number;
	attempts: number;
	sentAt: number;
	sentCount: number;
	warnedHour: number;
}

interface SessionRow {
	email: string;
	ip: string;
	createdAt: number;
	expiresAt: number;
	lastSeen: number;
}

interface LockRow {
	reason: string;
	until: number;
	permanent: boolean;
}

const EVENT_RING = 2000;

export function createAuth(): AuthApi {
	const cfg: PiWsConfig = loadConfig();
	const salt = crypto.randomBytes(32);
	const H = (v: string) => crypto.createHash("sha256").update(salt).update("|").update(v).digest("hex");

	const otp = new Map<string, OtpRow>();
	const sessions = new Map<string, SessionRow>();
	const blacklist = new Map<string, LockRow>();
	const softBlock = new Map<string, LockRow>();
	/** audit ring, newest last: kept small on purpose (in-memory only) */
	const events: Array<{ ts: number; ip: string; email: string | null; event: string; ok: number; reason: string | null }> = [];

	function audit(ip: string, email: string | null, event: string, ok: number, reason: string | null): void {
		events.push({ ts: now(), ip, email, event, ok, reason });
		if (events.length > EVENT_RING) events.splice(0, events.length - EVENT_RING);
		if (!ok) console.warn(`[pi-websocket] auth ${event} ip=${ip} email=${email ?? "-"} reason=${reason ?? "-"}`);
	}

	function countRecent(ip: string, event: string, windowSec: number): number {
		const from = now() - windowSec;
		let n = 0;
		for (let i = events.length - 1; i >= 0; i--) {
			const e = events[i];
			if (e.ts < from) break;
			if (e.ip === ip && e.event === event) n++;
		}
		return n;
	}

	function locked(ip: string): LockRow | null {
		const l = blacklist.get(ip);
		if (!l) return null;
		if (l.permanent || l.until > now()) return l;
		blacklist.delete(ip);
		return null;
	}

	function softLocked(ip: string): LockRow | null {
		const l = softBlock.get(ip);
		if (!l) return null;
		if (l.until > now()) return l;
		softBlock.delete(ip);
		return null;
	}

	/** Public IPs get a timed ban; private ranges only a soft-block (never lock yourself out). */
	function autoLock(ip: string, reason: string): void {
		if (isPrivateIp(ip)) {
			softBlock.set(ip, { reason, until: now() + cfg.lanSoftBlockSec, permanent: false });
			audit(ip, null, "auto_softblock", 1, `${reason} ${cfg.lanSoftBlockSec}s`);
			return;
		}
		blacklist.set(ip, { reason, until: now() + cfg.blacklistTtlSec, permanent: false });
		audit(ip, null, "auto_blacklist", 1, reason);
	}

	function sweep(): void {
		const t = now();
		for (const [k, v] of otp) if (v.expiresAt < t - 3600) otp.delete(k);
		for (const [k, v] of sessions) if (v.expiresAt < t) sessions.delete(k);
		for (const [k, v] of blacklist) if (!v.permanent && v.until < t) blacklist.delete(k);
		for (const [k, v] of softBlock) if (v.until < t) softBlock.delete(k);
	}
	// unref so the interval never keeps pi alive
	const sweeper = setInterval(sweep, 60_000);
	if (typeof sweeper.unref === "function") sweeper.unref();

	function clientIp(req: AnyRecord): string {
		const sock = String(req?.socket?.remoteAddress ?? "");
		const xff = req?.headers?.["x-forwarded-for"];
		if ((sock === "127.0.0.1" || sock === "::1" || sock.startsWith("::ffff:127.")) && xff) {
			const first = String(xff).split(",")[0].trim();
			if (first) return first;
		}
		return sock.replace(/^::ffff:/, "");
	}

	function parseCookie(header: string): Record<string, string> {
		const out: Record<string, string> = {};
		for (const part of header.split(";")) {
			const i = part.indexOf("=");
			if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
		}
		return out;
	}

	function sessionFrom(req: AnyRecord): { token: string; row: SessionRow } | null {
		const raw = parseCookie(String(req?.headers?.cookie ?? ""))[cfg.cookieName];
		if (!raw) return null;
		const key = H(raw);
		const row = sessions.get(key);
		if (!row) return null;
		if (row.expiresAt < now()) {
			sessions.delete(key);
			return null;
		}
		row.lastSeen = now();
		return { token: key, row };
	}

	return {
		required: true,
		openAccess: false,
		cookieName: cfg.cookieName,
		sessionTtlSec: cfg.sessionTtlSec,
		configPath: cfg.path,
		smtpReady: () => smtpConfigured(cfg.smtp),

		ipOf: (req) => clientIp(req),

		blockState: (req) => {
			const ip = clientIp(req);
			const bl = locked(ip);
			if (bl) return { error: "该 IP 已被临时封锁" };
			const sb = softLocked(ip);
			if (sb) return { error: `请 ${Math.max(0, sb.until - now())}s 后重试`, retryIn: sb.until };
			return null;
		},

		sessionOf: (req) => {
			const s = sessionFrom(req);
			return s ? { email: s.row.email, expires_at: s.row.expiresAt, last_seen: s.row.lastSeen } : null;
		},

		startLogin: async (emailRaw, ip) => {
			const email = String(emailRaw ?? "").trim().toLowerCase();
			if (locked(ip)) return { ok: false, status: 401, error: textOf(START_MSG, "blacklisted", {}) };
			const sb = softLocked(ip);
			if (sb) return { ok: false, status: 401, error: textOf(START_MSG, "cooldown", { retryIn: Math.max(0, sb.until - now()) }) };

			if (!cfg.adminEmails.includes(email)) {
				audit(ip, email, "login_start_fail", 0, "email_not_allowed");
				if (countRecent(ip, "login_start_fail", 3600) >= cfg.limitEmailUnknown) autoLock(ip, "email_unknown");
				return { ok: false, status: 401, error: textOf(START_MSG, "bad_credentials", {}) };
			}

			if (countRecent(ip, "login_start", 3600) >= cfg.limitStartPerHour) {
				autoLock(ip, "start_rate");
				return { ok: false, status: 401, error: textOf(START_MSG, "blacklisted", {}) };
			}

			const t = now();
			const cur = otp.get(email);
			if (cur && t - cur.sentAt < cfg.otpResendCooldownSec) {
				return { ok: false, status: 401, error: textOf(START_MSG, "cooldown", { retryIn: cfg.otpResendCooldownSec - (t - cur.sentAt) }) };
			}
			if (cur && cur.sentCount >= cfg.otpMaxSendsPerHour && t - cur.warnedHour < 3600) {
				return { ok: false, status: 401, error: textOf(START_MSG, "too_many_sends", {}) };
			}
			const sameHour = cur && t - cur.warnedHour < 3600;
			const code = String(crypto.randomInt(0, 10 ** cfg.otpDigits)).padStart(cfg.otpDigits, "0");
			const row: OtpRow = {
				codeHash: H(code),
				createdAt: t,
				expiresAt: t + cfg.otpTtlSec,
				attempts: 0,
				sentAt: t,
				sentCount: sameHour ? (cur?.sentCount ?? 0) + 1 : 1,
				warnedHour: sameHour ? (cur?.warnedHour ?? t) : t,
			};

			const sent = await sendMail(cfg.smtp, {
				to: email,
				subject: "pi-websocket 登录验证码",
				text: [
					`你的 pi-websocket 登录验证码：${code}`,
					"",
					`有效期 ${Math.round(cfg.otpTtlSec / 60)} 分钟，请勿转发给他人。`,
					"如果这不是你本人的操作，忽略本邮件即可。",
				].join("\n"),
			});
			if (!sent.ok) {
				audit(ip, email, "mail_send", 0, sent.detail);
				return { ok: false, status: 502, error: "mail_failed" };
			}

			otp.set(email, row);
			audit(ip, email, "login_start", 1, null);
			console.log(`[pi-websocket] 验证码已发送至 ${email}（有效期 ${cfg.otpTtlSec}s）`);
			return { ok: true, status: 200, error: null };
		},

		verifyLogin: (emailRaw, codeRaw, ip) => {
			const email = String(emailRaw ?? "").trim().toLowerCase();
			const code = String(codeRaw ?? "").trim();
			if (locked(ip)) return { ok: false, status: 401, error: textOf(VERIFY_MSG, "blacklisted", {}) };
			if (softLocked(ip)) return { ok: false, status: 401, error: textOf(VERIFY_MSG, "locked", {}) };
			if (!cfg.adminEmails.includes(email)) {
				audit(ip, email, "login_verify", 0, "email_not_allowed");
				return { ok: false, status: 401, error: textOf(VERIFY_MSG, "bad_credentials", {}) };
			}

			const t = now();
			const cur = otp.get(email);
			if (!cur) {
				audit(ip, email, "login_verify", 0, "no_otp");
				return { ok: false, status: 401, error: textOf(VERIFY_MSG, "no_otp", {}) };
			}
			if (cur.expiresAt < t) {
				otp.delete(email);
				audit(ip, email, "login_verify", 0, "expired");
				return { ok: false, status: 401, error: textOf(VERIFY_MSG, "expired", {}) };
			}
			if (cur.codeHash !== H(code)) {
				cur.attempts += 1;
				audit(ip, email, "login_code_fail", 0, `attempt ${cur.attempts}`);
				if (cur.attempts >= cfg.otpMaxAttempts) {
					otp.delete(email);
					autoLock(ip, "code_fail");
					return { ok: false, status: 401, error: textOf(VERIFY_MSG, "locked", {}) };
				}
				return { ok: false, status: 401, error: textOf(VERIFY_MSG, "bad_code", { left: cfg.otpMaxAttempts - cur.attempts }) };
			}

			otp.delete(email);
			const token = crypto.randomBytes(32).toString("hex");
			sessions.set(H(token), { email, ip, createdAt: t, expiresAt: t + cfg.sessionTtlSec, lastSeen: t });
			audit(ip, email, "login_ok", 1, null);
			return { ok: true, status: 200, error: null, token, email, expiresAt: t + cfg.sessionTtlSec };
		},

		logout: (req) => {
			const s = sessionFrom(req);
			if (s) sessions.delete(s.token);
		},

		cookieHeader: (token, secure) =>
			`${cfg.cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${cfg.sessionTtlSec}${secure ? "; Secure" : ""}`,
		clearCookieHeader: () => `${cfg.cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,

		originAllowed: (req) => {
			const origin = req?.headers?.origin;
			if (!origin) return true; // curl / scripts / native clients
			const host = req?.headers?.host;
			if (host && (origin === `http://${host}` || origin === `https://${host}`)) return true;
			return cfg.allowedOrigins.includes(String(origin));
		},
		allowExec: cfg.allowExec,
		commandRatePerMin: cfg.commandRatePerMin,
		history: { entries: cfg.historyEntries, byteBudget: cfg.historyByteBudget },
		files: {
			allowUpload: cfg.allowUpload,
			allowPublish: cfg.allowPublish,
			dir: cfg.fileStoreDir,
			ttlSec: cfg.fileTtlSec,
			maxUploadBytes: cfg.maxUploadBytes,
			maxPublishBytes: cfg.maxPublishBytes,
			maxFiles: cfg.maxFiles,
			maxStoreBytes: cfg.maxStoreBytes,
			publishRoots: cfg.publishRoots,
			uploadRatePerMin: cfg.uploadRatePerMin,
		},
	};
}

/** Auth that lets everything through; only for explicit PI_WS_AUTH=off. */
function openAuth(): AuthApi {
	// Auth-off mode still honours the two history knobs when a config file can be
	// read, so replay size stays tunable in every mode; defaults apply otherwise.
	let history = { entries: 200, byteBudget: 1_500_000 };
	try {
		const c = loadConfig();
		history = { entries: c.historyEntries, byteBudget: c.historyByteBudget };
	} catch {
		// no usable config file in auth-off mode: keep the safe defaults
	}
	return {
		required: false,
		openAccess: true,
		cookieName: "piws_session",
		sessionTtlSec: 0,
		configPath: "(auth off)",
		smtpReady: () => false,
		ipOf: (req) => String(req?.socket?.remoteAddress ?? "").replace(/^::ffff:/, ""),
		blockState: () => null,
		sessionOf: () => null,
		startLogin: async () => ({ ok: false, status: 400, error: "auth disabled" }),
		verifyLogin: () => ({ ok: false, status: 400, error: "auth disabled" }),
		logout: () => {},
		cookieHeader: () => "",
		clearCookieHeader: () => "",
		originAllowed: () => true,
		allowExec: [],
		commandRatePerMin: 30,
		history,
		files: {
			allowUpload: true,
			allowPublish: true,
			dir: "",
			ttlSec: 6 * 3600,
			maxUploadBytes: 8 * 1024 * 1024,
			maxPublishBytes: 64 * 1024 * 1024,
			maxFiles: 200,
			maxStoreBytes: 512 * 1024 * 1024,
			publishRoots: [],
			uploadRatePerMin: 20,
		},
	};
}

/** Build the auth API. Throws when auth is required but the config is unusable. */
export function getAuth(): AuthApi {
	if ((process.env.PI_WS_AUTH || "on").toLowerCase() === "off") return openAuth();
	return createAuth();
}
