import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, rgbColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { diffWordsWithSpace } from "diff";
import { stripAnsi } from "./utils.ts";

const MAX_PREVIEW_LINES = 16;
const MAX_HIGHLIGHT_CHARS = 16_384;
const MAX_WORD_CHARS = 4_096;
const MAX_DETERMINISTIC_WORD_CHARS = 512;
const SGR = /\x1b\[([\d;]*)m/g;

type Span = { start: number; end: number };
type PreviewLine = {
	kind: " " | "+" | "-" | "gap";
	number: string;
	text: string;
	highlighted?: string;
	spans?: Span[];
};

/** Code keeps its indentation and blank lines; raw terminal controls never reach highlighting. */
export function codeLines(source: string): string[] {
	if (!source) return [];
	const clean = stripAnsi(source).replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFFF9-\uFFFB]/g, "")
		.replace(/\t/g, "   ");
	return clean.replace(/\n$/, "").split("\n");
}

function parseDiff(source: string): PreviewLine[] {
	const rows: PreviewLine[] = [];
	for (const line of codeLines(source)) {
		if (/^ +\.\.\.$/.test(line)) {
			rows.push({ kind: "gap", number: "", text: "…" });
			continue;
		}
		const match = /^([ +\-]) *(\d+) (.*)$/.exec(line);
		// A malformed result gets no guessed preview.
		if (!match) return [];
		rows.push({ kind: match[1] as PreviewLine["kind"], number: match[2]!, text: match[3]! });
	}
	return rows.some((line) => line.kind === "+" || line.kind === "-") ? rows : [];
}

function changedWords(oldLine: PreviewLine, newLine: PreviewLine): void {
	const chars = Math.max(oldLine.text.length, newLine.text.length);
	if (chars > MAX_WORD_CHARS) return;
	// Short lines have bounded input and edit distance, so scheduling cannot abort their diff.
	const options = chars <= MAX_DETERMINISTIC_WORD_CHARS
		? { maxEditLength: 256 }
		: { timeout: 5, maxEditLength: 256 };
	const changes = diffWordsWithSpace(oldLine.text, newLine.text, options);
	if (!changes) return;
	const shared = changes.filter((part) => !part.added && !part.removed)
		.reduce((count, part) => count + part.value.replace(/\s/g, "").length, 0);
	if (shared < 0.3 * Math.max(oldLine.text.trim().length, newLine.text.trim().length) || shared === 0) return;
	let oldOffset = 0;
	let newOffset = 0;
	oldLine.spans = [];
	newLine.spans = [];
	for (const part of changes) {
		if (part.removed) oldLine.spans.push({ start: oldOffset, end: oldOffset + part.value.length });
		if (part.added) newLine.spans.push({ start: newOffset, end: newOffset + part.value.length });
		if (!part.added) oldOffset += part.value.length;
		if (!part.removed) newOffset += part.value.length;
	}
}

function pairChanges(rows: PreviewLine[], shown: number): void {
	for (let i = 0; i < shown; i++) {
		if (rows[i]!.kind !== "-") continue;
		const start = i;
		while (rows[i]?.kind === "-") i++;
		const added = i;
		while (rows[i]?.kind === "+") i++;
		for (let n = 0; n < Math.min(added - start, i - added); n++) {
			if (start + n >= shown && added + n >= shown) break;
			changedWords(rows[start + n]!, rows[added + n]!);
		}
		i--;
	}
}

function highlight(rows: PreviewLine[], path: string, theme: Theme): void {
	const language = getLanguageFromPath(path);
	for (let start = 0; start < rows.length;) {
		let end = start;
		while (end < rows.length && rows[end]!.kind !== "gap") end++;
		const segment = rows.slice(start, end);
		// Highlight the two file versions independently, never as one mixed diff document.
		for (const side of ["old", "new"] as const) {
			if (side === "old" && !segment.some((line) => line.kind === "-")) continue;
			const selected = segment.filter((line) => line.kind !== (side === "old" ? "+" : "-"));
			const source = selected.map((line) => line.text).join("\n");
			// shortcut: oversized snippets use plain foreground; raise the budget only with bounded highlighting.
			const colored = language && source.length <= MAX_HIGHLIGHT_CHARS ? highlightCode(source, language) : undefined;
			const unsupported = colored?.every((line, index) => line === theme.fg("mdCodeBlock", selected[index]?.text ?? ""));
			selected.forEach((line, index) => {
				if (side === "new" || line.kind === "-") line.highlighted = !unsupported && colored?.[index] !== undefined
					? colored[index]!
					: theme.fg("toolOutput", line.text);
			});
		}
		start = end + 1;
	}
}

