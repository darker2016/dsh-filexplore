/**
 * dsh-filexplore — browser half (client bundle).
 *
 * Loaded by the dsh client module system as entry "dsh-filexplore".
 *
 * Features:
 *   1. `@` trigger source "file" — typing `@` lists workspace files (from the
 *      host /filexp/list endpoint) and picking one inserts a reference chip.
 *   2. Drag & drop — drops containing at least one non-image file are claimed
 *      in the capture phase, intaken into `<cwd>/attachments/` (host
 *      /filexp/intake), and each stored file becomes a reference chip.
 *   3. Persistent right file browser — the folder button on each Workspace
 *      row opens the layout's native right column (patched into
 *      @deepseek-ai/dsh-client-ui-layout as the `layout.right` slot), a real
 *      four-column reflow so the conversation shrinks. Shows a lazy file tree
 *      plus Git status badges (host /filexp/status).
 *   4. File viewer — clicking a file opens a multi-tab viewer below the
 *      browser in the same column (vertical split, adjustable divider). Any
 *      open tab can be inserted into the composer as an `@file` reference.
 *
 * The layout patch lives in the installed dsh-client-ui-layout bundle; see
 * patches/ in this repository for the diff.
 */
window.__ModuleLoader__.load({
	id: "dsh-filexplore",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let react_dom = require("react-dom");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const h = react.createElement;
		const { Fragment, useEffect, useState, useSyncExternalStore, useRef } = react;
		const { IconChevronDownOutline14, IconChevronRightOutline14, IconCloseOutline16, IconEditOutline16, IconFolderClose16, IconFolderOpen16, IconLoadingOutline16, IconRefreshOutline16, IconPlusOutline16 } = _deepseek_ai_dsh_client_ui_primitives;

		/** Reference source name (the input-trigger roster key and chip owner). */
		const SOURCE = "file";
		/** Locale namespace for plugin-owned copy. */
		const NS = "filexp";
		/** Per-file intake cap (bytes); larger files are skipped with a warning. */
		const MAX_FILE_BYTES = 32 * 1024 * 1024;
		/** Git status polling interval while the browser is open (ms). */
		const STATUS_POLL_MS = 5000;
		/** Browser section min/max heights inside the right column (px). */
		const BROWSER_MIN_H = 140;
		const BROWSER_MAX_H = 760;
		/** Max rendered lines in the viewer (beyond that, a notice replaces the tail). */
		const VIEWER_MAX_LINES = 3000;

		/** Simplified Chinese dictionary (key-set source of truth). */
		const zh = {
			"intake.failed": "文件导入失败",
			"intake.large": "文件过大，已跳过",
			"list.failed": "无法列出工作区文件",
			"explore": "浏览工作区文件",
			"explore.aria": "浏览工作区文件",
			"browser.close": "关闭文件浏览器",
			"browser.refresh": "刷新",
			"browser.loading": "加载中…",
			"browser.error": "加载失败",
			"browser.empty": "（空目录）",
			"browser.noGit": "非 Git 仓库",
			"browser.legend": "U 新增 · M 修改 · D 删除 · R 重命名 · A 已暂存 · ! 冲突",
			"browser.insert": "插入 @file {name}",
			"browser.expand": "展开",
			"browser.collapse": "收起",
			"viewer.insert": "插入引用",
			"viewer.closeTab": "关闭标签",
			"viewer.loading": "加载中…",
			"viewer.error": "加载失败",
			"viewer.binary": "二进制文件，暂不支持预览（{size}）",
			"viewer.truncated": "文件过大，仅显示前 {size}",
			"viewer.long": "文件过大，仅显示前 {lines} 行",
			"viewer.edit": "编辑",
			"viewer.save": "保存",
			"viewer.cancel": "取消",
			"viewer.saving": "保存中…",
			"viewer.confirmDiscard": "有未保存的修改，确定放弃？",
			"viewer.unsaved": "未保存",
			"viewer.readonly": "此类文件不可编辑",
			"panels.divider": "拖拽调整浏览器/查看器高度"
		};
		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"intake.failed": "File intake failed",
			"intake.large": "File too large, skipped",
			"list.failed": "Could not list workspace files",
			"explore": "Browse workspace files",
			"explore.aria": "Browse workspace files",
			"browser.close": "Close file browser",
			"browser.refresh": "Refresh",
			"browser.loading": "Loading…",
			"browser.error": "Failed to load",
			"browser.empty": "(empty)",
			"browser.noGit": "Not a Git repository",
			"browser.legend": "U added · M modified · D deleted · R renamed · A staged · ! conflict",
			"browser.insert": "Insert @file {name}",
			"browser.expand": "Expand",
			"browser.collapse": "Collapse",
			"viewer.insert": "Insert reference",
			"viewer.closeTab": "Close tab",
			"viewer.loading": "Loading…",
			"viewer.error": "Failed to load",
			"viewer.binary": "Binary file, preview not supported ({size})",
			"viewer.truncated": "File too large — showing first {size}",
			"viewer.long": "File too large — showing first {lines} lines",
			"viewer.edit": "Edit",
			"viewer.save": "Save",
			"viewer.cancel": "Cancel",
			"viewer.saving": "Saving…",
			"viewer.confirmDiscard": "Discard unsaved changes?",
			"viewer.unsaved": "unsaved",
			"viewer.readonly": "This file type is not editable",
			"panels.divider": "Drag to resize browser / viewer"
		};

		/** Required client services. */
		const inject = ["locale", "slots", "inputTriggers", "sessions", "conversation", "workspaces", "layout"];

		/** The model-facing text for one file reference. */
		function mention(path) {
			return `@file ${path}`;
		}

		function hasFiles(event) {
			return event.dataTransfer?.types.includes("Files") ?? false;
		}

		function isImageOnly(files) {
			return files.length > 0 && files.every((file) => file.type.startsWith("image/"));
		}

		/** Base64-encode bytes in bounded chunks (spread args are capped). */
		function bytesToBase64(bytes) {
			let binary = "";
			const chunk = 0x8000;
			for (let i = 0; i < bytes.length; i += chunk) {
				binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
			}
			return btoa(binary);
		}

		/** Human-readable size, VS Code style. */
		function formatSize(bytes) {
			if (bytes === void 0) return "";
			if (bytes < 1024) return `${bytes} B`;
			const units = ["KB", "MB", "GB"];
			let value = bytes / 1024;
			let unit = 0;
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024;
				unit += 1;
			}
			return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
		}

		/** List workspace files for the candidate menu. */
		async function listFiles(sessionId, query, signal) {
			const params = new URLSearchParams({ session: sessionId, query: query ?? "" });
			const res = await fetch(`/filexp/list?${params.toString()}`, { signal });
			if (!res.ok) throw new Error(`filexp list failed: ${res.status}`);
			const data = await res.json();
			if (data.ok !== true || !Array.isArray(data.files)) throw new Error("filexp list bad response");
			return data.files.map((file) => ({
				name: file.name,
				description: file.path,
				ref: file.path
			}));
		}

		/** Fetch one directory level of a workspace tree. */
		async function fetchTree(workspaceId, rel, signal) {
			const params = new URLSearchParams({ workspace: workspaceId });
			if (rel !== "") params.set("path", rel);
			const res = await fetch(`/filexp/tree?${params.toString()}`, { signal });
			if (!res.ok) throw new Error(`filexp tree failed: ${res.status}`);
			const data = await res.json();
			if (data.ok !== true || !Array.isArray(data.entries)) throw new Error("filexp tree bad response");
			return data;
		}

		/** Fetch git status of a workspace. */
		async function fetchStatus(workspaceId, signal) {
			const params = new URLSearchParams({ workspace: workspaceId });
			const res = await fetch(`/filexp/status?${params.toString()}`, { signal });
			if (!res.ok) throw new Error(`filexp status failed: ${res.status}`);
			const data = await res.json();
			if (data.ok !== true || !Array.isArray(data.files)) throw new Error("filexp status bad response");
			return { git: data.git === true, files: data.files };
		}

		/** Fetch one file's text content. */
		async function fetchFile(workspaceId, rel, signal) {
			const params = new URLSearchParams({ workspace: workspaceId, path: rel });
			const res = await fetch(`/filexp/file?${params.toString()}`, { signal });
			if (!res.ok) throw new Error(`filexp file failed: ${res.status}`);
			const data = await res.json();
			if (data.ok !== true) throw new Error("filexp file bad response");
			return data;
		}

		/** Intake dropped files and insert one reference chip per stored file. */
		async function intakeAndInsert(sessions, conversation, files) {
			const sessionId = sessions.list.getSnapshot().current;
			if (sessionId === void 0) return;
			const payload = [];
			for (const file of files) {
				if (file.size > MAX_FILE_BYTES) {
					console.warn(`[dsh-filexplore] ${zh["intake.large"]}: ${file.name}`);
					continue;
				}
				const data = await file.arrayBuffer();
				payload.push({ name: file.name, data: bytesToBase64(new Uint8Array(data)) });
			}
			if (payload.length === 0) return;
			const res = await fetch("/filexp/intake", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ session: sessionId, files: payload })
			});
			if (!res.ok) throw new Error(`filexp intake failed: ${res.status}`);
			const result = await res.json();
			if (result.ok !== true || !Array.isArray(result.files)) throw new Error("filexp intake bad response");

			const shell = conversation?.input?.shell(sessionId);
			if (shell === void 0) return;
			let span = {
				start: shell.snapshot.draft.length,
				end: shell.snapshot.draft.length,
				draftRev: shell.snapshot.draftRev
			};
			for (const stored of result.files) {
				const accepted = shell.insertReference(
					{ source: SOURCE, ref: stored.path, label: stored.name, clipboardText: mention(stored.path) },
					span
				);
				if (!accepted) break;
				span = {
					start: span.start + 2,
					end: span.start + 2,
					draftRev: shell.snapshot.draftRev
				};
			}
		}

		/** Insert one reference chip into the CURRENT session's composer. */
		function insertReferenceChip(sessions, conversation, refPath, label) {
			const sessionId = sessions.list.getSnapshot().current;
			if (sessionId === void 0) return false;
			const shell = conversation?.input?.shell(sessionId);
			if (shell === void 0) return false;
			const span = {
				start: shell.snapshot.draft.length,
				end: shell.snapshot.draft.length,
				draftRev: shell.snapshot.draftRev
			};
			return shell.insertReference(
				{ source: SOURCE, ref: refPath, label, clipboardText: mention(refPath) },
				span
			);
		}

		/**
		 * Reference path for a tree entry: relative when the browsed workspace
		 * is the current session's cwd, absolute otherwise (the agent can then
		 * always resolve it).
		 */
		function insertRefPath(root, childRel, sessions) {
			const current = sessions.list.getSnapshot().current;
			const currentCwd = current !== void 0 ? sessions.list.getSnapshot().byId[current]?.cwd : void 0;
			return root !== "" && root !== currentCwd ? `${root}/${childRel}` : childRel;
		}

		// ── panels store ──────────────────────────────────────────────────────
		/**
		 * Immutable-snapshot store for the right column: which workspace the
		 * browser shows, viewer tabs + per-tab contents, and the vertical split
		 * (browser section height in px).
		 */
		function createPanelsStore() {
			let state = {
				browser: { open: false, workspaceId: null, title: "", path: "" },
				viewer: { open: false, workspaceId: null, tabs: [], active: null, contents: new Map() },
				browserHeight: 300
			};
			const listeners = new Set();
			const emit = () => {
				for (const listener of listeners) listener();
			};
			return {
				getSnapshot: () => state,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				setBrowser(workspaceId, title, path) {
					const resetViewer = state.viewer.workspaceId !== workspaceId;
					state = {
						...state,
						browser: { open: true, workspaceId, title, path },
						viewer: resetViewer ? { ...state.viewer, open: false, workspaceId, tabs: [], active: null, contents: new Map() } : state.viewer
					};
					emit();
				},
				closeBrowser() {
					if (!state.browser.open) return;
					state = { ...state, browser: { ...state.browser, open: false } };
					emit();
				},
				openFile(rel, label) {
					const tabs = state.viewer.tabs.includes(rel) ? state.viewer.tabs : [...state.viewer.tabs, rel];
					state = { ...state, viewer: { ...state.viewer, open: true, workspaceId: state.browser.workspaceId, tabs, active: rel } };
					emit();
				},
				closeTab(rel) {
					const tabs = state.viewer.tabs.filter((tab) => tab !== rel);
					const contents = new Map(state.viewer.contents);
					contents.delete(rel);
					let active = state.viewer.active;
					if (active === rel) {
						const at = state.viewer.tabs.indexOf(rel);
						active = tabs.length > 0 ? tabs[Math.min(at, tabs.length - 1)] : null;
					}
					state = { ...state, viewer: { ...state.viewer, tabs, active, contents, open: tabs.length > 0 } };
					emit();
				},
				setActive(rel) {
					if (state.viewer.active === rel) return;
					state = { ...state, viewer: { ...state.viewer, active: rel } };
					emit();
				},
				setContent(rel, content) {
					state = { ...state, viewer: { ...state.viewer, contents: new Map(state.viewer.contents).set(rel, content) } };
					emit();
				},
				closeViewer() {
					if (!state.viewer.open) return;
					state = { ...state, viewer: { ...state.viewer, open: false } };
					emit();
				},
				setBrowserHeight(height) {
					if (state.browserHeight === height) return;
					state = { ...state, browserHeight: height };
					emit();
				}
			};
		}
		const panelsStore = createPanelsStore();
		/** Module-level "the viewer is editing right now" flag — a focused editor
		 * owns Escape / Ctrl+S, so the window-level Escape panel-closer backs off. */
		let viewerEditing = 0;

		/** One status-letter badge style (VS Code palette). */
		function statusClass(status) {
			switch (status) {
				case "U": return "fxb-badge-untracked";
				case "M": return "fxb-badge-modified";
				case "D": return "fxb-badge-deleted";
				case "R":
				case "C": return "fxb-badge-renamed";
				case "A": return "fxb-badge-added";
				case "!": return "fxb-badge-conflict";
				default: return "";
			}
		}

		// ── right column: browser (top) + viewer (bottom) ─────────────────────
		/** Rendered into the layout's `layout.right` slot (the patched 4th column). */
		function RightPanels({ t, sessions, conversation, workspaces, layout }) {
			const state = useSyncExternalStore(panelsStore.subscribe, panelsStore.getSnapshot);
			const showBrowser = state.browser.open;
			const showViewer = state.viewer.open && state.viewer.tabs.length > 0;
			const rootRef = useRef(null);
			const splitBase = useRef(0);
			const splitStart = useRef(0);
			if (!showBrowser && !showViewer) return null;

			const startSplit = (e) => {
				e.preventDefault();
				splitBase.current = state.browserHeight;
				splitStart.current = e.clientY;
				const el = rootRef.current;
				const maxH = el === null ? BROWSER_MAX_H : Math.max(BROWSER_MIN_H, el.clientHeight - 200);
				const onMove = (ev) => {
					const next = Math.min(maxH, Math.max(BROWSER_MIN_H, splitBase.current + (ev.clientY - splitStart.current)));
					panelsStore.setBrowserHeight(next);
				};
				const onUp = () => {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
			};

			return h("div", { className: "fxp-root", ref: rootRef },
				showBrowser && h(FileBrowserPanel, { t, sessions, conversation, workspaces, layout, height: state.browserHeight }),
				showBrowser && showViewer && h("div", {
					className: "fxp-divider",
					title: t("panels.divider"),
					role: "separator",
					"aria-orientation": "horizontal",
					onPointerDown: startSplit
				}),
				showViewer && h(FileViewerPanel, { t, sessions, conversation })
			);
		}

		// ── right-side file browser ───────────────────────────────────────────
		function FileBrowserPanel({ t, sessions, conversation, workspaces, layout, height }) {
			const state = useSyncExternalStore(panelsStore.subscribe, panelsStore.getSnapshot);
			const browser = state.browser;
			const [rootPath, setRootPath] = useState("");
			const [entriesByPath, setEntriesByPath] = useState(new Map());
			const [expanded, setExpanded] = useState(new Set());
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState(null);
			const [statusMap, setStatusMap] = useState(new Map());
			const [isGit, setIsGit] = useState(false);
			const abortsRef = useRef(new Map());

			// Reset + load the root level and git status whenever the workspace changes.
			useEffect(() => {
				setRootPath("");
				setEntriesByPath(new Map());
				setExpanded(new Set());
				setError(null);
				setLoading(true);
				setStatusMap(new Map());
				const controller = new AbortController();
				abortsRef.current.set("", controller);
				fetchTree(browser.workspaceId, "", controller.signal)
					.then((data) => {
						if (controller.signal.aborted) return;
						setRootPath(data.root ?? "");
						setEntriesByPath(new Map([["", { status: "ready", entries: data.entries }]]));
						setLoading(false);
					})
					.catch((err) => {
						if (controller.signal.aborted) return;
						setError(String(err?.message ?? err));
						setLoading(false);
					});
				const statusController = new AbortController();
				const refreshStatus = () => {
					fetchStatus(browser.workspaceId, statusController.signal)
						.then(({ git, files }) => {
							if (statusController.signal.aborted) return;
							setIsGit(git);
							setStatusMap(new Map(files.map((f) => [f.path, f.status])));
						})
						.catch(() => {});
				};
				refreshStatus();
				const timer = setInterval(refreshStatus, STATUS_POLL_MS);
				return () => {
					clearInterval(timer);
					statusController.abort();
					for (const ctrl of abortsRef.current.values()) ctrl.abort();
					abortsRef.current.clear();
				};
			}, [browser.workspaceId]);

			const loadDir = (rel) => {
				const controller = new AbortController();
				abortsRef.current.set(rel, controller);
				setEntriesByPath((prev) => new Map(prev).set(rel, { status: "loading", entries: [] }));
				fetchTree(browser.workspaceId, rel, controller.signal)
					.then((data) => {
						if (controller.signal.aborted) return;
						setEntriesByPath((prev) => new Map(prev).set(rel, { status: "ready", entries: data.entries }));
					})
					.catch((err) => {
						if (controller.signal.aborted) return;
						setEntriesByPath((prev) => new Map(prev).set(rel, { status: "error", entries: [], message: String(err?.message ?? err) }));
					});
			};

			const toggle = (rel) => {
				if (expanded.has(rel)) {
					setExpanded((prev) => {
						const next = new Set(prev);
						next.delete(rel);
						return next;
					});
					return;
				}
				setExpanded((prev) => {
					const next = new Set(prev);
					next.add(rel);
					return next;
				});
				const cached = entriesByPath.get(rel);
				if (cached === void 0 || cached.status === "error") loadDir(rel);
			};

			const insert = (childRel, name) => {
				const root = rootPath || browser.path || "";
				const refPath = insertRefPath(root, childRel, sessions);
				if (!insertReferenceChip(sessions, conversation, refPath, name)) {
					console.warn("[dsh-filexplore] insert skipped: no active session composer");
				}
			};

			const renderLevel = (rel, depth) => {
				const dir = entriesByPath.get(rel);
				if (dir === void 0 || dir.status === "loading") {
					return h("div", { className: "fx-status", style: { paddingLeft: depth * 16 + 14 } },
						h(IconLoadingOutline16, { className: "fx-spin" }),
						h("span", null, t("browser.loading"))
					);
				}
				if (dir.status === "error") {
					return h("div", { className: "fx-status fx-status-error", style: { paddingLeft: depth * 16 + 14 } },
						h("span", null, `${t("browser.error")}: ${dir.message}`)
					);
				}
				if (dir.entries.length === 0) {
					return rel === "" ? h("div", { className: "fx-status", style: { paddingLeft: 14 } }, t("browser.empty")) : null;
				}
				return h(Fragment, null, dir.entries.map((entry) => {
					const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
					const badge = statusMap.get(childRel);
					if (entry.kind === "dir") {
						const isOpen = expanded.has(childRel);
						return h(Fragment, { key: childRel },
							h("div", {
								className: "fx-row",
								style: { paddingLeft: depth * 16 + 6 },
								onClick: () => toggle(childRel),
								onKeyDown: (e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										toggle(childRel);
									}
								}
							},
								h("span", { className: "fx-chevron", role: "button", tabIndex: 0, "aria-label": isOpen ? t("browser.collapse") : t("browser.expand"),
									onClick: (e) => { e.stopPropagation(); toggle(childRel); },
									onKeyDown: (e) => {
										if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(childRel); }
									}
								}, isOpen ? h(IconChevronDownOutline14, {}) : h(IconChevronRightOutline14, {})),
								h("span", { className: "fx-icon" }, isOpen ? h(IconFolderOpen16, {}) : h(IconFolderClose16, {})),
								h("span", { className: "fx-name" }, entry.name),
								badge !== void 0 && h("span", { className: `fxb-badge ${statusClass(badge)}` }, badge),
								h("button", { type: "button", className: "fxb-insert", title: t("browser.insert", { name: entry.name }), onClick: (e) => { e.stopPropagation(); insert(childRel, entry.name); } },
									h(IconPlusOutline16, {})
								)
							),
							isOpen ? renderLevel(childRel, depth + 1) : null
						);
					}
					return h("div", {
						key: childRel,
						className: "fx-row fx-row-file",
						role: "button",
						tabIndex: 0,
						title: t("browser.insert", { name: entry.name }),
						style: { paddingLeft: depth * 16 + 6 },
						onClick: () => panelsStore.openFile(childRel, entry.name),
						onKeyDown: (e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								panelsStore.openFile(childRel, entry.name);
							}
						}
					},
						h("span", { className: "fx-chevron fx-chevron-spacer" }),
						h("span", { className: "fx-icon fx-file-glyph" }),
						h("span", { className: "fx-name" }, entry.name),
						badge !== void 0 && h("span", { className: `fxb-badge ${statusClass(badge)}` }, badge),
						h("span", { className: "fx-meta" }, entry.size !== void 0 ? formatSize(entry.size) : ""),
						h("button", { type: "button", className: "fxb-insert", title: t("browser.insert", { name: entry.name }), onClick: (e) => { e.stopPropagation(); insert(childRel, entry.name); } },
							h(IconPlusOutline16, {})
						)
					);
				}));
			};

			return h("div", { className: "fxb-root", style: { height } },
				h("div", { className: "fxb-header" },
					h("div", { className: "fxb-header-text" },
						h("div", { className: "fxb-title" },
							h("span", { className: "fxb-title-icon" }, h(IconFolderOpen16, {})),
							h("span", { className: "fxb-title-name" }, browser.title)
						),
						h("div", { className: "fx-path" }, rootPath || browser.path || "")
					),
					h("div", { className: "fxb-actions" },
						h("button", { type: "button", className: "fxb-action", title: t("browser.refresh"), onClick: () => { panelsStore.setBrowser(browser.workspaceId, browser.title, browser.path); } },
							h(IconRefreshOutline16, {})
						),
						h("button", { type: "button", className: "fxb-action", title: t("browser.close"), "aria-label": t("browser.close"), onClick: () => { panelsStore.closeBrowser(); layout.closeRight(); } },
							h(IconCloseOutline16, {})
						)
					)
				),
				h("div", { className: "fxb-body" },
					loading ? h("div", { className: "fx-status" },
						h(IconLoadingOutline16, { className: "fx-spin" }),
						h("span", null, t("browser.loading"))
					) : error !== null ? h("div", { className: "fx-status fx-status-error" }, `${t("browser.error")}: ${error}`) : renderLevel("", 0)
				),
				h("div", { className: "fxb-footer" },
					isGit ? h("span", null, t("browser.legend")) : h("span", null, t("browser.noGit"))
				)
			);
		}

		// ── syntax highlighting + markdown + write ───────────────────────────
		/** Escape HTML for the highlighted <pre> (code view). */
		const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
		const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

		const KWS = {
			js: "const let var function return if else switch case default break continue for while do class extends super new this import export from as typeof instanceof void delete in of async await try catch finally throw yield null undefined true false static get set of",
			ts: "const let var function return if else switch case default break continue for while do class extends super new this import export from as typeof instanceof void delete in of async await try catch finally throw null undefined true false static get set interface type enum namespace implements readonly public private protected satisfies keyof declare abstract override mixed satisfies",
			py: "def class return if elif else for while import from as with try except finally raise lambda yield global nonlocal pass break continue and or not in is None True False assert async await del self match case",
			go: "package import func var const type struct interface map chan go defer return if else for range switch case default break continue select fallthrough nil true false",
			rust: "fn let mut const static struct enum trait impl use mod pub crate return if else for while loop match as move async await dyn self where type in ref unsafe true false",
			java: "public private protected class interface extends implements new return if else for while do switch case default break continue void static final abstract this super import package throws try catch finally throw instanceof true false null synchronized volatile transient native enum record var",
			c: "if else for while do switch case default break continue return void int long short char float double struct union enum typedef const static extern register volatile signed unsigned goto sizeof true false null",
			cpp: "if else for while do switch case default break continue return void int long short char float double struct union enum typedef const static extern register volatile signed unsigned goto sizeof template typename namespace class public private protected new delete this true false null try catch throw virtual override friend using static_cast const_cast dynamic_cast reinterpret_cast",
			cs: "public private protected internal class interface struct enum new return if else for while do switch case default break continue void static readonly const abstract virtual override sealed this base import using namespace try catch finally throw null true false async await",
			rb: "def class module return if elsif else unless case when while until for in do end require include extend lambda proc yield and or not true false nil self rescue ensure begin",
			php: "function return if elseif else foreach switch case default break continue while do for class public private protected static const new use namespace extends implements try catch finally throw true false null echo print isset empty array list $this",
			swift: "func return if else for while repeat switch case default break continue class struct enum protocol extension import var let guard throws try catch defer init deinit true false nil self super in where as is",
			kt: "fun return if else when for while do break continue class object interface enum val var private public internal protected import package try catch finally throw null true false this super typealias by in is as",
			dart: "void assert break case catch class const continue default do else enum extends false final finally for if in is new null rethrow return super switch this throw true try var while with abstract async await covariant default dynamic export external implements interface mixin part static factory get set",
			sh: "if then else elif fi for while do done case esac function local export read set unset exit break continue return in echo printf true false source trap test exec eval source",
			sql: "select from where and or not insert into values update set delete create table index view drop alter join inner left right full outer on group by order limit offset having distinct union all as primary key foreign references default null true false case when then else end exists like between in count sum avg min max asc desc",
			json: "true false null",
			yaml: "true false null yes no on off",
			toml: "true false",
			css: "",
			scss: "",
			less: "",
			html: "",
			xml: "",
			r: "function return if else for while repeat in next break library require c mean sum sd max min TRUE FALSE NA NULL print cat",
			lua: "function return if then elseif else for while do end local nil true false and or not repeat until break in pairs ipairs type",
			pl: "sub my our local return if elsif else unless for foreach while until do use package require new q qq open print chomp shift push pop scalar wantarray true false undef",
			hs: "module import data type newtype class instance where let in if then else case of deriving do pure return Maybe Just Nothing True False",
			clj: "def defn defmacro let if cond case when do fn loop recur return new nil true false quote symbol vector hash-map map reduce filter"
		};
		/** Comment line markers per language ([] = no line comments). */
		const CMT = { js: ["//"], ts: ["//"], py: ["#"], go: ["//"], rust: ["//"], java: ["//"], c: ["//"], cpp: ["//"], cs: ["//"], rb: ["#"], php: ["//"], swift: ["//"], kt: ["//"], dart: ["//"], sh: ["#"], sql: ["--"], json: [], yaml: ["#"], toml: ["#"], css: ["/*"], scss: ["//"], less: ["//"], html: ["<!--"], xml: ["<!--"], r: ["#"], lua: ["--"], pl: ["#"], hs: ["--"], clj: [";"] };
		/** Build LANG_DEFS: id, plaintext comment markers, keyword Set. */
		function buildLangs() {
			const map = {};
			for (const id of Object.keys(KWS)) {
				const kwStr = KWS[id];
				const ci = id === "sql";
				map[id] = {
					kw: new Set((ci ? kwStr.toLowerCase() : kwStr).split(/\s+/)),
					cmt: CMT[id] || [],
					ci
				};
			}
			map.plain = { kw: new Set(), cmt: [], ci: false };
			return map;
		}
		const LANG_DEFS = buildLangs();
		/** Extension → language id. */
		const EXT_TO_LANG = {
			js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "ts", mts: "ts", tts: "ts", tsx: "ts",
			py: "py", pyw: "py", go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "cs",
			rb: "rb", php: "php", swift: "swift", kt: "kt", darb: "dart", dart: "dart",
			sh: "sh", bash: "sh", zsh: "sh", sql: "sql", json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
			css: "css", scss: "scss", less: "less", html: "html", htm: "html", xml: "xml",
			r: "r", lua: "lua", pl: "pl", hs: "hs", clj: "clj", cljs: "clj"
		};
		/** Language config for a file name, or null when plain/unknown. */
		function langFor(name) {
			if (!name) return null;
			const ext = name.split(".").pop().toLowerCase();
			const id = EXT_TO_LANG[ext];
			return id ? LANG_DEFS[id] || null : null;
		}
		/** Is this a Markdown file (rendered, not highlighted)? */
		function isMarkdown(name) {
			if (!name) return false;
			const ext = name.split(".").pop().toLowerCase();
			return ext === "md" || ext === "markdown";
		}

		/** Highlight one line of code to an HTML string (empty/lang-null → escaped). */
		function highlightLine(line, lang) {
			if (!lang) return escapeHtml(line);
			const strAlt = `"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\\\n]|\\\\.)*\``;
			const numAlt = `\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b`;
			const parts = [];
			if (lang.cmt.length > 0) parts.push(lang.cmt.map(reEscape).map((m) => `${m}[^\\n]*`).join("|"));
			parts.push(strAlt, numAlt, "[A-Za-z_$][\\w$]*|.");
			const re = new RegExp(parts.join("|"), "g");
			let out = "";
			let m;
			while ((m = re.exec(line)) !== null) {
				const tok = m[0];
				let cls = "";
				if (lang.cmt.length > 0 && lang.cmt.some((p) => tok.startsWith(p))) cls = "cmt";
				else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith("`")) cls = "str";
				else if (/^\d/.test(tok)) cls = "num";
				else if (/^[A-Za-z_$]/.test(tok)) {
					const key = lang.ci === true ? tok.toLowerCase() : tok;
					if (lang.kw.has(key)) cls = "kw";
					else if (/^[A-Z]/.test(tok)) cls = "ty";
					else if (line[re.lastIndex] === "(") cls = "fn";
				}
				out += cls === "" ? escapeHtml(tok) : `<span class="fxh-${cls}">${escapeHtml(tok)}</span>`;
			}
			return out;
		}

		/** Render inline markdown to React nodes (strings are auto-escaped by React). */
		function renderInline(text) {
			const nodes = [];
			const re = /(`[^`]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
			let last = 0;
			let m;
			let i = 0;
			while ((m = re.exec(text)) !== null) {
				if (m.index > last) nodes.push(text.slice(last, m.index));
				if (m[1] !== void 0) nodes.push(h("code", { key: `c${i}`, className: "fxmd-code-inline" }, m[1].slice(1, -1)));
				else if (m[2] !== void 0) nodes.push(h("strong", { key: `b${i}` }, m[2].slice(2, -2)));
				else if (m[3] !== void 0) nodes.push(h("em", { key: `i${i}` }, m[3].slice(1, -1)));
				else if (m[4] !== void 0) nodes.push(h("a", { key: `a${i}`, href: m[6], target: "_blank", rel: "noreferrer" }, m[5]));
				last = re.lastIndex;
				i += 1;
			}
			if (last < text.length) nodes.push(text.slice(last));
			return nodes;
		}

		/** Highlighted code lines (used by markdown code fences). */
		function renderCodeLines(code, lang) {
			return h("div", { className: "fxv-lines" }, code.map((line, i) =>
				h("div", { key: i, className: "fxv-line" },
					h("span", { className: "fxv-ln" }, String(i + 1)),
					h("span", { className: "fxv-code-text", dangerouslySetInnerHTML: { __html: highlightLine(line, lang) } })
				)
			));
		}

		/** Render markdown source to a React element. */
		function renderMarkdown(src) {
			const elements = [];
			const lines = src.split("\n");
			let i = 0;
			let key = 0;
			while (i < lines.length) {
				const line = lines[i];
				if (line.trim() === "") { i += 1; continue; }
				const fence = line.match(/^```(\w*)\s*$/);
				if (fence !== null) {
					const id = fence[1] === "" ? null : EXT_TO_LANG[fence[1]] || null;
					const lang = id ? LANG_DEFS[id] || null : null;
					const code = [];
					i += 1;
					while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i += 1; }
					i += 1;
					elements.push(h("pre", { key }, h("code", { className: "fxmd-code" }, renderCodeLines(code, lang))));
					key += 1;
					continue;
				}
				const hd = line.match(/^(#{1,6})\s+(.*)/);
				if (hd !== null) {
					const level = Math.min(hd[1].length, 6);
					elements.push(h(`h${level}`, { key, className: `fxmd-h fxmd-h${level}` }, ...renderInline(hd[2])));
					key += 1; i += 1;
					continue;
				}
				if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(line)) {
					elements.push(h("hr", { key }));
					key += 1; i += 1;
					continue;
				}
				if (/^>/.test(line)) {
					const quote = [];
					const start = i;
					while (i < lines.length && /^>/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, "")); i += 1; }
					void start;
					elements.push(h("blockquote", { key, className: "fxmd-quote" }, h("p", null, ...renderInline(quote.join("\n")))));
					key += 1;
					continue;
				}
				if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
					const items = [];
					while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "")); i += 1; }
					elements.push(h("ul", { key, className: "fxmd-ul" }, items.map((it, j) => h("li", { key: j }, ...renderInline(it)))));
					key += 1;
					continue;
				}
				const para = [line];
				i += 1;
				while (i < lines.length) {
					const n = lines[i];
					if (n.trim() === "" || /^```/.test(n) || /^#{1,6}\s/.test(n) || /^\s*([-*_])\s*\1\s*\1\s*$/.test(n)) break;
					para.push(n);
					i += 1;
				}
				elements.push(h("p", { key, className: "fxmd-p" }, ...renderInline(para.join("\n"))));
				key += 1;
			}
			return elements.length ? h("div", { className: "fxmd" }, ...elements) : null;
		}

		/** Write text back to a workspace file (manual edit → save). */
		async function fetchWrite(workspaceId, rel, text, signal) {
			const params = new URLSearchParams({ workspace: workspaceId, path: rel });
			const res = await fetch(`/filexp/write?${params.toString()}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text }),
				signal
			});
			if (!res.ok) throw new Error(`filexp write failed: ${res.status}`);
			const data = await res.json();
			if (data.ok !== true) throw new Error("filexp write bad response");
			return data;
		}

		// ── file viewer with tabs ─────────────────────────────────────────────
		function FileViewerPanel({ t, sessions, conversation }) {
			const state = useSyncExternalStore(panelsStore.subscribe, panelsStore.getSnapshot);
			const viewer = state.viewer;
			const active = viewer.active;
			const content = active !== null ? viewer.contents.get(active) : void 0;
			const editable = content !== void 0 && content.status === "ready" && !content.binary && !content.truncated;
			const lang = active !== null ? langFor(active) : null;
			const md = active !== null && isMarkdown(active);

			const [editMode, setEditMode] = useState(false);
			const [draft, setDraft] = useState("");
			const [dirty, setDirty] = useState(false);
			const [saving, setSaving] = useState(false);

			// Lazy-fetch the active tab's content.
			useEffect(() => {
				if (active === null) return;
				const existing = viewer.contents.get(active);
				if (existing !== void 0 && existing.status !== "error") return;
				const controller = new AbortController();
				panelsStore.setContent(active, { status: "loading", text: "", binary: false, truncated: false });
				fetchFile(viewer.workspaceId, active, controller.signal)
					.then((data) => {
						if (controller.signal.aborted) return;
						panelsStore.setContent(active, {
							status: "ready",
							text: data.text ?? "",
							binary: data.binary === true,
							truncated: data.truncated === true,
							size: data.size
						});
					})
					.catch((err) => {
						if (controller.signal.aborted) return;
						panelsStore.setContent(active, { status: "error", text: "", binary: false, truncated: false, message: String(err?.message ?? err) });
					});
				return () => controller.abort();
			}, [active, viewer.workspaceId]);

			// Track the editing flag (Escape / Ctrl+S ownership) and reset edit state on tab change.
			useEffect(() => {
				if (editMode) viewerEditing += 1;
				else viewerEditing = Math.max(0, viewerEditing - 1);
				return () => {
					viewerEditing = Math.max(0, viewerEditing - 1);
				};
			}, [editMode]);
			useEffect(() => {
				setEditMode(false);
				setDraft("");
				setDirty(false);
				setSaving(false);
			}, [active, viewer.workspaceId]);

			if (active === null) return null;

			const insertActive = () => {
				const root = state.browser.path || "";
				const refPath = insertRefPath(root, active, sessions);
				const label = active.split("/").pop();
				if (!insertReferenceChip(sessions, conversation, refPath, label)) console.warn("[dsh-filexplore] insert skipped: no active session composer");
			};

			const guardDirty = () => (!dirty || window.confirm(t("viewer.confirmDiscard")));
			const startEdit = () => {
				if (!editable) return;
				setDraft(content.text);
				setDirty(false);
				setEditMode(true);
			};
			const cancelEdit = () => {
				setEditMode(false);
				setDraft("");
				setDirty(false);
			};
			const save = async () => {
				if (!dirty || saving || !editable) return;
				setSaving(true);
				try {
					const res = await fetchWrite(viewer.workspaceId, active, draft);
					panelsStore.setContent(active, { status: "ready", text: draft, binary: false, truncated: false, size: res.size });
					setEditMode(false);
					setDraft("");
					setDirty(false);
				} catch (err) {
					console.error("[dsh-filexplore] save failed:", err);
					window.alert(`${t("viewer.save")}: ${String(err?.message ?? err)}`);
				} finally {
					setSaving(false);
				}
			};

			const renderBody = () => {
				if (content === void 0 || content.status === "loading") {
					return h("div", { className: "fx-status" },
						h(IconLoadingOutline16, { className: "fx-spin" }),
						h("span", null, t("viewer.loading"))
					);
				}
				if (content.status === "error") {
					return h("div", { className: "fx-status fx-status-error" }, `${t("viewer.error")}: ${content.message}`);
				}
				if (content.binary) {
					return h("div", { className: "fx-status" }, t("viewer.binary", { size: formatSize(content.size) }));
				}

				if (editMode) {
					return h("div", { className: "fxv-edit-wrap" },
						content.truncated && h("div", { className: "fxv-notice" }, t("viewer.truncated", { size: formatSize(content.size) })),
						h("textarea", { className: "fxv-edit", value: draft, spellCheck: false, autoFocus: true, onChange: (e) => { setDraft(e.target.value); setDirty(true); } })
					);
				}

				const src = content.text;
				const lineCount = src.split("\n").length;
				const shown = lineCount > VIEWER_MAX_LINES;
				if (md) {
					const sliced = src.split("\n").slice(0, VIEWER_MAX_LINES).join("\n");
					return h("div", { className: "fxv-doc" },
						content.truncated && h("div", { className: "fxv-notice" }, t("viewer.truncated", { size: formatSize(content.size) })),
						shown && h("div", { className: "fxv-notice" }, t("viewer.long", { lines: VIEWER_MAX_LINES })),
						renderMarkdown(sliced)
					);
				}
				const lines = src.split("\n").slice(0, VIEWER_MAX_LINES);
				return h("div", { className: "fxv-code" },
					content.truncated && h("div", { className: "fxv-notice" }, t("viewer.truncated", { size: formatSize(content.size) })),
					shown && h("div", { className: "fxv-notice" }, t("viewer.long", { lines: VIEWER_MAX_LINES })),
					h("div", { className: "fxv-lines" }, lines.map((line, i) =>
						h("div", { key: i, className: "fxv-line" },
							h("span", { className: "fxv-ln" }, String(i + 1)),
							lang !== null
								? h("span", { className: "fxv-code-text", dangerouslySetInnerHTML: { __html: highlightLine(line, lang) } })
								: h("span", { className: "fxv-code-text" }, line === "" ? " " : line)
						)
					))
				);
			};

			const onSwitch = (rel) => {
				if (rel === active) return;
				if (!guardDirty()) return;
				panelsStore.setActive(rel);
			};
			const onClose = (rel) => {
				if (rel === active && !guardDirty()) return;
				panelsStore.closeTab(rel);
			};

			return h("div", { className: "fxv-root", onKeyDown: (e) => {
				if (!editMode) return;
				if (e.key === "Escape") {
					e.stopPropagation();
					cancelEdit();
				} else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
					e.preventDefault();
					save();
				}
			} },
				h("div", { className: "fxv-tabs" },
					h("div", { className: "fxv-tabs-list" }, viewer.tabs.map((rel) => {
						const name = rel.split("/").pop();
						const isActive = rel === active;
						return h("div", { key: rel, className: `fxv-tab${isActive ? " fxv-tab-active" : ""}`, onClick: () => onSwitch(rel), title: rel },
							h("span", { className: "fxv-tab-name" }, isActive && dirty ? `${name} ●` : name),
							h("button", { type: "button", className: "fxv-tab-close", "aria-label": t("viewer.closeTab"), title: t("viewer.closeTab"), onClick: (e) => { e.stopPropagation(); onClose(rel); } },
								h(IconCloseOutline16, {})
							)
						);
					})),
					h("div", { className: "fxv-tabs-actions" },
						editMode
							? h("div", { className: "fxv-btn-group" }, [
								h("button", { key: "s", type: "button", className: "fxv-save", disabled: !dirty || saving, onClick: save }, saving ? t("viewer.saving") : t("viewer.save")),
								h("button", { key: "c", type: "button", className: "fxv-cancel", disabled: saving, onClick: cancelEdit }, t("viewer.cancel"))
							])
							: h("div", { className: "fxv-btn-group" }, [
								h("button", { key: "e", type: "button", className: "fxv-editbtn", disabled: !editable, title: editable ? "" : t("viewer.readonly"), onClick: startEdit },
									h(IconEditOutline16, {}),
									h("span", null, t("viewer.edit"))),
								h("button", { key: "i", type: "button", className: "fxv-insert", onClick: insertActive },
									h(IconPlusOutline16, {}),
									h("span", null, t("viewer.insert")))
							])
					)
				),
				h("div", { className: "fxv-body" }, renderBody())
			);
		}

		// ── workspace-row button injection ────────────────────────────────────
		/**
		 * The Workspace rows in the sidebar are rendered by ui-workspace with no
		 * injectable action slot, so we enhance them from the DOM: find rows
		 * whose (nested) title matches a registered Workspace and append a
		 * folder button to the row's trailing actions container. Workspace rows
		 * nest their title inside a wrapper span while session rows keep theirs
		 * as a direct child — that structural difference keeps injection off
		 * session rows.
		 */
		function findWorkspaceRow(row, byTitle) {
			const spans = [...row.querySelectorAll("span")];
			for (const span of spans) {
				if (span.childElementCount !== 0) continue;
				const text = (span.textContent ?? "").trim();
				if (text === "") continue;
				const ws = byTitle.get(text);
				if (ws === void 0) continue;
				const nested = span.parentElement !== row && span.parentElement?.parentElement === row;
				if (!nested) continue;
				return { ws, title: text };
			}
			return null;
		}

		/** A tiny inline folder SVG (primitive icons are React-only). */
		function folderSvg() {
			const ns = "http://www.w3.org/2000/svg";
			const svg = document.createElementNS(ns, "svg");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("width", "14");
			svg.setAttribute("height", "14");
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "1.2");
			svg.setAttribute("stroke-linejoin", "round");
			const path = document.createElementNS(ns, "path");
			path.setAttribute("d", "M1.5 3.5a1 1 0 0 1 1-1h3l1.4 1.8h6.6a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z");
			svg.appendChild(path);
			return svg;
		}

		function ensureWorkspaceButtons(workspaces, layout, t) {
			const items = workspaces.list.getSnapshot().items ?? [];
			const byTitle = new Map();
			for (const ws of items) {
				if (ws?.title !== void 0 && ws.title !== "" && !byTitle.has(ws.title)) byTitle.set(ws.title, ws);
			}
			if (byTitle.size === 0) return;
			const rows = document.querySelectorAll('div[role="treeitem"]');
			for (const row of rows) {
				if (row.__fxBtn !== void 0) {
					if (row.__fxBtn.isConnected) continue;
					row.__fxBtn = void 0;
				}
				const found = findWorkspaceRow(row, byTitle);
				if (found === null) continue;
				const actions = [...row.children].filter((el) => el.tagName === "SPAN").pop();
				if (actions === void 0) continue;
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = "fx-row-button";
				btn.title = t("explore");
				btn.setAttribute("aria-label", t("explore.aria"));
				btn.appendChild(folderSvg());
				btn.addEventListener("click", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					const ws = found.ws;
					const panels = panelsStore.getSnapshot();
					if (panels.browser.open && panels.browser.workspaceId === ws.workspaceId) {
						layout.closeRight();
					} else {
						panelsStore.setBrowser(ws.workspaceId, ws.title, ws.path ?? "");
						layout.openRight();
					}
				});
				actions.appendChild(btn);
				row.__fxBtn = btn;
			}
		}

		/**
		 * Client plugin body. All registrations ride ctx.effect so they are
		 * torn down with the fiber.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-filexplore: dictionaries");

			const t = ctx.locale.bind(NS);
			const sessions = ctx.sessions;
			const workspaces = ctx.workspaces;
			const layout = ctx.layout;
			const inputTriggers = ctx.get("inputTriggers");
			const conversation = ctx.get("conversation");

			// ── @ file trigger source ──────────────────────────────────────────
			if (inputTriggers !== void 0) {
				const source = {
					trigger: "@",
					name: SOURCE,
					order: 20,
					candidates(session, { query, signal }) {
						return listFiles(session.sessionId, query, signal);
					},
					onPick({ candidate }) {
						return {
							insert: {
								source: SOURCE,
								ref: candidate.ref,
								label: candidate.name,
								clipboardText: mention(candidate.ref)
							}
						};
					},
					codec: {
						clipboardText: (ref) => mention(ref),
						serialize: (ref) => Promise.resolve(mention(ref))
					}
				};
				ctx.effect(() => inputTriggers.registerSource(source), "dsh-filexplore: @ file source");
			}

			// ── drag & drop: claim drops that contain at least one non-image ───
			const onDragOver = (event) => {
				if (!hasFiles(event)) return;
				const files = [...(event.dataTransfer?.files ?? [])];
				if (files.length === 0 || isImageOnly(files)) return;
				event.preventDefault();
				event.stopPropagation();
				if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
			};
			const onDrop = (event) => {
				if (!hasFiles(event)) return;
				const files = [...(event.dataTransfer?.files ?? [])];
				if (files.length === 0 || isImageOnly(files)) return;
				event.preventDefault();
				event.stopPropagation();
				intakeAndInsert(sessions, conversation, files).catch((error) => {
					console.error("[dsh-filexplore] intake failed:", error);
				});
			};
			ctx.effect(() => {
				window.addEventListener("dragover", onDragOver, true);
				window.addEventListener("drop", onDrop, true);
				return () => {
					window.removeEventListener("dragover", onDragOver, true);
					window.removeEventListener("drop", onDrop, true);
				};
			}, "dsh-filexplore: drop capture");

			// ── Escape closes the viewer, then the right column. ───────────────
			ctx.effect(() => {
				const onKey = (e) => {
					if (e.key !== "Escape") return;
					if (viewerEditing > 0) return; // a focused editor owns Escape
					const panels = panelsStore.getSnapshot();
					if (panels.viewer.open) {
						e.stopPropagation();
						panelsStore.closeViewer();
					} else if (panels.browser.open) {
						e.stopPropagation();
						panelsStore.closeBrowser();
						layout.closeRight();
					}
				};
				window.addEventListener("keydown", onKey, true);
				return () => window.removeEventListener("keydown", onKey, true);
			}, "dsh-filexplore: escape");

			// ── right column content: register into the layout's layout.right ──
			ctx.effect(() => ctx.slots.inject("layout.right", () => ctx.slots.register({
				name: "layout.right",
				id: "filexplore",
				locale: NS,
				inject: () => ({ t, sessions, conversation, workspaces, layout })
			}, RightPanels)), "dsh-filexplore: layout.right slot");

			// ── row button injection ───────────────────────────────────────────
			let scanQueued = false;
			const scheduleScan = () => {
				if (scanQueued) return;
				scanQueued = true;
				requestAnimationFrame(() => {
					scanQueued = false;
					ensureWorkspaceButtons(workspaces, layout, t);
				});
			};
			const observer = new MutationObserver(scheduleScan);
			observer.observe(document.body, { childList: true, subtree: true });
			const unsubscribeWorkspaces = workspaces.list.subscribe(scheduleScan);
			scheduleScan();

			ctx.effect(() => () => {
				observer.disconnect();
				unsubscribeWorkspaces();
			}, "dsh-filexplore: injection cleanup");
		}

		// ── injected styles ───────────────────────────────────────────────────
		const css = [
			// shared tree rows
			".fx-row{box-sizing:border-box;cursor:pointer;user-select:none;width:100%;height:26px;color:var(--dsw-alias-label-primary, #e8e8ea);display:flex;align-items:center;gap:4px;padding-right:8px;font-size:13px;line-height:26px}",
			".fx-row:hover{background:var(--dsw-alias-interactive-bg-hover, #ffffff14)}",
			".fx-row-file{cursor:pointer}",
			".fx-chevron{flex:none;width:14px;height:14px;color:var(--dsw-alias-label-tertiary, #8a8d93);display:inline-flex;align-items:center;justify-content:center}",
			".fx-chevron-spacer{visibility:hidden}",
			".fx-icon{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-secondary, #b8babe);display:inline-flex;align-items:center;justify-content:center}",
			".fx-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}",
			".fx-meta{flex:none;color:var(--dsw-alias-label-tertiary, #8a8d93);font-size:11px;margin-left:6px;font-variant-numeric:tabular-nums}",
			".fx-file-glyph{box-sizing:border-box;width:12px;height:14px;border:1px solid var(--dsw-alias-label-tertiary, #8a8d93);border-radius:2px;position:relative;opacity:.85}",
			".fx-file-glyph:after{content:'';position:absolute;top:-1px;right:-1px;width:4px;height:4px;border-bottom:1px solid var(--dsw-alias-label-tertiary, #8a8d93);border-left:1px solid var(--dsw-alias-label-tertiary, #8a8d93);background:var(--dsw-specific-menu, #1e1f24)}",
			".fx-status{color:var(--dsw-alias-label-tertiary, #8a8d93);display:flex;align-items:center;gap:8px;padding:14px;font-size:13px;line-height:20px}",
			".fx-status-error{color:var(--dsw-alias-state-error-primary, #e5534b)}",
			".fx-spin{animation:fx-spin .8s linear infinite}",
			"@keyframes fx-spin{to{transform:rotate(360deg)}}",
			".fx-path{color:var(--dsw-alias-label-tertiary, #8a8d93);font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}",
			".fx-row-button{cursor:pointer;flex:none;width:16px;height:16px;color:var(--dsw-alias-label-tertiary, #8a8d93);background:transparent;border:none;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;padding:0}",
			".fx-row-button:hover{color:var(--dsw-alias-label-primary, #e8e8ea)}",
			// git badges
			".fxb-badge{flex:none;min-width:16px;height:16px;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;line-height:16px;padding:0 3px}",
			".fxb-badge-untracked{color:#fff;background:#22a06b}",
			".fxb-badge-modified{color:#1f2328;background:#e2a03f}",
			".fxb-badge-deleted{color:#fff;background:#e5534b}",
			".fxb-badge-renamed{color:#fff;background:#4f8ff7}",
			".fxb-badge-added{color:#fff;background:#2da44e}",
			".fxb-badge-conflict{color:#fff;background:#e5534b}",
			// right column (rendered inside the layout's layout.right slot)
			".fxp-root{box-sizing:border-box;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-specific-sidebar-fill, #191a1f)}",
			".fxp-divider{box-sizing:border-box;cursor:row-resize;flex:none;height:5px;border-top:1px solid var(--dsw-alias-border-l2, #2a2b30);border-bottom:1px solid var(--dsw-alias-border-l2, #2a2b30);touch-action:none;position:relative}",
			".fxp-divider:after{content:'';position:absolute;left:0;right:0;top:50%;height:1px;background:transparent;transition:background .15s}",
			".fxp-divider:hover:after,.fxp-divider:active:after{background:var(--dsw-alias-state-business-primary, #4f8ff7)}",
			// browser panel (top section)
			".fxb-root{box-sizing:border-box;width:100%;flex:none;display:flex;flex-direction:column;min-height:0;overflow:hidden}",
			".fxb-header{display:flex;align-items:flex-start;gap:8px;padding:10px 10px 8px;border-bottom:1px solid var(--dsw-alias-border-l2, #2a2b30)}",
			".fxb-header-text{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}",
			".fxb-title{color:var(--dsw-alias-label-primary, #e8e8ea);font-size:13px;line-height:18px;display:flex;align-items:center;gap:6px;font-weight:500}",
			".fxb-title-icon{color:var(--dsw-alias-label-secondary, #b8babe);display:inline-flex}",
			".fxb-title-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".fxb-actions{flex:none;display:flex;align-items:center;gap:2px}",
			".fxb-action{cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-tertiary, #8a8d93);background:transparent;border:none;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;padding:0}",
			".fxb-action:hover{color:var(--dsw-alias-label-primary, #e8e8ea);background:var(--dsw-alias-interactive-bg-hover, #ffffff14)}",
			".fxb-body{flex:1;min-height:0;overflow-y:auto;padding:6px 0 8px}",
			".fxb-footer{color:var(--dsw-alias-label-tertiary, #8a8d93);padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l2, #2a2b30);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".fxb-insert{display:none;cursor:pointer;flex:none;width:16px;height:16px;color:var(--dsw-alias-label-tertiary, #8a8d93);background:transparent;border:none;border-radius:4px;align-items:center;justify-content:center;padding:0}",
			".fx-row:hover .fxb-insert{display:inline-flex}",
			".fxb-insert:hover{color:var(--dsw-alias-state-business-primary, #4f8ff7)}",
			// viewer panel (bottom section)
			".fxv-root{box-sizing:border-box;width:100%;flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-specific-menu, #1e1f24)}",
			".fxv-tabs{box-sizing:border-box;display:flex;align-items:stretch;min-height:36px;border-bottom:1px solid var(--dsw-alias-border-l2, #2a2b30);background:var(--dsw-specific-sidebar-fill, #191a1f)}",
			".fxv-tabs-list{display:flex;align-items:stretch;min-width:0;flex:1;overflow-x:auto;scrollbar-width:thin}",
			".fxv-tab{box-sizing:border-box;cursor:pointer;user-select:none;min-width:0;max-width:180px;height:35px;color:var(--dsw-alias-label-secondary, #b8babe);border-right:1px solid var(--dsw-alias-border-l2, #2a2b30);display:flex;align-items:center;gap:2px;padding:0 4px 0 10px;font-size:12px;line-height:35px;flex:none}",
			".fxv-tab:hover{background:var(--dsw-alias-interactive-bg-hover, #ffffff14)}",
			".fxv-tab-active{color:var(--dsw-alias-label-primary, #e8e8ea);background:var(--dsw-specific-menu, #1e1f24);box-shadow:inset 0 2px 0 var(--dsw-alias-state-business-primary, #4f8ff7)}",
			".fxv-tab-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
			".fxv-tab-close{cursor:pointer;flex:none;width:18px;height:18px;color:var(--dsw-alias-label-tertiary, #8a8d93);background:transparent;border:none;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;padding:0}",
			".fxv-tab-close:hover{color:var(--dsw-alias-label-primary, #e8e8ea);background:var(--dsw-alias-interactive-bg-hover, #ffffff14)}",
			".fxv-tabs-actions{flex:none;display:flex;align-items:center;gap:2px;padding:0 4px;border-left:1px solid var(--dsw-alias-border-l2, #2a2b30)}",
			".fxv-insert{cursor:pointer;height:24px;color:var(--dsw-alias-label-secondary, #b8babe);background:transparent;border:1px solid var(--dsw-alias-border-l2, #333);border-radius:6px;display:inline-flex;align-items:center;gap:4px;padding:0 8px;font-size:12px}",
			".fxv-insert:hover:not(:disabled){color:var(--dsw-alias-label-primary, #e8e8ea)}",
			".fxv-insert:disabled{opacity:.4;cursor:default}",
			".fxv-body{flex:1;min-height:0;overflow:auto}",
			".fxv-code{min-width:100%}",
			".fxv-notice{color:var(--dsw-alias-state-warn-label, #d9a03f);padding:6px 12px;font-size:12px;line-height:18px;background:var(--dsw-alias-interactive-bg-hover, #ffffff0a);border-bottom:1px solid var(--dsw-alias-border-l2, #2a2b30)}",
			".fxv-line{display:flex;align-items:stretch;min-width:max-content}",
			".fxv-line:hover{background:var(--dsw-alias-interactive-bg-hover, #ffffff0a)}",
			".fxv-ln{flex:none;width:44px;padding-right:10px;color:var(--dsw-alias-label-tertiary, #8a8d93);text-align:right;user-select:none;font-size:12px;line-height:20px;font-variant-numeric:tabular-nums}",
			".fxv-code-text{white-space:pre;padding:0 14px 0 10px;color:var(--dsw-alias-label-primary, #e8e8ea);font-size:12px;line-height:20px;font-family:var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)}",
			// syntax highlight token colors (VS Code dark palette)
			".fxh-cmt{color:#6a9955;font-style:italic}",
			".fxh-str{color:#ce9178}",
			".fxh-num{color:#b5cea8}",
			".fxh-kw{color:#569cd6;font-weight:500}",
			".fxh-fn{color:#dcdcaa}",
			".fxh-ty{color:#4ec9b0}",
			// edit mode
			".fxv-edit-wrap{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0}",
			".fxv-edit{box-sizing:border-box;flex:1;width:100%;min-height:0;border:none;outline:none;resize:none;background:transparent;color:var(--dsw-alias-label-primary, #e8e8ea);padding:8px 12px;font-size:12px;line-height:20px;font-family:var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);white-space:pre;tab-size:2}",
			".fxv-edit:focus{outline:none}",
			// markdown rendering
			".fxv-doc{box-sizing:border-box;padding:8px 16px 24px;color:var(--dsw-alias-label-primary, #e8e8ea);font-size:13px;line-height:1.7;overflow-wrap:break-word}",
			".fxmd-h{color:var(--dsw-alias-label-primary, #e8e8ea);margin:1em 0 .4em;font-weight:600;line-height:1.3}",
			".fxmd-h1{font-size:1.5em}",
			".fxmd-h2{font-size:1.3em}",
			".fxmd-h3{font-size:1.15em}",
			".fxmd-h4,.fxmd-h5,.fxmd-h6{font-size:1em}",
			".fxmd-p{margin:.4em 0}",
			".fxmd strong{font-weight:600}",
			".fxmd em{font-style:italic}",
			".fxmd a{color:var(--dsw-alias-state-business-primary, #4f8ff7);text-decoration:none}",
			".fxmd a:hover{text-decoration:underline}",
			".fxmd-code{border-radius:8px;background:var(--dsw-specific-sidebar-fill, #16171c);border:1px solid var(--dsw-alias-border-l2, #2a2b30);margin:.5em 0;padding:8px 0;overflow-x:auto;display:block}",
			".fxmd-code .fxv-ln{background:var(--dsw-specific-sidebar-fill, #16171c)}",
			".fxmd-code-inline{background:var(--dsw-alias-interactive-bg-hover, #ffffff14);border-radius:4px;padding:1px 5px;font-family:var(--dsw-font-family-mono, ui-monospace, Menlo, monospace);font-size:.9em}",
			".fxmd-ul{margin:.4em 0;padding-left:1.6em}",
			".fxmd-ul li{margin:.15em 0}",
			".fxmd-quote{border-left:3px solid var(--dsw-alias-border-l3, #3a3b42);margin:.5em 0;padding:0 0 0 12px;color:var(--dsw-alias-label-secondary, #b8babe)}",
			".fxmd hr{border:none;border-top:1px solid var(--dsw-alias-border-l2, #2a2b30);margin:1em 0}",
			// viewer action buttons
			".fxv-btn-group{display:flex;align-items:center;gap:6px}",
			".fxv-editbtn{cursor:pointer;height:24px;color:var(--dsw-alias-label-secondary, #b8babe);background:transparent;border:1px solid var(--dsw-alias-border-l2, #333);border-radius:6px;display:inline-flex;align-items:center;gap:4px;padding:0 8px;font-size:12px}",
			".fxv-editbtn:hover:not(:disabled){color:var(--dsw-alias-label-primary, #e8e8ea)}",
			".fxv-editbtn:disabled{opacity:.4;cursor:default}",
			".fxv-save{cursor:pointer;height:24px;color:#fff;background:var(--dsw-alias-button-info-fill, #4f8ff7);border:1px solid transparent;border-radius:6px;display:inline-flex;align-items:center;gap:4px;padding:0 12px;font-size:12px}",
			".fxv-save:hover:not(:disabled){background:var(--dsw-alias-button-info-hover, #3a7bd8)}",
			".fxv-save:disabled{opacity:.45;cursor:default}",
			".fxv-cancel{cursor:pointer;height:24px;color:var(--dsw-alias-label-secondary, #b8babe);background:transparent;border:1px solid var(--dsw-alias-border-l2, #333);border-radius:6px;display:inline-flex;align-items:center;gap:4px;padding:0 12px;font-size:12px}",
			".fxv-cancel:hover:not(:disabled){color:var(--dsw-alias-label-primary, #e8e8ea)}",
			".fxv-cancel:disabled{opacity:.4;cursor:default}"
		].join("");
		const tagId = "dsh-filexplore/client.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-filexplore";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
