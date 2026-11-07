/**
 * pi-websocket configuration.
 *
 * One JSON file holds everything deployable: the login email allowlist and the
 * SMTP account used to deliver codes. All runtime state (codes, sessions,
 * lockouts) stays in memory — no database, nothing written back.
 *
 * Lookup order (first existing wins):
 *   1. $PI_WS_CONFIG
 *   2. <package root>/pi-websocket.config.json
 *   3. ~/.pi/pi-websocket.config.json
 *
 * The file contains an SMTP password, so it should be mode 0600; a world/group
 * readable file produces a startup warning (the password itself is never logged).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SmtpConfig {
	host: string;
	port: number;
	/** true = implicit TLS (465); false = plain, optionally upgraded with STARTTLS */
	secure: boolean;
	starttls: boolean;
	user: string;
	pass: string;
	from: string;
	fromName?: string;
}

export interface PiWsConfig {
	path: string;
	adminEmails: string[];
	smtp: SmtpConfig;
	cookieName: string;
	sessionTtlSec: number;
	otpDigits: number;
	otpTtlSec: number;
	otpMaxAttempts: number;
	otpResendCooldownSec: number;
	otpMaxSendsPerHour: number;
	limitEmailUnknown: number;
	limitStartPerHour: number;
	blacklistTtlSec: number;
	lanSoftBlockSec: number;
	allowedOrigins: string[];
	/**
	 * Commands a logged-in web client may run through `pi.exec` (the `!ls` case).
	 * Empty (default) = the exec action is refused outright. Only exact
	 * executable names are matched; no shell is involved.
	 */
	allowExec: string[];
	/** Command-channel budget per connected client, per minute. */
	commandRatePerMin: number;
	/** Browser -> agent attachments. */
	allowUpload: boolean;
	/** Agent -> browser publishing (send_image_to_web / send_file_to_web). */
	allowPublish: boolean;
	/** Where uploaded / published bytes live (created 0700). */
	fileStoreDir: string;
	/** How long a stored file stays fetchable. */
	fileTtlSec: number;
	maxUploadBytes: number;
	maxPublishBytes: number;
	maxFiles: number;
	maxStoreBytes: number;
	/** Extra directories the publish tools may read (besides the session cwd). */
	publishRoots: string[];
	/** Uploads allowed per connected client per minute. */
	uploadRatePerMin: number;
	/**
	 * How many session entries a fresh connection replays. Every reconnect used
	 * to resend the whole tail, which is what made long-lived pages grow; keep
	 * this well below the old hard-coded 500.
	 */
	historyEntries: number;
	/**
	 * Byte budget for one history payload (JSON length of the entries array).
	 * Oldest entries are dropped first until the payload fits.
	 */
	historyByteBudget: number;
}

function packageRoot(): string {
	try {
		return dirname(dirname(fileURLToPath(import.meta.url)));
	} catch {
		return process.cwd();
	}
}

export function configCandidates(): string[] {
	const out: string[] = [];
	if (process.env.PI_WS_CONFIG) out.push(process.env.PI_WS_CONFIG);
	out.push(join(packageRoot(), "pi-websocket.config.json"));
	out.push(join(homedir(), ".pi", "pi-websocket.config.json"));
	return out;
}

function pick(obj: Record<string, any>, key: string, fallback: number): number {
	const v = obj[key];
	return Number.isFinite(v) && v > 0 ? Number(v) : fallback;
}

/**
 * Load and validate the config file. Throws with an actionable message when the
 * file is missing or lacks an allowlist / SMTP account.
 */
