/**
 * dsh-filexplore — host half.
 *
 * A plain Cordis plugin (web profile only). Registers the `/filexp` prefix on
 * the web server:
 *
 *   GET  /filexp/list?session=<id>&query=<q>
 *        Lists files under the session's cwd (recursive, depth-capped,
 *        noise dirs skipped, query-filtered) as relative paths. The browser
 *        half feeds these to the `@` candidate menu.
 *
 *   POST /filexp/intake   { session, files: [{ name, data(base64) }] }
 *        Writes dropped files into `<cwd>/attachments/` (name-deduped) and
 *        returns the stored relative paths. The browser half then inserts an
 *        `@file <path>` reference chip into the composer.
 *
 * Security stance: this is a local-first developer surface. Requests are
 * origin-checked (when an Origin header is present it must match the server
 * host), filenames are sanitized to a bare basename, the payload is
 * size-capped, and writes stay inside `<cwd>/attachments/`.
 */

import { readdir, stat, mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { basename, extname, join, relative, sep } from "node:path";

const execFile = promisify(execFileCb);

/** Service keys this plugin needs (activation is availability-driven). */
export const inject = ["webServer", "sessions", "workspaceRegistry"];

export const name = "dsh-filexplore";

/** Max request body bytes for intake (64 MiB). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Max files listed in one /filexp/list response. */
const MAX_LIST_ENTRIES = 400;
/** Max recursion depth for the workspace walk. */
const MAX_DEPTH = 4;
/** Max entries returned for one /filexp/tree directory. */
const MAX_TREE_ENTRIES = 1000;
/** Max text bytes read by /filexp/file; larger files are truncated. */
const MAX_FILE_TEXT_BYTES = 1024 * 1024;
/** Directory names never surfaced in the file list. */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	".dsh",
	".venv",
	"venv",
	"__pycache__",
	"dist",
	"build",
	".next",
	".nuxt",
	".turbo",
	".idea",
	".vscode",
	".cache",
	".DS_Store"
]);
/** The subfolder dropped files land in (relative to the session cwd). */
const ATTACHMENTS_DIR = "attachments";

/** Create the plugin: register the /filexp route for the lifetime of the fiber. */
export function apply(ctx) {
	ctx.effect(
		() => ctx.webServer.register({
			kind: "prefix",
			path: "/filexp",
			handler: createHandler(ctx)
		}),
		"dsh-filexplore: /filexp routes"
	);
}

function createHandler(ctx) {
	const sessions = () => ctx.get("sessions");
	return async (req, res) => {
		try {
			await route(ctx, req, res, sessions);
		} catch (error) {
			ctx.logger?.warn?.(`[dsh-filexplore] ${String(error?.message ?? error)}`);
			if (!res.headersSent) json(res, 500, { ok: false, error: String(error?.message ?? error) });
			else res.end();
		}
	};
}

async function route(ctx, req, res, sessions) {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (!originAllowed(req)) return json(res, 403, { ok: false, error: "origin-not-allowed" });
	switch (`${req.method} ${url.pathname}`) {
		case "GET /filexp/list":
			return handleList(req, res, url, sessions);
		case "GET /filexp/tree":
			return handleTree(req, res, url, ctx);
		case "GET /filexp/status":
			return handleStatus(req, res, url, ctx);
		case "GET /filexp/file":
			return handleFile(req, res, url, ctx);
		case "POST /filexp/write":
			return handleWrite(req, res, url, ctx);
		case "POST /filexp/intake":
			return handleIntake(req, res, url, sessions);
		default:
			return json(res, 404, { ok: false, error: "not-found" });
	}
}

/** Same-origin guard: an Origin header, when present, must match the server host. */
function originAllowed(req) {
	const origin = req.headers.origin;
	if (origin === undefined || origin === "") return true;
	try {
		const originHost = new URL(origin).host;
		return originHost === req.headers.host;
	} catch {
		return false;
	}
}

