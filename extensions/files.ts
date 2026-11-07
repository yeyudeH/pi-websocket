/**
 * File store for both directions of the web channel.
 *
 *  - uploads   : browser -> POST /api/upload -> stored here, then handed to the
 *                agent (images become ImageContent blocks, other files are passed
 *                as a local path the agent can read with its own tools).
 *  - published : agent -> send_image_to_web / send_file_to_web copies the file in,
 *                the browser fetches it back over GET /f/<id> (session cookie).
 *
 * Everything lives under one directory (0700) with per-file sidecar metadata
 * (0600), so a restart re-indexes from disk instead of losing links that were
 * already shown to the browser. Ids are random; nothing about the on-disk name
 * comes from user input.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";

export type FileKind = "image" | "file";

export interface StoredFile {
	id: string;
	name: string;
	mime: string;
	size: number;
	path: string;
	kind: FileKind;
	createdAt: number;
	sha256: string;
	/** uploads are consumed once when they reach the agent */
	consumed?: boolean;
	/** "upload" (browser) or "publish" (agent tool) */
	dir: "in" | "out";
}

export interface FileStoreOptions {
	dir: string;
	ttlSec: number;
	maxUploadBytes: number;
	maxPublishBytes: number;
	maxFiles: number;
	maxStoreBytes: number;
}

const IMAGE_MIME = new Map<string, string>([
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["gif", "image/gif"],
	["webp", "image/webp"],
]);

const MIME_IMAGE = new Map<string, string>([
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/jpg", "jpg"],
	["image/gif", "gif"],
	["image/webp", "webp"],
]);

const MAX_NAME = 140;

export function isImageMime(mime: string): boolean {
	return MIME_IMAGE.has(String(mime || "").toLowerCase());
}

/** Only these are ever served inline; anything else becomes a download. */
const INLINE_SAFE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isInlineSafeMime(mime: string): boolean {
	return INLINE_SAFE_MIMES.has(String(mime || "").toLowerCase());
}

/**
 * Magic-byte sniffing. A browser can declare image/png while uploading HTML, and
 * an inline-served HTML file on the app origin is stored XSS, so the sniffed type
 * wins when recognised, and a declared image that fails the sniff is demoted.
 */
export function sniffMagic(buf: Buffer): string | undefined {
	if (!buf || buf.length < 4) return undefined;
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	if (buf.length >= 6) {
		const head = buf.subarray(0, 6).toString("latin1");
		if (head === "GIF87a" || head === "GIF89a") return "image/gif";
	}
	if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
		return "image/webp";
	}
	if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
	if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return "application/zip";
	return undefined;
}

/** Strip anything path-like or control-ish from a display name. */
export function sanitizeName(name: unknown, fallback = "file"): string {
	const raw = String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
	const base = basename(raw).replace(/^\.+/, "").slice(0, MAX_NAME);
	return base || fallback;
}

function newId(): string {
	return randomBytes(12).toString("hex");
}

/** Extension for a confirmed image mime (so the on-disk name matches reality). */
function mimeExt(mime: string): string {
	return MIME_IMAGE.get(String(mime).toLowerCase()) ?? "bin";
}

function sniffMime(name: string, declared: string): { mime: string; ext: string; kind: FileKind } {
	const ext = extname(name).slice(1).toLowerCase();
	const declaredMime = String(declared || "").toLowerCase().split(";")[0].trim();
	if (MIME_IMAGE.has(declaredMime)) return { mime: declaredMime, ext: MIME_IMAGE.get(declaredMime)!, kind: "image" };
	if (IMAGE_MIME.has(ext)) return { mime: IMAGE_MIME.get(ext)!, ext, kind: "image" };
	if (declaredMime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(declaredMime)) return { mime: declaredMime, ext, kind: "file" };
	return { mime: "application/octet-stream", ext, kind: "file" };
}

export type StoreResult = { ok: true; file: StoredFile } | { ok: false; error: string };

export class FileStore {
	private index = new Map<string, StoredFile>();
	readonly dir: string;

	constructor(private readonly o: FileStoreOptions) {
		this.dir = o.dir;
		try {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			chmodSync(this.dir, 0o700);
		} catch {
			// keep going; writes will report the real error
		}
		this.rescan();
	}

	/** Rebuild the index from sidecar files (survives extension reload). */
	private rescan(): void {
		let names: string[] = [];
		try {
			names = readdirSync(this.dir);
		} catch {
			return;
		}
		const now = Date.now();
		for (const n of names) {
			if (!n.endsWith(".meta.json")) continue;
			try {
				const meta = JSON.parse(readFileSync(join(this.dir, n), "utf8")) as StoredFile;
				if (!meta?.id || !meta.path || !existsSync(meta.path)) continue;
				if (now - meta.createdAt > this.o.ttlSec * 1000) {
					this.remove(meta);
					continue;
				}
				this.index.set(meta.id, meta);
			} catch {
				// skip unreadable sidecar
			}
		}
	}

	private metaPath(id: string): string {
		return join(this.dir, `${id}.meta.json`);
	}

	private dataPath(id: string, ext: string): string {
		return join(this.dir, `${id}${ext ? `.${ext}` : ""}`);
	}

	private writeMeta(meta: StoredFile): void {
		try {
			writeFileSync(this.metaPath(meta.id), JSON.stringify(meta), { mode: 0o600 });
			chmodSync(this.metaPath(meta.id), 0o600);
		} catch {
			// index still works for this process
		}
	}

	private remove(meta: StoredFile): void {
		try {
			this.index.delete(meta.id);
			for (const p of [meta.path, this.metaPath(meta.id)]) {
				if (existsSync(p)) rmSync(p, { force: true });
			}
		} catch {
			// best effort
		}
	}

