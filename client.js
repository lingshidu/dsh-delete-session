/**
 * dsh-delete-session — 会话「永久删除」的 Client 半（dsh.client web bundle）。
 *
 * 与旧版同类插件的根本区别：**不使用 DOM 克隆 / React fiber 探测**，
 * 而是走 DSH 0.2 官方开放的 slot：
 *   - sidebar.workspaces.session.menu.item  -> 会话行「…」菜单项
 *   - sidebar.workspaces.session.row.action -> 会话行悬停图标按钮
 *   - shell.overlay                         -> 确认对话框（挂在全局浮层）
 * 因此不受内部 props 改名、菜单结构变化影响（这正是旧插件在 0.2.0-rc.2 上
 * 会话菜单失效的原因）。
 *
 * 组件契约（来自 dsh-client-ui-workspace 的声明）：
 *   菜单/按钮条目只接收行身份 sessionId + displayTitle；
 *   菜单条目额外拿到 slot 级 hook useMenuOpenState 用于关闭菜单；
 *   组件身份必须模块级稳定。
 *
 * 载入形态：Module Loader 包（factory(require)），
 * @deepseek-ai/dsh-client-ui-primitives 是隐式 baseline external，
 * 必须经 loader 的 require 解析，不能自带副本。
 */

window.__ModuleLoader__.load({
	id: "dsh-delete-session",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var react = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		var NS = "dsh-delete-session";
		var ROUTE = "/dsh-delete-session/delete";

		/* ------------------------------------------------------------------ *
		 * locale 字典
		 * ------------------------------------------------------------------ */
		var en = {
			"menu.delete": "Delete session",
			"row.delete": "Delete session",
			"confirm.title": "Delete this session permanently?",
			"confirm.desc": "\u201c{title}\u201d and all of its local records will be removed. This cannot be undone.",
			"confirm.action": "Delete permanently",
			"confirm.pending": "Deleting\u2026",
			"cancel": "Cancel",
			"close": "Close",
			"done.title": "Session deleted",
			"done.resident": "The session files were removed, but the session was still resident in memory. Restart DSH to make the deletion fully permanent.",
			"error.running": "This session is running a turn. Stop it before deleting.",
			"error.busy": "This session is still open in a view. Switch to another session, then delete it.",
			"error.missing": "Session not found \u2014 it may already be deleted.",
			"error.bad-args": "Invalid request.",
			"error.no-location": "Could not locate this session's files on disk.",
			"error.bad-path": "Refused: the resolved path did not look like a session directory.",
			"error.not-a-session-dir": "Refused: no session log was found in that directory.",
			"error.readdir-failed": "Could not read the session directory.",
			"error.list-failed": "Could not read the session list.",
			"error.rm-failed": "Could not remove the session files.",
			"error.unknown": "Delete failed.",
		};

		var zh = {
			"menu.delete": "\u5220\u9664\u4f1a\u8bdd",
			"row.delete": "\u5220\u9664\u4f1a\u8bdd",
			"confirm.title": "\u6c38\u4e45\u5220\u9664\u8be5\u4f1a\u8bdd\uff1f",
			"confirm.desc": "\u201c{title}\u201d \u7684\u5168\u90e8\u672c\u5730\u8bb0\u5f55\uff08\u542b\u65e5\u5fd7\u6587\u4ef6\uff09\u5c06\u88ab\u5220\u9664\uff0c\u4e0d\u53ef\u6062\u590d\u3002",
			"confirm.action": "\u6c38\u4e45\u5220\u9664",
			"confirm.pending": "\u6b63\u5728\u5220\u9664\u2026",
			"cancel": "\u53d6\u6d88",
			"close": "\u5173\u95ed",
			"done.title": "\u5df2\u5220\u9664\u4f1a\u8bdd",
			"done.resident": "\u4f1a\u8bdd\u6587\u4ef6\u5df2\u5220\u9664\uff0c\u4f46\u5b83\u4ecd\u9a7b\u7559\u5728\u5185\u5b58\u4e2d\u3002\u91cd\u542f DSH \u53ef\u786e\u4fdd\u5f7b\u5e95\u751f\u6548\u3002",
			"error.running": "\u8be5\u4f1a\u8bdd\u6b63\u5728\u8fd0\u884c\u4e2d\uff08\u6709\u8fdb\u884c\u4e2d\u7684\u56de\u5408\uff09\u3002\u8bf7\u5148\u505c\u6b62\u5b83\u518d\u5220\u9664\u3002",
			"error.busy": "\u8be5\u4f1a\u8bdd\u4ecd\u5728\u67d0\u4e2a\u89c6\u56fe\u4e2d\u6253\u5f00\u3002\u8bf7\u5148\u5207\u6362\u5230\u5176\u4ed6\u4f1a\u8bdd\uff0c\u518d\u5220\u9664\u5b83\u3002",
			"error.missing": "\u672a\u627e\u5230\u8be5\u4f1a\u8bdd\uff0c\u53ef\u80fd\u5df2\u88ab\u5220\u9664\u3002",
			"error.bad-args": "\u8bf7\u6c42\u53c2\u6570\u65e0\u6548\u3002",
			"error.no-location": "\u65e0\u6cd5\u5b9a\u4f4d\u8be5\u4f1a\u8bdd\u7684\u78c1\u76d8\u6587\u4ef6\u3002",
			"error.bad-path": "\u5df2\u62d2\u7edd\uff1a\u89e3\u6790\u51fa\u7684\u8def\u5f84\u4e0d\u50cf\u4f1a\u8bdd\u76ee\u5f55\u3002",
			"error.not-a-session-dir": "\u5df2\u62d2\u7edd\uff1a\u8be5\u76ee\u5f55\u5185\u6ca1\u6709\u4f1a\u8bdd\u65e5\u5fd7\u3002",
			"error.readdir-failed": "\u65e0\u6cd5\u8bfb\u53d6\u4f1a\u8bdd\u76ee\u5f55\u3002",
			"error.list-failed": "\u65e0\u6cd5\u8bfb\u53d6\u4f1a\u8bdd\u5217\u8868\u3002",
			"error.rm-failed": "\u65e0\u6cd5\u5220\u9664\u4f1a\u8bdd\u6587\u4ef6\u3002",
			"error.unknown": "\u5220\u9664\u5931\u8d25\u3002",
		};

		/* 已知错误码白名单：只对这些码显示专门文案，其余走 unknown(+detail)。 */
		var KNOWN_ERROR_CODES = {
			running: 1, busy: 1, missing: 1, "bad-args": 1, "no-location": 1, "bad-path": 1,
			"not-a-session-dir": 1, "readdir-failed": 1, "list-failed": 1, "rm-failed": 1,
		};

		/* ------------------------------------------------------------------ *
		 * 待确认请求的极简 store（模块级：菜单项与浮层对话框共享同一实例）
		 * ------------------------------------------------------------------ */
		var pending = null;
		var listeners = new Set();
		var seq = 0;

		function notify() {
			listeners.forEach(function (listener) {
				try {
					listener();
				} catch (error) {
					console.error("[dsh-delete-session] listener", error);
				}
			});
		}

		function requestDelete(sessionId, title) {
			seq += 1;
			pending = { sessionId: sessionId, title: title, seq: seq };
			notify();
		}

		function clearPending() {
			if (pending === null) return;
			pending = null;
			notify();
		}

		function subscribePending(listener) {
			listeners.add(listener);
			return function () {
				listeners.delete(listener);
			};
		}

		function getPending() {
			return pending;
		}

		/* ------------------------------------------------------------------ *
		 * 组件（模块级稳定身份）
		 * ------------------------------------------------------------------ */

		/** 会话行「…」菜单项：危险样式，排在官方 Archive(400) 之后另起一组。 */
		function DeleteSessionMenuItem(props) {
			var t = props.t;
			var setMenuOpen = props.useMenuOpenState === undefined
				? undefined
				: props.useMenuOpenState[1];
			var onSelect = function () {
				if (setMenuOpen !== undefined) setMenuOpen(false);
				requestDelete(props.sessionId, props.displayTitle);
			};
			return react.createElement(
				primitives.MenuItemButton,
				{
					danger: true,
					separatorBefore: true,
					icon: react.createElement(primitives.IconTrashOutlineRegular, { size: 16 }),
					onSelect: onSelect,
				},
				t("menu.delete"),
			);
		}

		/** 会话行悬停图标按钮：与官方行内按钮同位置族（order 300）。 */
		function DeleteSessionRowButton(props) {
			var t = props.t;
			var onClick = function (event) {
				event.stopPropagation();
				event.preventDefault();
				requestDelete(props.sessionId, props.displayTitle);
			};
			return react.createElement(
				primitives.Tooltip,
				{ label: t("row.delete"), side: "bottom", align: "end", delayMs: 500 },
				react.createElement(
					"button",
					{
						type: "button",
						className: "dsd-iconButton",
						"aria-label": t("row.delete"),
						onClick: onClick,
					},
					react.createElement(primitives.IconTrashOutlineRegular, { size: 14 }),
				),
			);
		}

		/** shell.overlay 条目：无待确认请求时渲染 null。 */
		function DeleteSessionOverlay(props) {
			var request = react.useSyncExternalStore(subscribePending, getPending, getPending);
			if (request === null) return null;
			return react.createElement(DeleteConfirmForm, {
				key: request.sessionId + ":" + request.seq,
				request: request,
				t: props.t,
			});
		}

		/** 单个请求的确认框：in-flight / error 状态随请求一起销毁。 */
		function DeleteConfirmForm(props) {
			var request = props.request;
			var t = props.t;
			var busyPair = react.useState(false);
			var busy = busyPair[0];
			var setBusy = busyPair[1];
			var errorPair = react.useState(null);
			var error = errorPair[0];
			var setError = errorPair[1];
			var noticePair = react.useState(null);
			var notice = noticePair[0];
			var setNotice = noticePair[1];

			var close = function () {
				if (busy) return;
				clearPending();
			};

			var confirm = function () {
				setBusy(true);
				setError(null);
				fetch(ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId: request.sessionId }),
				})
					.then(function (response) {
						return response
							.json()
							.catch(function () {
								return {};
							})
							.then(function (data) {
								return { status: response.status, ok: response.ok, data: data };
							});
					})
					.then(function (result) {
						setBusy(false);
						if (result.ok && result.data !== null && result.data.ok === true) {
							/* 内存态未能释放时不立刻关闭：告知用户重启可确保彻底生效。 */
							if (result.data.resident === true) {
								setNotice(t("done.resident"));
								return;
							}
							clearPending();
							return;
						}
						var code = result.data !== null && typeof result.data.code === "string"
							? result.data.code
							: result.status === 409
								? "live"
								: result.status === 404
									? "missing"
									: "unknown";
						if (KNOWN_ERROR_CODES[code] === 1) {
							setError(t("error." + code));
							return;
						}
						var detail = result.data !== null && typeof result.data.detail === "string"
							? result.data.detail
							: "";
						setError(detail === "" ? t("error.unknown") : t("error.unknown") + " (" + detail + ")");
					})
					.catch(function (reason) {
						setBusy(false);
						setError(String((reason !== null && reason !== undefined && reason.message) || reason));
					});
			};

			var body = [];
			if (busy) {
				body.push(
					react.createElement(
						"div",
						{ key: "status", role: "status", className: "dsd-status" },
						t("confirm.pending"),
					),
				);
			}
			if (error !== null) {
				body.push(
					react.createElement(
						"div",
						{ key: "error", role: "alert", className: "dsd-error" },
						error,
					),
				);
			}

			/* 删除已完成但内存态仍在：显示结果说明而非直接关闭。 */
			if (notice !== null) {
				return react.createElement(
					primitives.Modal,
					{
						open: true,
						onClose: clearPending,
						closeLabel: t("close"),
						title: t("done.title"),
						description: notice,
						footer: react.createElement(
							primitives.Button,
							{ variant: "outline", onClick: clearPending },
							t("close"),
						),
					},
					null,
				);
			}

			return react.createElement(
				primitives.Modal,
				{
					open: true,
					onClose: close,
					closeLabel: t("close"),
					title: t("confirm.title"),
					description: t("confirm.desc", { title: request.title }),
					footer: react.createElement(
						react.Fragment,
						null,
						react.createElement(
							primitives.Button,
							{ variant: "outline", disabled: busy, onClick: close },
							t("cancel"),
						),
						react.createElement(
							primitives.Button,
							{ variant: "outline", className: "dsd-dangerButton", disabled: busy, onClick: confirm },
							t("confirm.action"),
						),
					),
				},
				body,
			);
		}

		/* ------------------------------------------------------------------ *
		 * 注入样式（仅本插件自己的几个类，全部走主题变量）
		 * ------------------------------------------------------------------ */
		var STYLE_ID = "dsh-delete-session/plugin.css";
		var CSS = [
			".dsd-dangerButton{color:var(--dsw-alias-state-error-primary,#d92d20);border-color:var(--dsw-alias-state-error-primary,#d92d20);}",
			".dsd-dangerButton:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 10%,transparent);}",
			".dsd-iconButton{cursor:pointer;width:24px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);}",
			".dsd-iconButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-state-error-primary,#d92d20);}",
			".dsd-status{font-size:13px;color:var(--dsw-alias-label-secondary,#6b7280);margin-top:12px;}",
			".dsd-error{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary,#d92d20);margin-top:12px;white-space:pre-wrap;word-break:break-word;}",
		].join("\n");

		/* ------------------------------------------------------------------ *
		 * apply
		 * ------------------------------------------------------------------ */
		function apply(ctx) {
			/* 样式：自挂 <style>，随插件卸载移除。 */
			ctx.effect(function () {
				if (typeof document === "undefined" || document.head === null) return function () {};
				if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) {
					return function () {};
				}
				var tag = document.createElement("style");
				tag.setAttribute("data-plugin-css", STYLE_ID);
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return function () {
					if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
				};
			}, "dsh-delete-session: styles");

			/* 文案字典。 */
			ctx.effect(function () {
				return ctx.locale.register(NS, { en: en, zh: zh });
			}, "dsh-delete-session: dictionaries");

			/* 会话行「…」菜单项。order 500 落在官方 archive(400) 之后。 */
			ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
				return ctx.slots.register(
					{
						name: "sidebar.workspaces.session.menu.item",
						id: "dsh-delete-session.delete",
						order: 500,
						locale: NS,
					},
					DeleteSessionMenuItem,
				);
			});

			/* 会话行悬停图标按钮。 */
			ctx.slots.inject("sidebar.workspaces.session.row.action", function () {
				return ctx.slots.register(
					{
						name: "sidebar.workspaces.session.row.action",
						id: "dsh-delete-session.delete",
						order: 300,
						locale: NS,
					},
					DeleteSessionRowButton,
				);
			});

			/* 确认对话框：挂到全局浮层。 */
			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register(
					{
						name: "shell.overlay",
						id: "dsh-delete-session.confirm",
						locale: NS,
					},
					DeleteSessionOverlay,
				);
			});

			console.log("[dsh-delete-session] client ready");
		}

		exports.name = "dsh-delete-session";
		exports.inject = ["slots", "locale"];
		exports.apply = apply;
		return module.exports;
	},
});
