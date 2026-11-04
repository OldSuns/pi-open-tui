import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";

export function mouseEvent(type: TuiMouseEvent["type"], x: number, y: number, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return { type, button: "left", x, y, screenX: x, screenY: y, width: 40, height: 10, shift: false, alt: false, ctrl: false, ...overrides };
}

export function temporaryDirectory(t: TestContext, prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

export function preserveEnvironment(t: TestContext, keys: readonly string[]): void {
	const previous = keys.map((key) => [key, process.env[key]] as const);
	t.after(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}