	private evictIfNeeded(): void {
		let bytes = 0;
		for (const f of this.index.values()) bytes += f.size;
		if (this.index.size <= this.o.maxFiles && bytes <= this.o.maxStoreBytes) return;
		const ordered = [...this.index.values()].sort((a, b) => a.createdAt - b.createdAt);
		for (const f of ordered) {
			if (this.index.size <= this.o.maxFiles && bytes <= this.o.maxStoreBytes) break;
			this.remove(f);
			bytes -= f.size;
		}
	}

	/** Store bytes uploaded by the browser. */
	putUpload(name: unknown, declaredMime: unknown, buf: Buffer): StoreResult {
		const clean = sanitizeName(name);
		const sniff = sniffMime(clean, String(declaredMime ?? ""));
		if (!buf.length) return { ok: false, error: "empty_upload" };
		if (buf.length > this.o.maxUploadBytes) {
			return { ok: false, error: `upload_too_large (上限 ${Math.floor(this.o.maxUploadBytes / 1024)} KB)` };
		}
		const id = newId();
		const magic = sniffMagic(buf);
		let mime = sniff.mime;
		let kind: FileKind = sniff.kind;
		if (magic) {
			mime = magic;
			kind = isImageMime(magic) ? "image" : "file";
		} else if (kind === "image") {
			mime = "application/octet-stream";
			kind = "file";
		}
		const path = this.dataPath(id, kind === "image" ? mimeExt(mime) : sniff.ext);
		try {
			writeFileSync(path, buf, { mode: 0o600 });
			chmodSync(path, 0o600);
		} catch (err) {
			return { ok: false, error: `write_failed: ${err instanceof Error ? err.message : String(err)}` };
		}
		const meta: StoredFile = {
			id,
			name: clean,
			mime,
			size: buf.length,
			path,
			kind,
			createdAt: Date.now(),
			sha256: createHash("sha256").update(buf).digest("hex"),
			dir: "in",
		};
		this.index.set(id, meta);
		this.writeMeta(meta);
		this.evictIfNeeded();
		return { ok: true, file: meta };
	}

	/**
	 * Publish a file that already exists on disk (agent tool side).
	 * The resolved path must sit inside one of `roots`; symlinks are refused.
	 */
	publishFrom(absPath: unknown, roots: string[], displayName?: unknown): StoreResult {
		if (typeof absPath !== "string" || !absPath.trim()) return { ok: false, error: "缺少文件路径" };
		const max = this.o.maxPublishBytes;
		const target = resolve(absPath);
		let real: string;
		try {
			const st = lstatSync(target);
			if (st.isSymbolicLink()) return { ok: false, error: "不能发布符号链接" };
			if (!st.isFile()) return { ok: false, error: "目标不是普通文件" };
			if (st.size === 0) return { ok: false, error: "文件为空" };
			if (st.size > max) return { ok: false, error: `文件过大（上限 ${Math.floor(max / 1024 / 1024)} MB）` };
			real = realpathSync(target);
		} catch {
			return { ok: false, error: `文件不存在: ${target}` };
		}
		const allowed = roots.map((r) => resolve(r));
		const inside = allowed.some((r) => real === r || real.startsWith(r.endsWith("/") ? r : `${r}/`));
		if (!inside) {
			return { ok: false, error: `只能发布这些目录内的文件: ${allowed.join(", ")}` };
		}
		const name = sanitizeName(displayName ?? basename(real));
		const sniff = sniffMime(name, "");
		const id = newId();
		let buf: Buffer;
		try {
			// copy, so later edits to the source cannot change what the browser sees
			buf = readFileSync(real);
		} catch (err) {
			return { ok: false, error: `copy_failed: ${err instanceof Error ? err.message : String(err)}` };
		}
		const magic = sniffMagic(buf);
		let mime = magic ?? sniff.mime;
		let kind: FileKind = magic ? (isImageMime(magic) ? "image" : "file") : sniff.kind;
		if (kind === "image" && !isInlineSafeMime(mime)) {
			mime = "application/octet-stream";
			kind = "file";
		}
		const path = this.dataPath(id, kind === "image" ? mimeExt(mime) : sniff.ext);
		try {
			writeFileSync(path, buf, { mode: 0o600 });
			chmodSync(path, 0o600);
		} catch (err) {
			return { ok: false, error: `copy_failed: ${err instanceof Error ? err.message : String(err)}` };
		}
		const meta: StoredFile = {
			id,
			name,
			mime,
			size: buf.length,
			path,
			kind,
			createdAt: Date.now(),
			sha256: createHash("sha256").update(buf).digest("hex"),
			dir: "out",
		};
		this.index.set(id, meta);
		this.writeMeta(meta);
		this.evictIfNeeded();
		return { ok: true, file: meta };
	}

	get(id: unknown): StoredFile | undefined {
		if (typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id)) return undefined;
		return this.index.get(id);
	}

	/** Mark an upload as delivered to the agent (it is not replayed again). */
	markConsumed(id: string): void {
		const f = this.get(id);
		if (!f) return;
		f.consumed = true;
		this.writeMeta(f);
	}

	list(): StoredFile[] {
		return [...this.index.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	/** Drop expired entries; returns how many were removed. */
	sweep(): number {
		const now = Date.now();
		let n = 0;
		for (const f of [...this.index.values()]) {
			if (now - f.createdAt > this.o.ttlSec * 1000) {
				this.remove(f);
				n++;
			}
		}
		return n;
	}

	stats(): { count: number; bytes: number; dir: string } {
		let bytes = 0;
		for (const f of this.index.values()) bytes += f.size;
		return { count: this.index.size, bytes, dir: this.dir };
	}

	/** Remove everything (used by tests). */
	clear(): void {
		for (const f of [...this.index.values()]) this.remove(f);
	}
}
