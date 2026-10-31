import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionAPI, Theme, ThemeColor, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Spacer, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolViewMode } from "./config.ts";
import type { IconGlyphs } from "./icons.ts";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];
type ToolResult = Parameters<RenderResult>[0];
type Args = Record<string, unknown>;

const TOOL_LABELS: Record<string, string> = {
	read: "Read",
	bash: "Bash",
	powershell: "PowerShell",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Find",
	ls: "LS",
};
const LIVE_TAIL_LINES = 3;

/** Per-row slots: Pi's native renderers keep their own state and components here. */
interface RowState {
	nativeState: Record<string, unknown>;
	nativeCall?: Component;
	nativeResult?: Component;
	callCard?: Box;
	callCardBottom?: Spacer;
	resultCard?: Box;
	startedAt?: number;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * Streaming shell output arrives raw: drop escape sequences and control characters as Pi does,
 * and keep only the text after a lone `\r` so progress bars show their latest frame.
 */
function cleanOutput(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			const frames = line.replace(/\r+$/, "");
			return frames.slice(frames.lastIndexOf("\r") + 1);
		})
		.join("\n")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

export function textOutput(result: ToolResult): string {
	return cleanOutput(result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n"));
}

/** Drops Pi's trailing `[...]` notice (truncation, limits, continuation hints) and the blank line before it. */
export function stripNotice(text: string): string {
	return text.replace(/\n\n\[[^\n]*\]\s*$/, "").replace(/\n+$/, "");
}

function countLines(text: string): number {
	return text ? text.split("\n").length : 0;
}

export function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** First command line, with a `… (+N lines)` hint for multi-line commands. */
export function firstLine(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
	const head = lines[0] ?? "";
	return lines.length > 1 ? `${head} … (+${lines.length - 1} lines)` : head;
}

export function tailLines(text: string, count: number): string[] {
	const lines = cleanOutput(text).split("\n").filter((line) => line.trim() !== "");
	return lines.slice(-count);
}

/** `rel` when `path` is `base` or inside it; undefined for siblings such as `/home/sam-old`. */
function inside(base: string, path: string): string | undefined {
	const rel = relative(base, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.split(sep).join("/") : undefined;
}

export function displayPath(path: string, cwd: string, home = homedir()): string {
	if (!path || !isAbsolute(path)) return path;
	const inCwd = inside(cwd, path);
	if (inCwd) return inCwd;
	const inHome = inside(home, path);
	return inHome === undefined ? path : inHome ? `~/${inHome}` : "~";
}

function lineRange(offset: unknown, limit: unknown): string {
	if (typeof offset !== "number" && typeof limit !== "number") return "";
	const start = typeof offset === "number" ? offset : 1;
	return typeof limit === "number" ? `:${start}-${start + limit - 1}` : `:${start}`;
}

/** The single key argument shown inside `Tool(...)`. */
export function callDetail(toolName: string, args: Args, cwd: string): string {
	const path = displayPath(str(args.file_path ?? args.path), cwd);
	switch (toolName) {
		case "read":
			return path + lineRange(args.offset, args.limit);
		case "edit":
		case "write":
			return path;
		case "bash":
		case "powershell":
			return firstLine(str(args.command));
		case "grep": {
			const pattern = str(args.pattern);
			return pattern ? `/${pattern}/${path ? ` in ${path}` : ""}` : path;
		}
		case "find": {
			const pattern = str(args.pattern);
			return pattern && path ? `${pattern} in ${path}` : pattern || path;
		}
		case "ls":
			return path || ".";
		default:
			return "";
	}
}

function details(result: ToolResult): Record<string, unknown> {
	const value: unknown = result.details;
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function truncation(result: ToolResult): { truncated: boolean; totalLines?: number } {
	const value = details(result).truncation;
	if (typeof value !== "object" || value === null) return { truncated: false };
	const { truncated, totalLines } = value as { truncated?: unknown; totalLines?: unknown };
	return { truncated: truncated === true, totalLines: typeof totalLines === "number" ? totalLines : undefined };
}

/** Keeps the hint that a result is incomplete, which stripNotice drops from the text. */
function incomplete(result: ToolResult): string {
	const info = details(result);
	const limit = ["matchLimitReached", "resultLimitReached", "entryLimitReached"].some((key) => info[key] !== undefined);
	return (limit ? " · limit reached" : "") + (truncation(result).truncated ? " · truncated" : "");
}

/** Line count of shell output plus any incomplete-result hint. */
function shellLines(output: string, result: ToolResult): string {
	const text = output.trim();
	const lines = text === "(no output)" ? 0 : truncation(result).totalLines ?? countLines(text);
	return (lines === 0 ? "no output" : plural(lines, "line")) + incomplete(result);
}

/** One-line result summary for a finished, successful call. */
export function summarizeResult(toolName: string, result: ToolResult, args: Args): string {
	const raw = textOutput(result);
	const text = stripNotice(raw);
	switch (toolName) {
		case "read": {
			if (result.content.some((block) => block.type === "image")) return "image";
			// An explicit `limit` that stops early adds this notice without setting details.truncation.
			const more = /\n\n\[\d+ more lines in file\.[^\n]*\]\s*$/.test(raw) ? " · more" : "";
			return plural(countLines(text), "line") + incomplete(result) + more;
		}
		case "bash":
		case "powershell":
			return `Done · ${shellLines(text, result)}`;
		case "edit": {
			const diff = details(result).diff;
			if (typeof diff !== "string") return "Edited";
			const { added, removed } = diffStats(diff);
			return `+${added} −${removed}`;
		}
		case "write":
			return `${plural(countLines(str(args.content).replace(/\n$/, "")), "line")} written`;
		case "grep": {
			if (text === "No matches found") return "No matches";
			const files = new Set<string>();
			let matches = 0;
			for (const line of text.split("\n")) {
				const match = /^(.+?):\d+: /.exec(line);
				if (!match) continue;
				matches++;
				files.add(match[1]!);
			}
			return `${plural(matches, "match", "matches")} in ${plural(files.size, "file")}${incomplete(result)}`;
		}
		case "find":
			return text === "No files found matching pattern" ? "No files" : plural(countLines(text), "file") + incomplete(result);
		case "ls":
			return text === "(empty directory)" ? "Empty" : plural(countLines(text), "entry", "entries") + incomplete(result);
		default:
			return "";
	}
}

/** One-line summary for a failed call: the shell's closing status, otherwise the error's first line. */
export function summarizeError(toolName: string, result: ToolResult): string {
	const text = textOutput(result).trim();
	// Pi ends failed shell output with "Command exited with code N", "Command aborted", etc.
	const status = toolName === "bash" || toolName === "powershell" ? /(?:^|\n\n)Command ([^\n]+)$/.exec(text) : null;
	if (status) {
		const reason = status[1]!;
		return `${reason[0]!.toUpperCase()}${reason.slice(1)} · ${shellLines(stripNotice(text.slice(0, status.index)), result)}`;
	}
	return text.split("\n").find((line) => line.trim())?.trim() ?? "Failed";
}

function formatElapsed(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Lines truncated to the render width; rebuilt on every render call. */
function lines(build: (width: number) => string[]): Component {
	return {
		render: (width) => build(width).map((line) => truncateToWidth(line, Math.max(1, width), "…")),
		invalidate() {},
	};
}

function rowState(context: RenderContext): RowState {
	const state = context.state as Partial<RowState>;
	state.nativeState ??= {};
	return state as RowState;
}

function nativeContext(context: RenderContext, row: RowState, lastComponent: Component | undefined): RenderContext {
	return { ...context, state: row.nativeState, lastComponent };
}

function statusBg(theme: Theme, context: RenderContext): (text: string) => string {
	const bg = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
	return (text) => theme.bg(bg, text);
}

export function createCompactRenderers(
	toolName: string,
	native: ToolRenderers,
	glyphs: () => IconGlyphs,
): ToolRenderers {
	const label = TOOL_LABELS[toolName] ?? toolName;
	const isShell = toolName === "bash" || toolName === "powershell";
	// Expanded rows hand off to Pi's own card so nothing is hidden.
	const showNative = (context: RenderContext) => context.expanded;

	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			const row = rowState(context);
			// Always run the native renderer so its own state (timers, edit preview) stays current.
			row.nativeCall = native.renderCall?.(args, theme, nativeContext(context, row, row.nativeCall));
			if (context.executionStarted) row.startedAt ??= Date.now();
			if (showNative(context) && row.nativeCall) {
				if (native.renderShell === "self") return row.nativeCall;
				// Recreate Pi's default card: top padding, call, then result (or bottom padding while pending).
				row.callCard ??= new Box(context.outputPad, 0);
				row.callCardBottom ??= new Spacer(1);
				row.callCard.setBgFn(statusBg(theme, context));
				row.callCard.setPaddingX(context.outputPad);
				row.callCard.clear();
				row.callCard.addChild(new Spacer(1));
				row.callCard.addChild(row.nativeCall);
				row.callCard.addChild(row.callCardBottom);
				return row.callCard;
			}
			const color: ThemeColor = context.isError ? "error" : context.isPartial ? "warning" : "success";
			const detail = callDetail(toolName, (args ?? {}) as Args, context.cwd);
			const pad = " ".repeat(context.outputPad);
			return lines(() => [
				pad + theme.fg(color, glyphs().toolCall) + " " + theme.fg("toolTitle", theme.bold(label))
					+ (detail ? theme.fg("muted", `(${detail})`) : ""),
			]);
		},

		renderResult(result, options, theme, context) {
			const row = rowState(context);
			row.nativeResult = native.renderResult?.(result, options, theme, nativeContext(context, row, row.nativeResult));
			if (showNative(context) && row.nativeResult) {
				if (native.renderShell === "self") return row.nativeResult;
				// The result now closes the card, so the call card drops its pending bottom padding.
				if (row.callCard && row.callCardBottom) row.callCard.removeChild(row.callCardBottom);
				row.resultCard ??= new Box(context.outputPad, 0);
				row.resultCard.setBgFn(statusBg(theme, context));
				row.resultCard.setPaddingX(context.outputPad);
				row.resultCard.clear();
				row.resultCard.addChild(row.nativeResult);
				row.resultCard.addChild(new Spacer(1));
				return row.resultCard;
			}
			const pad = " ".repeat(context.outputPad);
			const args = (context.args ?? {}) as Args;
			return lines(() => {
				const { toolResult } = glyphs();
				const gutter = `${pad}  ${theme.fg("dim", toolResult)}  `;
				const indent = `${pad}  ${" ".repeat(visibleWidth(toolResult))}  `;
				if (options.isPartial) {
					if (!isShell) return [gutter + theme.fg("warning", "Running…")];
					const tail = tailLines(textOutput(result), LIVE_TAIL_LINES).map((line) => theme.fg("toolOutput", line));
					const elapsed = row.startedAt === undefined ? "" : ` ${formatElapsed(Date.now() - row.startedAt)}`;
					return [...tail, theme.fg("warning", `Running…${elapsed}`)]
						.map((line, index) => (index === 0 ? gutter : indent) + line);
				}
				const duration = isShell && context.durationMs !== undefined ? ` · ${formatElapsed(context.durationMs)}` : "";
				if (context.isError) return [gutter + theme.fg("error", summarizeError(toolName, result) + duration)];
				const summary = summarizeResult(toolName, result, args);
				if (toolName === "edit" && /^\+\d+ −\d+$/.test(summary)) {
					const [added, removed] = summary.split(" ");
					return [gutter + theme.fg("toolDiffAdded", added!) + " " + theme.fg("toolDiffRemoved", removed!)];
				}
				return [gutter + theme.fg("muted", summary + duration)];
			});
		},
	};
}

const OWNED_TOOLS = new Set(Object.keys(TOOL_LABELS));

/**
 * Display-only: Pi's tools, execution, arguments and results are untouched. The mode is read
 * when Pi builds a row, so switching it affects new rows only.
 */
export function registerToolView(pi: ExtensionAPI, getMode: () => ToolViewMode, glyphs: () => IconGlyphs): void {
	pi.registerToolRenderer((toolName, next) => {
		const native = next();
		if (!native || !OWNED_TOOLS.has(toolName) || getMode() !== "compact") return native;
		return createCompactRenderers(toolName, native, glyphs);
	});
}
