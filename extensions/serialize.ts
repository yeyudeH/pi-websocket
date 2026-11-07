/**
 * Serializers that turn pi session objects (AgentMessage, SessionEntry, Theme)
 * into compact, JSON-safe wire payloads for WebSocket clients.
 *
 * Everything is defensive: pi types evolve, extensions run duck-typed at runtime.
 */
import type { WireMessage, WireTheme, WireImage, WireHistoryEntry } from "./protocol";

const MAX_TEXT_CHARS = 100_000;
const MAX_ARGS_CHARS = 32_000;
const MAX_SUMMARY_CHARS = 8_000;
const MAX_DETAILS_CHARS = 16_384;

function isTruncated(text: string, max: number): boolean {
	return text.length > max;
}

function cap(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	return { text: `${text.slice(0, max)}\n…[truncated by pi-websocket]`, truncated: true };
}

/** Lets index.ts map an in-session base64 image back to a stored upload (/f/<id>). */
export type ImageResolver = (base64: string, mimeType: string) => { url: string } | undefined;

/** Convert message content (string or block array) to plain text + image metadata. */
function contentToText(content: unknown, resolve?: ImageResolver): { text: string; images: WireImage[] } {
	if (typeof content === "string") return { text: content, images: [] };
	if (!Array.isArray(content)) return { text: "", images: [] };
	const parts: string[] = [];
	const images: WireImage[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (b.type === "image") {
			const data = typeof b.data === "string" ? b.data : "";
			const img: WireImage = { mimeType: String(b.mimeType ?? "image/png"), bytes: data.length };
			const link = resolve?.(data, String(b.mimeType ?? "image/png"));
			if (link?.url) img.url = link.url;
			images.push(img);
		}
	}
	return { text: parts.join("\n"), images };
}

function stringifyArgs(args: unknown): { text: string; truncated: boolean } {
	let raw: string;
	try {
		raw = JSON.stringify(args ?? {}, null, 2) ?? "{}";
	} catch {
		raw = String(args);
	}
	return cap(raw, MAX_ARGS_CHARS);
}

/** Round-trip a value through JSON so it is guaranteed serializable; drop if too big. */
function sanitizeDetails(details: unknown): unknown {
	if (details === undefined || details === null) return undefined;
	try {
		const s = JSON.stringify(details);
		if (typeof s !== "string" || s.length > MAX_DETAILS_CHARS) return undefined;
		return JSON.parse(s);
	} catch {
		return undefined;
	}
}

/**
 * Serialize an AgentMessage into a compact wire message.
 * Returns null for messages clients should not see (system messages).
 */
