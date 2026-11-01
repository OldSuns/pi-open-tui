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
		["status", "--porcelain=v1", "--branch"],
		cwd,
	);
	if (stdout === null) {
		return emptyGitStatus();
	}

	const status = emptyGitStatus();
	const lines = stdout.split("\n");

	for (const line of lines) {
		if (line.startsWith("## ")) {
			const branchPart = line.slice(3);
			const detached = branchPart.startsWith("HEAD (no branch)");
			if (detached) {
				status.branch = undefined;
				status.commit = { oid: null, detached: true, tag: null };
			} else {
				const branchMatch = branchPart.match(/^(\S+?)(?:\.\.\.(\S+))?(?:\s+\[(.*)\])?$/);
				if (branchMatch) {
					status.branch = branchMatch[1];
					const ahead = branchMatch[3]?.match(/\bahead (\d+)\b/);
					const behind = branchMatch[3]?.match(/\bbehind (\d+)\b/);
					if (ahead) status.ahead = parseInt(ahead[1]!, 10);
					if (behind) status.behind = parseInt(behind[1]!, 10);
				}
			}
			continue;
		}

		// Skip file-entry counting and the separate stash query for branch-only display.
		if (options.readCounts === false) continue;
		if (line.length < 3) continue;
		const x = line[0]!;
		const y = line[1]!;

		if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) status.conflicted++;
		else if (x === "?" && y === "?") status.untracked++;
		else if (x === "R") {
			status.renamed++;
			if (y === "M") status.modified++;
		} else if (x === "D" || y === "D") status.deleted++;
		else {
			if (x !== " " && x !== "?") status.staged++;
			if (y === "M" || y === "D") status.modified++;
		}
	}

	if (options.readCounts !== false) {
		const stashOut = await gitExec(["stash", "list", "--format=%H"], cwd);
		if (stashOut !== null) {
			status.stashed = stashOut.split("\n").filter((line) => line.trim() !== "").length;
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