async function handleList(req, res, url, sessions) {
	const sessionId = url.searchParams.get("session") ?? "";
	const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
	const cwd = resolveCwd(sessions(), sessionId);
	if (cwd === undefined) return json(res, 200, { ok: true, cwd: null, files: [] });

	const files = [];
	await walk(cwd, cwd, 0, files, MAX_LIST_ENTRIES);
	const filtered = query === "" ? files : files.filter((f) => f.path.toLowerCase().includes(query) || f.name.toLowerCase().includes(query));
	json(res, 200, { ok: true, cwd, files: filtered.slice(0, MAX_LIST_ENTRIES) });
}

/**
 * One directory level of a registered Workspace for the VS Code-style file
 * tree: `GET /filexp/tree?workspace=<id>&path=<rel>`. `path` is a posix
 * relative directory under the workspace root; the root directory is the
 * empty string. Entries are dirs first then files, each alphabetical.
 */
async function handleTree(req, res, url, ctx) {
	const workspaceId = url.searchParams.get("workspace") ?? "";
	const rel = sanitizeRelPath(url.searchParams.get("path") ?? "");
	if (rel === null) return json(res, 400, { ok: false, error: "invalid-path" });

	const registry = ctx.get("workspaceRegistry");
	const workspace = registry?.get(workspaceId);
	if (workspace === void 0 || workspace.path === void 0) {
		return json(res, 404, { ok: false, error: "unknown-workspace" });
	}
	const root = workspace.path;
	const dir = rel === "" ? root : join(root, ...rel.split("/"));
	if (!(dir === root || dir.startsWith(root + sep))) {
		return json(res, 400, { ok: false, error: "outside-workspace" });
	}

	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		return json(res, 404, { ok: false, error: String(error?.code ?? "read-failed") });
	}
	const dirs = [];
	const files = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			dirs.push({ name: entry.name, kind: "dir" });
		} else if (entry.isFile()) {
			if (dirs.length + files.length >= MAX_TREE_ENTRIES) break;
			let st;
			try {
				st = await stat(join(dir, entry.name));
			} catch {
				continue;
			}
			files.push({ name: entry.name, kind: "file", size: st.size, mtime: st.mtimeMs });
		}
	}
	dirs.sort((a, b) => a.name.localeCompare(b.name));
	files.sort((a, b) => a.name.localeCompare(b.name));
	json(res, 200, {
		ok: true,
		workspaceId,
		root,
		path: rel,
		entries: [...dirs, ...files].slice(0, MAX_TREE_ENTRIES)
	});
}

/** Normalize a client-supplied relative path; null when it escapes or is malformed. */
function sanitizeRelPath(raw) {
	if (raw === "") return "";
	if (raw.includes("\\") || raw.startsWith("/") || raw.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
	const cleaned = raw.split("/").map((seg) => seg.trim()).filter((seg) => seg !== "");
	return cleaned.join("/");
}

/**
 * Git status for a registered Workspace: `GET /filexp/status?workspace=<id>`.
 * Runs `git status --porcelain=v1 -z --untracked-files=all` in the workspace
 * root and returns one record per changed path. A non-git directory answers
 * `{ git: false }`.
 */
async function handleStatus(req, res, url, ctx) {
	const workspaceId = url.searchParams.get("workspace") ?? "";
	const workspace = ctx.get("workspaceRegistry")?.get(workspaceId);
	if (workspace === void 0 || workspace.path === void 0) {
		return json(res, 404, { ok: false, error: "unknown-workspace" });
	}
	const root = workspace.path;
	let stdout;
	try {
		({ stdout } = await execFile("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
			timeout: 10000
		}));
	} catch {
		return json(res, 200, { ok: true, git: false, files: [] });
	}
	json(res, 200, { ok: true, git: true, files: parsePorcelain(stdout) });
}