export function serializeMessage(msg: unknown, resolve?: ImageResolver): WireMessage | null {
	if (!msg || typeof msg !== "object") return null;
	const m = msg as Record<string, any>;
	const timestamp = typeof m.timestamp === "number" ? m.timestamp : Date.now();

	switch (m.role) {
		case "user": {
			const { text, images } = contentToText(m.content, resolve);
			const capped = cap(text, MAX_TEXT_CHARS);
			const out: Record<string, unknown> = {
				role: "user",
				text: capped.text,
				timestamp,
			};
			if (capped.truncated) out.truncated = true;
			if (images.length) out.images = images;
			return out as WireMessage;
		}

		case "assistant": {
			const blocks: Record<string, unknown>[] = [];
			if (Array.isArray(m.content)) {
				for (const raw of m.content) {
					if (!raw || typeof raw !== "object") continue;
					const b = raw as Record<string, any>;
					if (b.type === "text" && typeof b.text === "string") {
						const c = cap(b.text, MAX_TEXT_CHARS);
						blocks.push({ type: "text", text: c.text, ...(c.truncated ? { truncated: true } : {}) });
					} else if (b.type === "thinking") {
						const c = cap(String(b.thinking ?? ""), MAX_TEXT_CHARS);
						blocks.push({
							type: "thinking",
							text: c.text,
							...(b.redacted ? { redacted: true } : {}),
							...(c.truncated ? { truncated: true } : {}),
						});
					} else if (b.type === "toolCall") {
						const a = stringifyArgs(b.arguments);
						blocks.push({
							type: "toolCall",
							id: String(b.id ?? ""),
							name: String(b.name ?? "unknown"),
							arguments: a.text,
							...(a.truncated ? { truncated: true } : {}),
						});
					}
				}
			}
			const out: Record<string, unknown> = { role: "assistant", blocks, timestamp };
			for (const key of ["model", "provider", "responseModel", "stopReason", "thinkingLevel", "errorMessage"] as const) {
				if (m[key] !== undefined) out[key] = m[key];
			}
			if (m.usage && typeof m.usage === "object") {
				out.usage = {
					input: m.usage.input ?? 0,
					output: m.usage.output ?? 0,
					cacheRead: m.usage.cacheRead ?? 0,
					cacheWrite: m.usage.cacheWrite ?? 0,
					totalTokens: m.usage.totalTokens ?? 0,
					costTotal: m.usage.cost?.total,
				};
			}
			return out as WireMessage;
		}

		case "toolResult": {
			const { text } = contentToText(m.content);
			const c = cap(text, MAX_TEXT_CHARS);
			const out: Record<string, unknown> = {
				role: "toolResult",
				toolCallId: String(m.toolCallId ?? ""),
				toolName: String(m.toolName ?? "unknown"),
				isError: Boolean(m.isError),
				text: c.text,
				timestamp,
			};
			if (c.truncated) out.truncated = true;
			const details = sanitizeDetails(m.details);
			if (details !== undefined) out.details = details;
			return out as WireMessage;
		}

		case "custom": {
			const { text } = contentToText(m.content);
			const c = cap(text, MAX_TEXT_CHARS);
			return {
				role: "custom",
				customType: String(m.customType ?? ""),
				text: c.text,
				display: Boolean(m.display),
				timestamp,
			} as WireMessage;
		}

		case "bashExecution": {
			const c = cap(String(m.output ?? ""), MAX_TEXT_CHARS);
			return {
				role: "bashExecution",
				command: String(m.command ?? ""),
				exitCode: m.exitCode,
				cancelled: Boolean(m.cancelled),
				excludeFromContext: Boolean(m.excludeFromContext),
				text: c.text,
				timestamp,
			} as WireMessage;
		}

		case "branchSummary":
			return { role: "branchSummary", text: cap(String(m.summary ?? ""), MAX_SUMMARY_CHARS).text, timestamp } as WireMessage;

		case "compactionSummary":
			return {
				role: "compactionSummary",
				text: cap(String(m.summary ?? ""), MAX_SUMMARY_CHARS).text,
				tokensBefore: m.tokensBefore,
				timestamp,
			} as WireMessage;

		case "system":
			return null;

		default:
			return { role: String(m.role ?? "unknown"), timestamp } as WireMessage;
	}
}

/** Concatenate all text (or thinking) blocks of a partial assistant message, for delta math. */
export function concatAssistantBlocks(msg: unknown, kind: "text" | "thinking"): string {
	if (!msg || typeof msg !== "object") return "";
	const m = msg as Record<string, any>;
	if (!Array.isArray(m.content)) return "";
	let out = "";
	for (const raw of m.content) {
		if (!raw || typeof raw !== "object") continue;
		const b = raw as Record<string, any>;
		if (kind === "text" && b.type === "text" && typeof b.text === "string") out += b.text;
		if (kind === "thinking" && b.type === "thinking" && typeof b.thinking === "string") out += b.thinking;
	}
	return out;
}

/**
 * Serialize a SessionEntry for history replay.
 * Returns null for entries clients do not need (usage, label, context_edit, custom state).
 */
export function serializeEntry(entry: unknown, resolve?: ImageResolver): WireHistoryEntry | null {
	if (!entry || typeof entry !== "object") return null;
	const e = entry as Record<string, any>;
	const base = { id: String(e.id ?? ""), timestamp: String(e.timestamp ?? "") };

	switch (e.type) {
		case "message": {
			const message = serializeMessage(e.message, resolve);
			if (!message) return null;
			return { kind: "message", ...base, message };
		}
		case "custom_message": {
			const { text } = contentToText(e.content);
			return { kind: "custom_message", ...base, customType: String(e.customType ?? ""), text, display: Boolean(e.display) };
		}
		case "compaction":
			return { kind: "compaction", ...base, text: cap(String(e.summary ?? ""), MAX_SUMMARY_CHARS).text, tokensBefore: e.tokensBefore };
		case "branch_summary":
			return { kind: "branch_summary", ...base, text: cap(String(e.summary ?? ""), MAX_SUMMARY_CHARS).text };
		case "model_change":
			return { kind: "model_change", ...base, provider: e.provider, modelId: e.modelId };
		case "thinking_level_change":
			return { kind: "thinking_level_change", ...base, thinkingLevel: e.thinkingLevel };
		case "session_info":
			return { kind: "session_info", ...base, name: e.name };
		default:
			return null;
	}
}

const ANSI_16 = [
	"#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
	"#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
];

function hex2(n: number): string {
	const v = Math.max(0, Math.min(255, Math.round(n)));
	return v.toString(16).padStart(2, "0");
}

