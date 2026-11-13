import { readGitStatus, type GitStatus } from "./git.ts";

const GIT_REFRESH_INTERVAL_MS = 500;
type GitReadOptions = NonNullable<Parameters<typeof readGitStatus>[1]>;

interface GitRefreshRequest {
	cwd: string;
	options: GitReadOptions;
	immediate: boolean;
}

/** Serial Git reads with a leading refresh and a guaranteed trailing refresh. */
export class GitStatusRefresher {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pending: GitRefreshRequest | undefined;
	private inFlight = false;
	private generation = 0;
	private lastStarted = -Infinity;
	private readonly onRefresh: (git: GitStatus) => void;

	constructor(onRefresh: (git: GitStatus) => void) {
		this.onRefresh = onRefresh;
	}

	request(cwd: string, options: GitReadOptions, immediate = false): void {
		this.pending = {
			cwd,
			options: { ...options },
			immediate: immediate || this.pending?.immediate === true,
		};
		this.schedule();
	}

	/** Flush only queued work; a tool-free agent run needs no additional read. */
	flush(): void {
		if (!this.pending) return;
		this.pending.immediate = true;
		this.schedule();
	}

	/** Invalidate old results without allowing a second read to overlap them. */
	reset(): void {
		this.generation++;
		this.clearTimer();
		this.pending = undefined;
		this.lastStarted = -Infinity;
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private schedule(): void {
		if (this.inFlight || !this.pending) return;
		const delay = this.pending.immediate
			? 0
			: Math.max(0, GIT_REFRESH_INTERVAL_MS - (performance.now() - this.lastStarted));
		if (delay === 0) {
			this.clearTimer();
			void this.refresh();
		} else if (this.timer === undefined) {
			// Further requests update pending work without postponing this deadline.
			this.timer = setTimeout(() => {
				this.timer = undefined;
				void this.refresh();
			}, delay);
			this.timer.unref();
		}
	}

	private async refresh(): Promise<void> {
		const request = this.pending;
		if (this.inFlight || !request) return;
		this.pending = undefined;
		this.inFlight = true;
		this.lastStarted = performance.now();
		const generation = this.generation;
		try {
			const git = await readGitStatus(request.cwd, request.options);
			if (generation === this.generation) this.onRefresh(git);
		} finally {
			this.inFlight = false;
			this.schedule();
		}
	}
}
