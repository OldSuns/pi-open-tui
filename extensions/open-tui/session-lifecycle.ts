export class SessionLifecycle {
	private current = 0;
	private shutDown = false;

	start(): void {
		this.current++;
		this.shutDown = false;
	}

	shutdown(): void {
		this.shutDown = true;
	}

	isCurrent(generation?: number): boolean {
		if (this.shutDown) return false;
		if (generation === undefined) return true;
		return generation === this.current;
	}

	currentGeneration(): number {
		return this.current;
	}
}