/** Parse `git status --porcelain=v1 -z` output (NUL-separated entries). */
function parsePorcelain(out) {
	const parts = out.split("\0").filter((part) => part !== "");
	const files = [];
	let i = 0;
	while (i < parts.length) {
		const entry = parts[i];
		if (entry.length < 3) {
			i += 1;
			continue;
		}
		const xy = entry.slice(0, 2);
		let path = entry.slice(3);
		let old;
		if (xy[0] === "R" || xy[0] === "C") {
			old = path;
			i += 1;
			path = parts[i] ?? path;
		}
		files.push({
			path: path.replaceAll("\\", "/"),
			old,
			short: xy,
			status: statusLetter(xy)
		});
		i += 1;
	}
	return files;
}

/** Collapse porcelain XY codes to one VS Code-style status letter. */
function statusLetter(xy) {
	if (xy === "??") return "U";
	if (xy.includes("U")) return "!";
	const first = xy[0];
	const second = xy[1];
	const letter = first !== " " && first !== "?" ? first : second;
	return letter === " " ? "" : letter;
}

/**
 * Read one text file of a registered Workspace: `GET /filexp/file?workspace=<id>&path=<rel>`.
 * Text is capped at MAX_FILE_TEXT_BYTES; binary files are flagged, not read.
 */
async function handleFile(req, res, url, ctx) {
	const workspaceId = url.searchParams.get("workspace") ?? "";
	const rel = sanitizeRelPath(url.searchParams.get("path") ?? "");
	if (rel === null || rel === "") return json(res, 400, { ok: false, error: "invalid-path" });
	const workspace = ctx.get("workspaceRegistry")?.get(workspaceId);
	if (workspace === void 0 || workspace.path === void 0) {
		return json(res, 404, { ok: false, error: "unknown-workspace" });
	}
	const root = workspace.path;
	const abs = join(root, ...rel.split("/"));
	if (!abs.startsWith(root + sep)) return json(res, 400, { ok: false, error: "outside-workspace" });

	let st;
	try {
		st = await stat(abs);
	} catch {
		return json(res, 404, { ok: false, error: "not-found" });
	}
	if (st.isDirectory()) return json(res, 400, { ok: false, error: "is-directory" });

	const truncated = st.size > MAX_FILE_TEXT_BYTES;
	let buf;
	try {
		buf = await readFile(abs, truncated ? { length: MAX_FILE_TEXT_BYTES } : undefined);
	} catch (error) {
		return json(res, 500, { ok: false, error: String(error?.message ?? error) });
	}
	const binary = looksBinary(rel) || buf.includes(0);
	json(res, 200, {
		ok: true,
		path: rel,
		size: st.size,
		text: binary ? "" : buf.toString("utf8"),
		truncated,
		binary
	});
}

/** Extensions treated as binary even when no NUL byte appears in the head. */
function looksBinary(rel) {
	const ext = extname(rel).toLowerCase();
	return [
		".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
		".pdf", ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar", ".bz2", ".xz",
		".mp3", ".mp4", ".mov", ".webm", ".wav", ".flac", ".ogg", ".aac",
		".woff", ".woff2", ".ttf", ".otf", ".eot",
		".bin", ".exe", ".dll", ".so", ".dylib", ".wasm", ".class", ".pyc"
	].includes(ext);
}

/**
 * Write a text file back into a registered Workspace:
 * `POST /filexp/write?workspace=<id>&path=<rel>` with `{ text }`. Used by the
 * viewer's manual edit-and-save. Path stays inside the workspace root.
 */
