import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2000;

export interface GitCommitInfo {
	oid: string | null;
	detached: boolean;
	tag: string | null;
}

export interface GitStatus {
	branch: string | undefined;
	ahead: number;
	behind: number;
	modified: number;
	untracked: number;
	staged: number;
	stashed: number;
	conflicted: number;
	renamed: number;
	deleted: number;
	commit: GitCommitInfo | null;
}

export function emptyGitStatus(): GitStatus {
	return {
		branch: undefined,
		ahead: 0,
		behind: 0,
		modified: 0,
		untracked: 0,
		staged: 0,
		stashed: 0,
		conflicted: 0,
		renamed: 0,
		deleted: 0,
		commit: null,
	};
}

async function gitExec(args: string[], cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		return stdout;
	} catch {
		return null;
	}
}

export async function readGitStatus(
	cwd: string,
	options: { readCommit?: boolean; readTag?: boolean; readCounts?: boolean } = {},
): Promise<GitStatus> {
	const stdout = await gitExec(
		["status", "--porcelain=v1", "--branch", "--show-stash"],
		cwd,
	);
	if (stdout === null) {
		return emptyGitStatus();
	}

	const status = emptyGitStatus();
	const lines = stdout.split("\n");
	let stashSupported = true;

	for (const line of lines) {
		if (line.startsWith("## ")) {
			const branchPart = line.slice(3);
			const detached = branchPart.startsWith("HEAD (no branch)");
			if (detached) {
				status.branch = undefined;
				status.commit = { oid: null, detached: true, tag: null };
			} else {
				const branchMatch = branchPart.match(/^(\S+?)(?:\.\.\.(\S+))?(?:\s+\[(ahead|behind) (\d+)\])?$/);
				if (branchMatch) {
					status.branch = branchMatch[1];
					if (branchMatch[3] === "ahead") status.ahead = parseInt(branchMatch[4]!, 10);
					if (branchMatch[3] === "behind") status.behind = parseInt(branchMatch[4]!, 10);
				}
			}
			continue;
		}

		if (line.startsWith("# stash ")) {
			const stashCount = parseInt(line.slice(8).trim(), 10);
			if (!Number.isNaN(stashCount)) {
				status.stashed = stashCount;
				stashSupported = true;
			}
			continue;
		}

		// ponytail: skip file-entry counting when only branch/commit display is on;
		// the first `git status` call itself can't be split, but the stash fallback below can.
		if (options.readCounts === false) continue;
		if (line.length < 3) continue;
		const x = line[0]!;
		const y = line[1]!;

		if (x === "U" || y === "U" || (x === "C" && y === "C")) status.conflicted++;
		else if (x === "?" && y === "?") status.untracked++;
		else if (x === "R") status.renamed++;
		else if (x === "D" || y === "D") status.deleted++;
		else {
			if (x !== " " && x !== "?") status.staged++;
			if (y === "M" || y === "D") status.modified++;
		}
	}

	if (options.readCounts !== false && stashSupported && status.stashed === 0 && !stdout.includes("# stash")) {
		const stashOut = await gitExec(["stash", "list", "--count"], cwd);
		if (stashOut !== null) {
			const count = parseInt(stashOut.trim(), 10);
			if (!Number.isNaN(count)) status.stashed = count;
		}
	}

	if (options.readCommit && status.commit?.detached) {
		const oid = await gitExec(["rev-parse", "HEAD"], cwd);
		if (oid) {
			status.commit.oid = oid.trim();
		}
		if (options.readTag) {
			const tag = await gitExec(["describe", "--tags", "--exact-match", "HEAD"], cwd);
			if (tag) {
				status.commit.tag = tag.trim();
			}
		}
	}

	return status;
}

export function hasGitChanges(s: GitStatus): boolean {
	return (
		s.modified > 0 ||
		s.untracked > 0 ||
		s.staged > 0 ||
		s.conflicted > 0 ||
		s.renamed > 0 ||
		s.deleted > 0 ||
		s.ahead > 0 ||
		s.behind > 0
	);
}