/** Insert word bands by UTF-16 source offsets, leaving syntax ANSI outside the offset count. */
function withBands(code: string, spans: Span[], base: string, word: string): string {
	if (spans.length === 0) return base + code.replace(SGR, (sgr, values: string) =>
		values === "" || values.split(";").some((value) => value === "0" || value === "49") ? sgr + base : sgr);
	let output = base;
	let offset = 0;
	let spanIndex = 0;
	let active = base;
	let from = 0;
	const append = (text: string) => {
		for (const char of text) {
			while (spans[spanIndex] && spans[spanIndex]!.end <= offset) spanIndex++;
			const span = spans[spanIndex];
			const next = span && span.start < offset + char.length && span.end > offset ? word : base;
			if (next !== active) output += next;
			active = next;
			output += char;
			offset += char.length;
		}
	};
	for (const match of code.matchAll(SGR)) {
		append(code.slice(from, match.index));
		output += match[0];
		// Syntax resets must restore the current band, including a word band.
		if (match[1] === "" || match[1]!.split(";").some((value) => value === "0" || value === "49")) output += active;
		from = match.index + match[0].length;
	}
	append(code.slice(from));
	return output;
}

export function prepareToolPreview(kind: "edit" | "write", source: string, path: string, theme: Theme): (width: number, indent: string) => string[] {
	const rows: PreviewLine[] = kind === "edit" ? parseDiff(source) : codeLines(source)
		.map((text, index) => ({ kind: " ", number: String(index + 1), text }));
	const shown = Math.min(rows.length, MAX_PREVIEW_LINES);
	if (kind === "edit") pairChanges(rows, shown);
	const preview = rows.slice(0, shown);
	highlight(preview, path, theme);
	const digits = preview.reduce((max, line) => Math.max(max, line.number.length), 1);
	const palette = theme.appearance === "light"
		? { "+": [[229, 245, 232], [174, 226, 185]], "-": [[255, 230, 230], [255, 188, 188]] }
		: { "+": [[26, 55, 40], [32, 96, 59]], "-": [[70, 30, 32], [124, 42, 48]] };
	const prepared = preview.map((line) => {
		const marker = kind === "edit" ? (line.kind === "gap" ? " " : line.kind) : "";
		const prefix = `${marker}${line.number.padStart(digits)} `;
		const code = theme.fg("dim", prefix) + (line.highlighted ?? theme.fg("dim", line.text));
		if (line.kind !== "+" && line.kind !== "-") return { code };
		const [normal, strong] = palette[line.kind].map(([r, g, b]) => backgroundAnsi(rgbColor(r!, g!, b!), theme.getColorMode()));
		const spans = (line.spans ?? []).map(({ start, end }) => ({ start: start + prefix.length, end: end + prefix.length }));
		return { code: withBands(code, spans, normal!, strong!), band: normal };
	});
	const hidden = rows.length - shown;
	return (width, indent) => {
		const pad = truncateToWidth(indent, Math.max(0, width), "");
		const available = Math.max(0, width - visibleWidth(pad));
		const result = prepared.map(({ code, band }) => {
			const columns = Math.max(0, available - (band ? 2 : 0));
			const clipped = truncateToWidth(code, columns, band ? `${band}…` : "…");
			return pad + (band && columns > 0
				? clipped + band + " ".repeat(Math.max(0, columns - visibleWidth(clipped))) + "\x1b[49m"
				: clipped);
		});
		if (hidden > 0) result.push(pad + theme.fg("dim", truncateToWidth(`… +${hidden} lines (ctrl+o to expand)`, available, "…")));
		return result;
	};
}