/** Standard xterm-256 palette (indices 16-255) as CSS hex. */
function xterm256Css(i: number): string | undefined {
	if (i < 16) return ANSI_16[i];
	if (i >= 232) {
		const g = 8 + (i - 232) * 10;
		return `#${hex2(g)}${hex2(g)}${hex2(g)}`;
	}
	const n = i - 16;
	const r = Math.floor(n / 36) % 6;
	const g = Math.floor(n / 6) % 6;
	const b = n % 6;
	const ch = (v: number) => (v === 0 ? 0 : 55 + v * 40);
	return `#${hex2(ch(r))}${hex2(ch(g))}${hex2(ch(b))}`;
}

/** Oklch -> sRGB (CSS oklch() is not universally supported in browsers yet). */
function oklchToCss(l: number, c: number, h: number): string | undefined {
	try {
		const hr = (h * Math.PI) / 180;
		const a = c * Math.cos(hr);
		const b = c * Math.sin(hr);
		const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
		const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
		const s_ = l - 0.0894841775 * a - 1.291485548 * b;
		const l3 = l_ ** 3, m3 = m_ ** 3, s3 = s_ ** 3;
		let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
		let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
		let bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
		const gam = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
		const cl = (x: number) => Math.max(0, Math.min(1, x));
		return `#${hex2(gam(cl(r)) * 255)}${hex2(gam(cl(g)) * 255)}${hex2(gam(cl(bl)) * 255)}`;
	} catch {
		return undefined;
	}
}

function num(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function colorToCss(v: unknown): string | undefined {
	if (typeof v === "string") {
		const s = v.trim();
		if (s === "") return undefined;
		if (s.startsWith("#") || /^(rgb|rgba|hsl|hsla|oklch|okhsl)\(/i.test(s)) return s;
		return undefined;
	}
	if (num(v)) return v >= 0 && v < 256 ? xterm256Css(Math.trunc(v)) : undefined;
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		if (typeof o.hex === "string") return o.hex;
		if (typeof o.css === "string") return o.css;
		// pi-tui Color: { kind: "rgb", r, g, b } | { kind: "indexed", index } | { kind: "oklch", l, c, h }
		if (o.kind === "rgb" && num(o.r) && num(o.g) && num(o.b)) return `#${hex2(o.r)}${hex2(o.g)}${hex2(o.b)}`;
		if (o.kind === "indexed" && num(o.index)) return xterm256Css(Math.trunc(o.index));
		if (o.kind === "oklch" && num(o.l) && num(o.c) && num(o.h)) return oklchToCss(o.l, o.c, o.h);
	}
	return undefined;
}

/** Best-effort theme serialization: name, appearance, and colors as CSS strings. */
export function serializeTheme(theme: unknown): WireTheme | undefined {
	if (!theme || typeof theme !== "object") return undefined;
	try {
		const t = theme as Record<string, any>;
		const out: WireTheme = {};
		if (typeof t.name === "string") out.name = t.name;
		if (typeof t.appearance === "string") out.appearance = t.appearance;
		const src = (t.colors && typeof t.colors === "object" ? t.colors : t) as Record<string, unknown>;
		const colors: Record<string, string> = {};
		for (const [k, v] of Object.entries(src)) {
			const css = colorToCss(v);
			if (css) colors[k] = css;
		}
		if (Object.keys(colors).length) out.colors = colors;
		return out.name || out.appearance || out.colors ? out : undefined;
	} catch {
		return undefined;
	}
}

/** Cap an arbitrary small text (input echo, model names). */
export function capText(text: string, max = 4_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 工具执行过程中的增量输出：pi 的 `tool_execution_update` 把局部结果放在
 * `partialResult.content[].text`（bash 就是这样每 100ms 吐一次）。把它抽成纯文本，
 * 让网页在长任务运行过程中就能看到进度，而不是等它结束。
 */
export function partialToText(partial: unknown): string {
	if (partial == null) return "";
	if (typeof partial === "string") return partial;
	const c = (partial as Record<string, any>).content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		let out = "";
		for (const raw of c) {
			if (typeof raw === "string") out += raw;
			else if (raw && typeof raw === "object" && raw.type === "text" && typeof raw.text === "string") out += raw.text;
		}
		return out;
	}
	return "";
}

/** 只送尾部：工具输出越新越有用；被砍掉的字符数回给客户端，好标注“前 N 字符已省略”。 */
export function tailText(text: string, max = 3_000): { text: string; dropped: number } {
	if (text.length <= max) return { text, dropped: 0 };
	return { text: text.slice(text.length - max), dropped: text.length - max };
}
