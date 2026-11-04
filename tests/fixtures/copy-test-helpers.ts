import assert from "node:assert/strict";
import { Session, type Runtime } from "node:inspector";
import { getMarkdownTheme, initTheme, type MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { Markdown, ProcessTerminal, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installCopyButtons, markCopyScope, type CopyRegion } from "../../extensions/open-tui/copy-buttons.ts";
import { stripAnsi } from "../../extensions/open-tui/utils.ts";

export const textA = "const a = 1;";
export const textB = "const b = 2;";
export const blockA = "```ts\n" + textA + "\n```\n\nTail";
export const blockB = "```ts\n" + textB + "\n```\n\nTail";
export const nestedCode = "```make\nall:\n   echo hi\n```\n\n- build\n\n  ```make\n  all:\n  \techo hi\n  ```\n\n> ```sh\n> echo 🙂\n> ```\n\nTail";
export const nestedText = ["all:\n   echo hi", "all:\n\techo hi", "echo 🙂"];

export function installRealCopyButtons() {
	initTheme("dark", false);
	const tui = new TuiAltScreen(new ProcessTerminal(), false);
	let enabled = true;
	const copy = installCopyButtons({ getTui: () => tui, getTheme: () => theme, isEnabled: () => enabled });
	return { tui, copy, enable(value: boolean) { enabled = value; copy.refresh(); } };
}

export function copyMarkdown(text: string, context: Partial<MarkdownTransformContext> = {}) {
	const state: MarkdownTransformContext = { messageType: "assistant", isStreaming: false, availableWidth: 0, ...context };
	return { component: new Markdown(text, 1, 0, getMarkdownTheme(), undefined, { transform: (source) => markCopyScope(source, state) }), state };
}

export function assertMarkdownCopy(component: Markdown, expected: readonly string[], width = 60) {
	const lines = component.render(width);
	const state = readMarkdownCopyState(component);
	assert.deepEqual(state.regions.map((region) => region.text), expected);
	assert.ok(lines.every((line) => visibleWidth(line) <= width));
	assert.ok(lines.every((line) => !line.includes("\x1b_open-tui:")), "internal anchors must not reach output");
	for (const region of state.regions) {
		const line = stripAnsi(lines[region.row]!);
		const label = line.lastIndexOf("[Copy]");
		assert.ok(label >= 0);
		assert.equal(region.col, visibleWidth(line.slice(0, label)));
		assert.equal(region.width, 6);
	}
	return { lines, state };
}

export interface MarkdownCopyState {
	regions: CopyRegion[];
	descriptorCount?: number;
	nextId?: number;
	pressed: boolean;
}

/** Read the installed wrapper's actual state without adding a product debug interface. */
export function readMarkdownCopyState(owner: Markdown): MarkdownCopyState {
	const inspector = new Session();
	inspector.connect();
	const globals = globalThis as typeof globalThis & { __openTuiCopyProbeOwner?: Markdown; __openTuiCopyProbeHandler?: unknown };
	globals.__openTuiCopyProbeOwner = owner;
	globals.__openTuiCopyProbeHandler = Reflect.get(Markdown.prototype, "handleMouse");
	const post = <T>(method: string, params: Record<string, unknown>): T => {
		let result: T | undefined;
		let failure: Error | null = null;
		inspector.post(method, params, (error, value) => { failure = error; result = value as T; });
		assert.ifError(failure);
		assert.ok(result, "the local inspector must respond synchronously");
		return result;
	};
	try {
		const handler = post<Runtime.EvaluateReturnType>("Runtime.evaluate", { expression: "globalThis.__openTuiCopyProbeHandler" }).result;
		assert.ok(handler.objectId);
		const scopes = post<Runtime.GetPropertiesReturnType>("Runtime.getProperties", { objectId: handler.objectId })
			.internalProperties?.find((property) => property.name === "[[Scopes]]")?.value;
		assert.ok(scopes?.objectId);
		let regionMapId: string | undefined;
		let pressId: string | undefined;
		for (const scope of post<Runtime.GetPropertiesReturnType>("Runtime.getProperties", { objectId: scopes.objectId }).result) {
			if (!scope.value?.objectId) continue;
			const properties = post<Runtime.GetPropertiesReturnType>("Runtime.getProperties", { objectId: scope.value.objectId }).result;
			regionMapId ??= properties.find((property) => property.name === "markdownRegions")?.value?.objectId;
			pressId ??= properties.find((property) => property.name === "press")?.value?.objectId;
		}
		assert.ok(regionMapId, "the installed mouse wrapper must retain its actual region map");
		const snapshot = post<Runtime.CallFunctionOnReturnType>("Runtime.callFunctionOn", {
			objectId: regionMapId,
			functionDeclaration: "function() { const state = this.get(globalThis.__openTuiCopyProbeOwner); return { regions: state?.regions ?? [], descriptorCount: state?.descriptors?.size, nextId: state?.nextId }; }",
			returnByValue: true,
		});
		assert.equal(snapshot.exceptionDetails, undefined);
		const pressed = pressId ? post<Runtime.CallFunctionOnReturnType>("Runtime.callFunctionOn", {
			objectId: pressId, functionDeclaration: "function() { return this.owner === globalThis.__openTuiCopyProbeOwner; }", returnByValue: true,
		}).result.value === true : false;
		return { ...snapshot.result.value as Omit<MarkdownCopyState, "pressed">, pressed };
	} finally {
		delete globals.__openTuiCopyProbeOwner;
		delete globals.__openTuiCopyProbeHandler;
		inspector.disconnect();
	}
}