export function loadConfig(): PiWsConfig {
	const candidates = configCandidates();
	const path = candidates.find((p) => p && existsSync(p));
	if (!path) {
		throw new Error(`配置文件不存在，请创建其中之一：${candidates.join(" / ")}`);
	}

	let raw: Record<string, any>;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(`配置文件解析失败 ${path}: ${err instanceof Error ? err.message : String(err)}`);
	}

	try {
		const mode = statSync(path).mode & 0o777;
		if (mode & 0o077) {
			console.warn(`[pi-websocket] ${path} 权限是 ${mode.toString(8)}，里面含 SMTP 口令，建议 chmod 600`);
		}
	} catch {
		// stat failed: keep going
	}

	const emails = Array.isArray(raw.adminEmails)
		? raw.adminEmails.map((s: unknown) => String(s).trim().toLowerCase()).filter(Boolean)
		: [];
	if (!emails.length) throw new Error(`配置文件里没有 adminEmails（允许登录的邮箱）: ${path}`);

	const s = raw.smtp ?? {};
	const smtp: SmtpConfig = {
		host: String(s.host ?? "").trim(),
		port: Number(s.port ?? (s.secure === false ? 587 : 465)),
		secure: s.secure !== false,
		starttls: s.starttls === true,
		user: String(s.user ?? "").trim(),
		pass: String(s.pass ?? ""),
		from: String(s.from ?? s.user ?? "").trim(),
		fromName: s.fromName ? String(s.fromName) : undefined,
	};
	if (!smtp.host || !smtp.user || !smtp.pass) {
		throw new Error(`配置文件里 smtp.host / smtp.user / smtp.pass 必填: ${path}`);
	}
	if (!smtp.from) smtp.from = smtp.user;

	return {
		path,
		adminEmails: emails,
		smtp,
		cookieName: String(raw.cookieName ?? "piws_session"),
		sessionTtlSec: pick(raw, "sessionTtlSec", 12 * 3600),
		otpDigits: pick(raw, "otpDigits", 6),
		otpTtlSec: pick(raw, "otpTtlSec", 180),
		otpMaxAttempts: pick(raw, "otpMaxAttempts", 5),
		otpResendCooldownSec: pick(raw, "otpResendCooldownSec", 60),
		otpMaxSendsPerHour: pick(raw, "otpMaxSendsPerHour", 8),
		limitEmailUnknown: pick(raw, "limitEmailUnknown", 3),
		limitStartPerHour: pick(raw, "limitStartPerHour", 10),
		blacklistTtlSec: pick(raw, "blacklistTtlSec", 24 * 3600),
		lanSoftBlockSec: pick(raw, "lanSoftBlockSec", 900),
		allowedOrigins: Array.isArray(raw.allowedOrigins) ? raw.allowedOrigins.map((s: unknown) => String(s)) : [],
		allowExec: Array.isArray(raw.allowExec)
			? raw.allowExec.map((s: unknown) => String(s).trim()).filter((s) => /^[A-Za-z0-9._-]+$/.test(s))
			: [],
		commandRatePerMin: pick(raw, "commandRatePerMin", 30),
		allowUpload: raw.allowUpload !== false,
		allowPublish: raw.allowPublish !== false,
		fileStoreDir: raw.fileStoreDir ? String(raw.fileStoreDir) : join(homedir(), ".pi", "pi-websocket-files"),
		fileTtlSec: pick(raw, "fileTtlSec", 6 * 3600),
		maxUploadBytes: pick(raw, "maxUploadBytes", 8 * 1024 * 1024),
		maxPublishBytes: pick(raw, "maxPublishBytes", 64 * 1024 * 1024),
		maxFiles: pick(raw, "maxFiles", 200),
		maxStoreBytes: pick(raw, "maxStoreBytes", 512 * 1024 * 1024),
		publishRoots: Array.isArray(raw.publishRoots) ? raw.publishRoots.map((s: unknown) => String(s)) : [],
		uploadRatePerMin: pick(raw, "uploadRatePerMin", 20),
		historyEntries: Math.min(1000, pick(raw, "historyEntries", 200)),
		historyByteBudget: Math.min(8 * 1024 * 1024, pick(raw, "historyByteBudget", 1_500_000)),
	};
}
