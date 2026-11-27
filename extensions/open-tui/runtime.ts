import { execFile } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 2500;
const PYVENV_CONFIG_MAX_BYTES = 64 * 1024;

export interface RuntimeInfo {
	name: string;
	version?: string;
}

interface RuntimeDef {
	name: string;
	files: readonly string[];
	folders?: readonly string[];
	extensions?: readonly string[];
	env?: string;
	versionCommand?: { cmd: string; args?: string[]; pattern?: RegExp };
}

const RUNTIMES: readonly RuntimeDef[] = [
	{ name: "bun", files: ["bun.lock", "bun.lockb"], versionCommand: { cmd: "bun", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ name: "nodejs", files: ["package.json", ".nvmrc", ".node-version"], versionCommand: { cmd: "node", args: ["--version"], pattern: /v(\d+\.\d+\.\d+)/ } },
	{ name: "rust", files: ["Cargo.toml"], versionCommand: { cmd: "rustc", args: ["--version"], pattern: /rustc\s+(\d+\.\d+\.\d+)/ } },
	{ name: "go", files: ["go.mod"], versionCommand: { cmd: "go", args: ["version"], pattern: /go(\d+\.\d+\.\d+)/ } },
	{ name: "python", files: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", ".python-version"], versionCommand: { cmd: "python3", args: ["--version"], pattern: /Python\s+(\d+\.\d+\.\d+)/ } },
	{ name: "ruby", files: ["Gemfile", ".ruby-version"], versionCommand: { cmd: "ruby", args: ["--version"], pattern: /ruby\s+(\d+\.\d+\.\d+)/ } },
	{ name: "java", files: ["pom.xml", "build.gradle", "build.gradle.kts", ".java-version"], versionCommand: { cmd: "java", args: ["-version"], pattern: /version\s+"(\d+\.\d+[\.\d]*)"/ } },
	{ name: "swift", files: ["Package.swift"], versionCommand: { cmd: "swift", args: ["--version"], pattern: /Swift\s+(\d+\.\d+)/ } },
	{ name: "kotlin", files: ["build.gradle.kts", "settings.gradle.kts"] },
	{ name: "cpp", files: ["CMakeLists.txt", "Makefile"] },
	{ name: "deno", files: ["deno.json", "deno.jsonc", "deno.lock"], versionCommand: { cmd: "deno", args: ["--version"], pattern: /deno\s+(\d+\.\d+\.\d+)/ } },
	{ name: "php", files: ["composer.json"], versionCommand: { cmd: "php", args: ["--version"], pattern: /PHP\s+(\d+\.\d+\.\d+)/ } },
	{ name: "haskell", files: ["stack.yaml", "cabal.project"], extensions: [".cabal"], versionCommand: { cmd: "ghc", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ name: "julia", files: ["Project.toml", "Manifest.toml"], versionCommand: { cmd: "julia", args: ["--version"], pattern: /julia\s+(\d+\.\d+\.\d+)/ } },
	{ name: "lua", files: ["stylua.toml", ".luarc.json"], versionCommand: { cmd: "lua", args: ["-v"], pattern: /Lua\s+(\d+\.\d+)/ } },
	{ name: "elixir", files: ["mix.exs"], versionCommand: { cmd: "elixir", args: ["--version"], pattern: /Elixir\s+(\d+\.\d+\.\d+)/ } },
	{ name: "erlang", files: ["rebar.config", "erlang.mk"] },
	{ name: "gleam", files: ["gleam.toml"], versionCommand: { cmd: "gleam", args: ["--version"], pattern: /gleam\s+(\d+\.\d+\.\d+)/ } },
	{ name: "crystal", files: ["shard.yml"], versionCommand: { cmd: "crystal", args: ["--version"], pattern: /Crystal\s+(\d+\.\d+\.\d+)/ } },
	{ name: "dart", files: ["pubspec.yaml"], versionCommand: { cmd: "dart", args: ["--version"], pattern: /Dart\s+SDK\s+version:\s+(\d+\.\d+\.\d+)/ } },
	{ name: "nim", files: ["nim.cfg"], extensions: [".nimble"] },
	{ name: "zig", files: ["build.zig"], versionCommand: { cmd: "zig", args: ["version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ name: "ocaml", files: ["dune", "dune-project"], extensions: [".opam"] },
	{ name: "clojure", files: ["project.clj", "deps.edn"] },
	{ name: "scala", files: ["build.sbt", ".metals"], extensions: [".scala"] },
	{ name: "perl", files: ["Makefile.PL", "cpanfile"] },
	{ name: "r", files: ["DESCRIPTION"], extensions: [".Rproj"] },
	{ name: "elm", files: ["elm.json"] },
	{ name: "haxe", files: ["haxelib.json", ".haxerc"] },
	{ name: "vagrant", files: ["Vagrantfile"] },
	{ name: "terraform", files: ["main.tf", "variables.tf"], folders: [".terraform"] },
	{ name: "helm", files: ["Chart.yaml", "helmfile.yaml"] },
	{ name: "solidity", files: [], extensions: [".sol"] },
	{ name: "fortran", files: ["fpm.toml"], extensions: [".f", ".f90", ".f95"] },
	{ name: "mojo", files: [], extensions: [".mojo"] },
	{ name: "red", files: [], extensions: [".red", ".reds"] },
	{ name: "raku", files: ["META6.json"], extensions: [".raku", ".rakumod"] },
	{ name: "purescript", files: ["spago.dhall", "spago.yaml"] },
	{ name: "fennel", files: [], extensions: [".fnl"] },
	{ name: "odin", files: [], extensions: [".odin"] },
	{ name: "v", files: ["v.mod", "vpkg.json"], extensions: [".v"] },
	{ name: "xmake", files: ["xmake.lua"] },
	{ name: "gradle", files: ["build.gradle", "build.gradle.kts"], folders: ["gradle"] },
	{ name: "cmake", files: ["CMakeLists.txt", "CMakeCache.txt"] },
	{ name: "meson", files: ["meson.build"], env: "MESON_DEVENV" },
	{ name: "nix", files: ["flake.nix", "shell.nix"], env: "IN_NIX_SHELL" },
	{ name: "guix", files: [], env: "GUIX_ENVIRONMENT" },
	{ name: "conda", files: [], env: "CONDA_DEFAULT_ENV" },
	{ name: "pixi", files: ["pixi.toml", "pixi.lock"], env: "PIXI_ENVIRONMENT_NAME" },
	{ name: "spack", files: [], env: "SPACK_ENV" },
	{ name: "pulumi", files: ["Pulumi.yaml", "Pulumi.yml"] },
	{ name: "typst", files: ["template.typ"], extensions: [".typ"] },
	{ name: "buf", files: ["buf.yaml", "buf.gen.yaml", "buf.work.yaml"] },
	{ name: "dotnet", files: ["global.json", "Directory.Build.props"], extensions: [".csproj", ".fsproj"] },
	{ name: "cobol", files: [], extensions: [".cbl", ".cob"] },
];

interface CacheEntry {
	fingerprint: string;
	runtime: RuntimeInfo | null;
}

const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 32;

function lstatIfPresent(path: string) {
	try {
		return lstatSync(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		return undefined;
	}
}

function readPyvenvVersion(path: string): string | undefined {
	// Bound reads of project metadata and avoid following a replacement symlink or blocking on a pipe.
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size === 0 || stat.size > PYVENV_CONFIG_MAX_BYTES) return undefined;
		const buffer = Buffer.alloc(stat.size);
		if (readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) return undefined;
		let versionInfo: string | undefined;
		for (const line of buffer.toString("utf8").split(/\r?\n/)) {
			const match = line.trim().match(/^(version|version_info)[ \t]*=[ \t]*(\d+\.\d+(?:\.\d+)?)(?:(?:a|b|rc)\d+|\.(?:alpha|beta|candidate|final)\.\d+)?$/);
			if (!match) continue;
			if (match[1] === "version") return match[2];
			versionInfo ??= match[2];
		}
		return versionInfo;
	} finally {
		closeSync(fd);
	}
}

function pythonVersion(cwd: string): string | undefined {
	const interpreters = process.platform === "win32" ? ["Scripts/python.exe"] : ["bin/python", "bin/python3"];
	try {
		for (const environment of [".venv", process.env.VIRTUAL_ENV]) {
			if (!environment) continue;
			const root = resolve(cwd, environment);
			const configPath = join(root, "pyvenv.cfg");
			const config = lstatIfPresent(configPath);
			const paths = interpreters.map((interpreter) => join(root, interpreter));
			// A dangling link still selects this environment, even if there is no metadata file.
			if (!config && !paths.some(lstatIfPresent)) continue;
			if (!config?.isFile() || !paths.some((path) => statSync(path, { throwIfNoEntry: false })?.isFile())) return undefined;
			return readPyvenvVersion(configPath);
		}
	} catch { /* An unreadable environment does not provide a version. */ }
	return undefined;
}

function canProbePathPython(cwd: string): boolean {
	if (process.env.VIRTUAL_ENV) return false;
	try {
		return !lstatIfPresent(join(cwd, ".venv"));
	} catch {
		return false;
	}
}

function fingerprint(cwd: string, def: RuntimeDef): string {
	const parts: string[] = [];
	for (const f of def.files) {
		try {
			const stat = statSync(join(cwd, f));
			parts.push(`${f}:${stat.mtimeMs}`);
		} catch { /* ignore */ }
	}
	if (def.extensions || def.folders) {
		try {
			const entries = readdirSync(cwd);
			parts.push(...entries.slice().sort());
		} catch { /* ignore */ }
	}
	if (def.env && process.env[def.env]) {
		parts.push(`${def.env}=${process.env[def.env]}`);
	}
	return parts.join("\0");
}

function matchesDef(cwd: string, def: RuntimeDef): boolean {
	if (def.env && process.env[def.env]) return true;
	if (def.files.some((f) => existsSync(join(cwd, f)))) return true;
	if (def.folders?.some((f) => existsSync(join(cwd, f)))) return true;
	if (def.extensions) {
		try {
			const entries = readdirSync(cwd);
			if (entries.some((e) => def.extensions!.some((ext) => e.endsWith(ext)))) return true;
		} catch { /* ignore */ }
	}
	return false;
}

async function fetchVersion(command: RuntimeDef["versionCommand"], cwd: string): Promise<string | undefined> {
	if (!command) return undefined;
	try {
		const { stdout, stderr } = await execFileAsync(command.cmd, command.args ?? [], {
			cwd,
			timeout: VERSION_TIMEOUT_MS,
			maxBuffer: 64 * 1024,
		});
		const output = `${stdout}\n${stderr}`;
		if (command.pattern) {
			const match = output.match(command.pattern);
			return match?.[1];
		}
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

export async function readRuntimeInfo(cwd: string, projectTrusted = false): Promise<RuntimeInfo | null> {
	for (const def of RUNTIMES) {
		if (!matchesDef(cwd, def)) continue;
		const isPython = def.name === "python";
		if (isPython) {
			if (!projectTrusted) return { name: def.name, version: undefined };
			const version = pythonVersion(cwd);
			if (version !== undefined || !canProbePathPython(cwd)) return { name: def.name, version };
		}
		const versionCwd = isPython ? tmpdir() : cwd;
		const projectFingerprint = fingerprint(cwd, def);
		const fp = isPython ? [projectFingerprint, process.env.PATH ?? "", versionCwd].join("\0") : projectFingerprint;
		const cacheKey = `${cwd}\0${def.name}`;
		const cached = cache.get(cacheKey);
		if (cached && cached.fingerprint === fp) {
			return cached.runtime;
		}

		for (const key of cache.keys()) {
			if (key === cacheKey || key.startsWith(`${cwd}\0`)) cache.delete(key);
		}

		const version = await fetchVersion(def.versionCommand, versionCwd);
		const info: RuntimeInfo = {
			name: def.name,
			version,
		};
		cache.set(cacheKey, { fingerprint: fp, runtime: info });
		while (cache.size > CACHE_MAX) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
		return info;
	}
	return null;
}

export function clearRuntimeCache(): void {
	cache.clear();
}
