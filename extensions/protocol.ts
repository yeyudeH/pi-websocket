/**
 * Wire protocol shared between the pi-websocket extension and its clients.
 *
 * Every server -> client message is a JSON object:
 *   { v: 1, t: <unix ms>, type: "<event>", ...payload }
 *
 * Client -> server messages:
 *   { type: "subscribe", stream?: boolean }                     choose granularity
 *   { type: "user_message", text: string, deliverAs?: "steer" | "followUp",
 *       attachments?: string[] }                               ids from POST /api/upload
 *   { type: "command", action: string, arg?: string, id?: number, confirm?: boolean }
 *       session control on a whitelist: state | files | commands | models | model_set |
 *       thinking_set | tools_get | tools_set | compact | reload | new | exec
 *       (`reload` / `new` also need confirm: true; `exec` needs config allowExec)
 *   { type: "ping", id?: number }
 *   { type: "get_theme" }
 *
 * Files cross both ways over HTTP on the same port (session cookie required):
 *   POST /api/upload   browser -> agent   (raw body, x-file-name header)
 *   GET  /f/<id>       agent -> browser   (published by send_image_to_web / send_file_to_web)
 *   GET  /api/files    list what is stored
 */

export const PROTOCOL_VERSION = 1;

/** Server -> client event type names (see client/index.html for shapes). */
export type ServerEventType =
	| "hello"
	| "theme"
	| "history"
	| "history_end"
	| "message_start"
	| "message_update"
	| "message_end"
	| "stream"
	| "input"
	| "tool_call"
	| "tool_result"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "agent_start"
	| "agent_end"
	| "agent_settled"
	| "turn_start"
	| "turn_end"
	| "session_start"
	| "session_info_changed"
	| "model_select"
	| "thinking_level_select"
	| "session_compact"
	| "session_compact_failed"
	| "state"
	| "models"
	| "commands"
	| "command_result"
	| "files"
	| "file_ready"
	| "subscribed"
	| "ack"
	| "error"
	| "pong";

export interface WireEnvelope {
	v: number;
	t: number;
	type: ServerEventType | string;
	[key: string]: unknown;
}

export interface WireTheme {
	name?: string;
	appearance?: string;
	colors?: Record<string, string>;
}

export interface WireImage {
	mimeType: string;
	bytes: number;
	/** Same-origin path to the stored upload, when the extension still has the file. */
	url?: string;
}

export interface WireTextBlock {
	type: "text";
	text: string;
	truncated?: boolean;
}

export interface WireThinkingBlock {
	type: "thinking";
	text: string;
	redacted?: boolean;
}

export interface WireToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: string;
	truncated?: boolean;
}

export type WireAssistantBlock = WireTextBlock | WireThinkingBlock | WireToolCallBlock;

export interface WireUserMessage {
	role: "user";
	text: string;
	truncated?: boolean;
	images?: WireImage[];
	timestamp: number;
}

export interface WireAssistantMessage {
	role: "assistant";
	model?: string;
	provider?: string;
	responseModel?: string;
	stopReason?: string;
	thinkingLevel?: string;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		costTotal?: number;
	};
	blocks: WireAssistantBlock[];
	errorMessage?: string;
	timestamp: number;
}

export interface WireToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	isError: boolean;
	text: string;
	truncated?: boolean;
	timestamp: number;
}

export interface WireGenericMessage {
	role: string;
	timestamp: number;
	[key: string]: unknown;
}

export type WireMessage = WireUserMessage | WireAssistantMessage | WireToolResultMessage | WireGenericMessage;

export interface WireHistoryEntry {
	kind: string;
	id: string;
	timestamp: string;
	[key: string]: unknown;
}
