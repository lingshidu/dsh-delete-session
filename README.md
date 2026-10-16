# dsh-delete-session

DSH（DeepSeek Harness）**0.2.x** 的会话「永久删除」插件。

补上官方缺失的能力：在侧栏**会话行**上删除该会话的全部本地记录。

---

## 为什么重写而不是修复旧插件

社区插件 `dsh-session-delete@0.1.0` 是按 DSH **0.1.0-rc.6** 写的，在 0.2.0-rc.2 上失效。它失效的方式是**静默**的 —— 不报错，菜单就是不出现。原因有两条，都源于它采用了 DOM 克隆 + React fiber 探测：

| 旧插件依赖 | 0.2.0-rc.2 实际 |
|---|---|
| 菜单 `memoizedProps.items` 数组 | 会话菜单改传 `children: renderSlot(...)`，**没有 items** |
| 会话行 props 含 `onArchive` | `SessionNodeItem({ node, currentId, now, onOpen, onRenameRequest, renderSlot, onReveal, drag, t })` —— **`onArchive`/`onFork` 已移除**（改由 slot 提供） |

本插件改为使用 DSH 0.2 **官方开放的 slot**，因此不依赖任何内部 props 或 DOM 结构：

- `sidebar.workspaces.session.menu.item` —— 会话行 `…` 菜单项
- `sidebar.workspaces.session.row.action` —— 会话行悬停图标按钮
- `shell.overlay` —— 确认对话框

---

## 功能

| 入口 | 行为 |
|---|---|
| 会话行 `…` 菜单 → **删除会话** | 红色危险项，排在内置 Archive 之后另起一组 |
| 会话行悬停 → 垃圾桶图标 | 同一动作的快捷入口 |
| 确认对话框 | 明确「不可恢复」；删除中显示进度；失败显示具体原因 |

删除是**永久的**，不可恢复（没有回收站）。删除内容：

1. 会话产物目录 `<DSH_HOME>/sessions/<项目编码>/<会话>/`（含日志文件）
2. 工作区账目：从 `archivedSessionIds` 与归属工作区的 `sessionIds` 中摘除
3. 投影缓存 `<DSH_HOME>/storages/session_projcache/sessions/<会话>.json`（尽力而为）

**运行中/已打开的会话一律拒绝删除**，包含当前会话。

---

## 安全设计

宿主半在动文件之前执行三重路径守卫，全部通过才允许递归删除：

1. `dirname(dirname(会话目录))` 的 basename 必须**恰好是 `sessions`**
2. 必须存在「项目目录 / 会话目录」两级且互不相同
3. 该目录内必须确实存在 `*.jsonl(.zstd)` 会话产物

另外遵循「**先删文件、后做簿记**」：文件删除失败时状态完全未变，不会留下「已隐藏但未删除」的半删状态。

写入路径用 `node:fs` 直接操作（不经 shell），因此没有命令注入面，也不需要引号转义。

---

## 安装

```bash
dsh plugin --profile <profile> add /path/to/dsh-delete-session
```

本地目录用 `file:` 协议（pnpm 会复制而非软链，改动源码后需重新执行安装）。安装后插件管理器会自动把它写入 profile 的 `dsh.profile.bundles`。

**安装后需要重载窗口**（Ctrl+R）或重启 DSH，客户端半才会被加载。

手动兜底：`pnpm add /path/to/dsh-delete-session`，然后在 profile 的 `cordis.patch.yml` 加入

```yaml
- insert:
    - id: dsh-delete-session
      name: dsh-delete-session
```

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-delete-session
```

## 验证

宿主半提供两个同源路由，可直接探测：

```bash
# 路由是否已加载（参数不合法应返回 400 bad-args）
curl -X POST http://127.0.0.1:19387/dsh-delete-session/delete \
     -H 'content-type: application/json' -d '{}'

# 只做定位与校验，不删除任何东西
curl -X POST http://127.0.0.1:19387/dsh-delete-session/inspect \
     -H 'content-type: application/json' -d '{"sessionId":"<会话id>"}'
```

`inspect` 返回 `{ ok, live, resolvable, dir }`，用于确认会话能否被正确定位。

---

## 实现要点

- **Host 半**（`index.js`）：`inject: ['webServer','sessionPersistence','workspaceRegistry','sessions']`。
  - `sessionPersistence.list()` 在 0.2.x 返回 `{ header, revision, sizeBytes }[]`（**不是** `header[]`），本插件兼容两种形状。
  - `sessionPersistence.locate(header)` 返回**日志文件**路径，其 `dirname` 才是会话目录。
- **Client 半**（`client.js`）：Module Loader 包（`window.__ModuleLoader__.load({ factory(require) })`）。
  - 组件身份模块级稳定；`@deepseek-ai/dsh-client-ui-primitives` 经 loader 的 `require` 解析（隐式 baseline external，不自带副本）。
  - 菜单项与浮层对话框通过模块级 store + `useSyncExternalStore` 共享待确认请求。

## 已知限制

- **工作区级批量操作无法通过 slot 实现**。0.2.0-rc.2 的工作区行菜单项是 `ProjectRowItem` 内写死的 `[{id:'rename'},{id:'delete'}]`，没有开放 slot。若需要「删除整个工作区的全部会话」，只能再走 DOM 注入那条脆弱路线，本插件有意不做。
- 会话行菜单项只在**会话行**出现；归档行同样可用。
- 兼容性依据 DSH `0.2.0-rc.2` 的实际接口编写。若宿主大版本升级后 slot 名称变化，`ctx.slots.inject()` 会等待声明，注册项只是不出现（不会报错）—— 可用窗口控制台的 `slots.inject(...)` 日志排查。

## License

MIT