async function handleWrite(req, res, url, ctx) {
	const workspaceId = url.searchParams.get("workspace") ?? "";
	const rel = sanitizeRelPath(url.searchParams.get("path") ?? "");
	if (rel === null || rel === "") return json(res, 400, { ok: false, error: "invalid-path" });
	const workspace = ctx.get("workspaceRegistry")?.get(workspaceId);
	if (workspace === void 0 || workspace.path === void 0) {
		return json(res, 404, { ok: false, error: "unknown-workspace" });
	}
	const root = workspace.path;
	const abs = join(root, ...rel.split("/"));
	if (!abs.startsWith(root + sep)) return json(res, 400, { ok: false, error: "outside-workspace" });

	let body;
	try {
		body = await readBody(req, MAX_BODY_BYTES);
	} catch (error) {
		return json(res, 413, { ok: false, error: String(error?.message ?? error) });
	}
	let payload;
	try {
		payload = JSON.parse(body.toString("utf8"));
	} catch {
		return json(res, 400, { ok: false, error: "invalid-json" });
	}
	if (typeof payload?.text !== "string") return json(res, 400, { ok: false, error: "invalid-payload" });

	try {
		await writeFile(abs, payload.text, "utf8");
	} catch (error) {
		return json(res, 500, { ok: false, error: String(error?.message ?? error) });
	}
	json(res, 200, { ok: true, path: rel, size: Buffer.byteLength(payload.text, "utf8") });
}

async function handleIntake(req, res, url, sessions) {
	const sessionId = url.searchParams.get("session") ?? "";
	const cwd = resolveCwd(sessions(), sessionId);
	if (cwd === undefined) return json(res, 400, { ok: false, error: "no-session-cwd" });

	let body;
	try {
		body = await readBody(req, MAX_BODY_BYTES);
	} catch (error) {
		return json(res, 413, { ok: false, error: String(error?.message ?? error) });
	}
	let payload;
	try {
		payload = JSON.parse(body.toString("utf8"));
	} catch {
		return json(res, 400, { ok: false, error: "invalid-json" });
	}
	if (typeof payload !== "object" || payload === null || !Array.isArray(payload.files)) {
		return json(res, 400, { ok: false, error: "invalid-payload" });
	}

	const dir = join(cwd, ATTACHMENTS_DIR);
	await mkdir(dir, { recursive: true });

	const stored = [];
	for (const file of payload.files) {
		if (typeof file?.name !== "string" || typeof file?.data !== "string") continue;
		const name = sanitizeName(file.name);
		const bytes = Buffer.from(file.data, "base64");
		if (bytes.length === 0 && file.data.length > 0) continue;
		const target = await uniquePath(dir, name);
		await writeFile(target, bytes);
		stored.push({
			name: basename(target),
			path: `${ATTACHMENTS_DIR}/${basename(target)}`,
			size: bytes.length
		});
	}

	json(res, 200, { ok: true, files: stored });
}

/** The session's working directory, or undefined when the session is unknown. */
function resolveCwd(sessions, sessionId) {
	if (sessionId === "") return undefined;
	const session = sessions.get(sessionId);
	return typeof session?.header?.cwd === "string" ? session.header.cwd : undefined;
}

/** Recursive file walk; hidden entries and noise dirs are skipped. */
async function walk(root, dir, depth, out, limit) {
	if (out.length >= limit || depth > MAX_DEPTH) return;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (out.length >= limit) return;
		if (entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			await walk(root, full, depth + 1, out, limit);
		} else if (entry.isFile()) {
			let st;
			try {
				st = await stat(full);
			} catch {
				continue;
			}
			out.push({
				path: relative(root, full).split(sep).join("/"),
				name: entry.name,
				size: st.size,
				mtime: st.mtimeMs
			});
		}
	}
}

/** Collapse an untrusted file name to a safe bare basename. */
function sanitizeName(name) {
	const base = basename(String(name ?? ""))
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
		.trim();
	if (base === "" || base === "." || base === "..") return "file";
	return base.startsWith(".") ? `_${base}` : base;
}

/** First free path in `dir` for `name`, appending `-1`, `-2`, … on collision. */
async function uniquePath(dir, name) {
	const probe = join(dir, name);
	try {
		await stat(probe);
	} catch {
		return probe;
	}
	const ext = extname(name);
	const stem = ext === "" ? name : name.slice(0, -ext.length);
	for (let i = 1; ; i += 1) {
		const candidate = join(dir, `${stem}-${i}${ext}`);
		try {
			await stat(candidate);
		} catch {
			return candidate;
		}
	}
}

/** Read a request body with a hard size cap. */
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("payload-too-large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function json(res, status, body) {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(data);
}
