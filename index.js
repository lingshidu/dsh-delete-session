/**
 * dsh-delete-session — 会话「永久删除」的 Host 半。
 *
 * 路由（同源，供客户端半调用）：
 *   POST /dsh-delete-session/delete   { sessionId } -> 永久删除一个会话
 *   POST /dsh-delete-session/inspect  { sessionId } -> 只做诊断，不修改任何状态
 *
 * ── 为什么不能简单地「live 就拒绝」────────────────────────────────────────
 * DSH 0.2 的侧栏用 session 作用域 slot 渲染会话行，官方文档明确写了这会
 * 「激活并保留列表中每个 Session」。也就是说**凡是出现在列表里的会话都是
 * live 的**（ctx.sessions.get(id) 非 undefined）。若据此拒绝，会导致所有
 * 会话都删不掉。
 *
 * 真正危险的是「正在运行」和「仍被某个查看器持有」，因此删除流程是：
 *
 *   1. 运行中检查：ctx.agents.get(id)?.status === 'running' -> 拒绝
 *   2. 解析并校验会话目录（三重守卫）
 *   3. 摘除工作区账目 —— 让侧栏行消失，客户端随之释放它的 session scope
 *   4. 等待宿主卸载该会话（轮询 ctx.sessions.get(id) 变 undefined）
 *      · 等到   -> 内存态已释放，可以安全删文件
 *      · 等不到 -> 说明仍有查看器持有（例如它正开在主视图），回滚账目并拒绝
 *   5. 删除会话产物目录（带重试，处理 Windows 瞬时文件占用）
 *      · 失败   -> 回滚账目并报错
 *   6. 清理投影缓存（尽力而为）
 *
 * 这样「删掉正在运行的会话」和「已删除却被内存态回写复活」都不会发生。
 *
 * 安全守卫（删除前全部必须通过）：
 *   - dirname(dirname(会话目录)) 的 basename 必须恰好是 'sessions'
 *   - 必须存在「项目目录 / 会话目录」两级且互不相同
 *   - 目录内必须确实存在 *.jsonl(.zstd) 会话产物
 * 写入路径用 node:fs 直接操作（不经 shell），无命令注入面。
 *
 * 兼容性依据 DSH 0.2.0-rc.2 实际接口：
 *   - sessionPersistence.list() 返回 { header, revision, sizeBytes }[]（这里兼容两种形状）
 *   - sessionPersistence.locate(header) 返回 { kind, path }，path 是**日志文件**路径，
 *     其 dirname 才是会话目录
 *   - workspaceRegistry.list()[i] 是实体，提供 sessionIds / attachSession / detachSession
 */

import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const MODULE = '[dsh-delete-session]';
/** 等待宿主释放内存态会话的上限；超时即认为它仍被某个查看器持有。 */
const RELEASE_TIMEOUT_MS = 2500;
const RELEASE_POLL_MS = 150;
/** 删除失败后的重试次数与间隔（Windows 上文件可能被瞬时占用）。 */
const REMOVE_ATTEMPTS = 4;
const REMOVE_RETRY_MS = 220;

function log(...args) {
  console.error(MODULE, ...args);
}

function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value.message === 'string') return value.message;
  try {
    return String(value);
  } catch {
    return '';
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 收集并解析 JSON 请求体；空体返回 {}，非法 JSON 返回 undefined。 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 兼容 0.1.x（header[]）与 0.2.x（{header,...}[]）两种 list() 形状。 */
async function findHeader(persistence, id) {
  const snapshots = await persistence.list();
  if (!Array.isArray(snapshots)) return undefined;
  for (const entry of snapshots) {
    if (entry === null || entry === undefined) continue;
    const header = entry.header !== undefined ? entry.header : entry;
    if (header !== null && typeof header === 'object' && header.id === id) return header;
  }
  return undefined;
}

/**
 * 把一个 sessionId 解析成「可安全删除的会话目录」。
 * @returns {{ ok: true, dir: string, home: string }
 *          | { ok: false, code: string, detail?: string }}
 */
async function resolveSessionDir(sessionPersistence, id) {
  let header;
  try {
    header = await findHeader(sessionPersistence, id);
  } catch (error) {
    return { ok: false, code: 'list-failed', detail: textOf(error) };
  }
  if (header === undefined) return { ok: false, code: 'missing' };

  let location;
  try {
    location = sessionPersistence.locate(header);
  } catch {
    location = undefined;
  }
  if (location === undefined || typeof location.path !== 'string' || location.path === '') {
    return { ok: false, code: 'no-location' };
  }

  const dir = dirname(location.path);
  const projectDir = dirname(dir);
  const sessionsRoot = dirname(projectDir);
  const home = dirname(sessionsRoot);

  /* 守卫 1：会话根目录必须真的叫 "sessions"。 */
  if (basename(sessionsRoot) !== 'sessions') return { ok: false, code: 'bad-path' };
  /* 守卫 2：必须存在「项目目录 / 会话目录」两级，且互不相同。 */
  if (dir === projectDir || projectDir === sessionsRoot || sessionsRoot === home) {
    return { ok: false, code: 'bad-path' };
  }

  /* 守卫 3：目录内必须存在会话产物；目录已不存在时视为已删除。 */
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error !== null && error.code === 'ENOENT') return { ok: false, code: 'missing' };
    return { ok: false, code: 'readdir-failed', detail: textOf(error) };
  }
  if (!entries.some((name) => name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'))) {
    return { ok: false, code: 'not-a-session-dir' };
  }

  return { ok: true, dir, home };
}

/** 记录该会话当前的账目归属，供失败回滚使用。 */
function captureLedger(registry, id) {
  const archived = Array.isArray(registry.archivedSessionIds)
    && registry.archivedSessionIds.includes(id);
  let workspace;
  try {
    for (const candidate of registry.list()) {
      const ids = candidate === null || candidate === undefined ? undefined : candidate.sessionIds;
      if (Array.isArray(ids) && ids.includes(id)) {
        workspace = candidate;
        break;
      }
    }
  } catch {
    workspace = undefined;
  }
  return { archived, workspace };
}

/** 摘除账目：让侧栏行消失，从而让客户端释放它的 session scope。 */
async function detachLedger(registry, id) {
  try {
    await registry.unarchiveSession(id);
  } catch {
    /* 未归档 / 竞态：忽略 */
  }
  try {
    for (const workspace of registry.list()) {
      const ids = workspace === null || workspace === undefined ? undefined : workspace.sessionIds;
      if (Array.isArray(ids) && ids.includes(id)) {
        await workspace.detachSession(id);
        break;
      }
    }
  } catch {
    /* 忽略：下面按实际状态继续 */
  }
}

/** 回滚账目到 captureLedger 记录的状态。 */
async function restoreLedger(registry, id, prior) {
  try {
    if (prior.workspace !== undefined) await prior.workspace.attachSession(id);
  } catch {
    /* 忽略 */
  }
  try {
    if (prior.archived) await registry.archiveSession(id);
  } catch {
    /* 忽略 */
  }
}

/** 轮询等待宿主卸载该会话；返回是否成功释放。 */
async function waitForRelease(sessions, id) {
  const deadline = Date.now() + RELEASE_TIMEOUT_MS;
  for (;;) {
    if (sessions.get(id) === undefined) return true;
    if (Date.now() >= deadline) return false;
    await delay(RELEASE_POLL_MS);
  }
}

/** 删除目录，对瞬时占用做有限重试。 */
async function removeDirWithRetry(dir) {
  let lastError;
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error !== null && error.code === 'ENOENT') return;
      lastError = error;
      await delay(REMOVE_RETRY_MS);
    }
  }
  throw lastError;
}

/** 投影缓存（尽力而为）：<home>/storages/session_projcache/sessions/<id>.json */
async function dropProjectionCache(home, id) {
  try {
    const target = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`);
    if (basename(target) !== `${id}.json`) return;
    await fs.rm(target, { force: true });
  } catch {
    /* 缓存是尽力清理，失败不影响删除结果 */
  }
}

/** 递归统计目录字节数（仅用于回报，失败返回 0）。 */
async function directorySize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await directorySize(child);
      else total += (await fs.stat(child)).size;
    } catch {
      /* 忽略不可读项 */
    }
  }
  return total;
}

/** 会话是否正在运行（有进行中的 turn）。 */
function isRunning(agents, id) {
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return false;
  try {
    const agent = agents.get(id);
    return agent !== null && agent !== undefined && agent.status === 'running';
  } catch {
    return false;
  }
}

/** 删除一个会话；结果写入 report 的各桶。 */
async function deleteOne(deps, id, report) {
  /* 1) 运行中一律拒绝。 */
  if (isRunning(deps.agents, id)) {
    report.running.push(id);
    return;
  }

  /* 2) 定位并校验目录（此时文件必须还在）。 */
  const resolved = await resolveSessionDir(deps.persistence, id);
  if (!resolved.ok) {
    if (resolved.code === 'missing') report.missing.push(id);
    else report.failed.push({ id, code: resolved.code, detail: resolved.detail });
    return;
  }

  /* 3) 摘账目，让客户端释放 session scope。 */
  const prior = captureLedger(deps.registry, id);
  await detachLedger(deps.registry, id);

  /* 4) 等宿主卸载内存态。摘账目后侧栏行会消失，客户端随之释放 session scope，
   *    宿主即可卸载会话——这时删文件才安全（不会被内存态回写复活）。
   *    若超时仍未释放（例如它正开在主视图），仍然继续删除，但回报 resident，
   *    由前端提示用户：内存态可能回写，重启 DSH 可确保彻底生效。 */
  const released = await waitForRelease(deps.sessions, id);
  if (!released) report.resident = true;

  /* 5) 删文件。失败则回滚账目，不留下「已隐藏但未删除」。 */
  let freed = 0;
  try {
    freed = await directorySize(resolved.dir);
    await removeDirWithRetry(resolved.dir);
  } catch (error) {
    await restoreLedger(deps.registry, id, prior);
    report.failed.push({ id, code: 'rm-failed', detail: textOf(error) });
    return;
  }

  /* 6) 清理缓存（失败无妨）。 */
  await dropProjectionCache(resolved.home, id);

  report.deleted.push(id);
  report.freed += freed;
  log(`deleted session ${id} (${freed} bytes) at ${resolved.dir}`);
}

export const name = 'dsh-delete-session';
export const inject = [
  'webServer',
  'sessionPersistence',
  'workspaceRegistry',
  'sessions',
  'agents',
];

export function apply(ctx) {
  const deps = {
    persistence: ctx.sessionPersistence,
    registry: ctx.workspaceRegistry,
    sessions: ctx.sessions,
    agents: ctx.agents,
  };

  /** POST /dsh-delete-session/delete  { sessionId } */
  const handleDelete = async (req, res) => {
    const body = await readJsonBody(req);
    if (body === undefined || typeof body.sessionId !== 'string' || body.sessionId === '') {
      sendJson(res, 400, { ok: false, code: 'bad-args' });
      return;
    }
    const report = { deleted: [], running: [], missing: [], failed: [], freed: 0, resident: false };
    try {
      await deleteOne(deps, body.sessionId, report);
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'unknown', detail: textOf(error) });
      return;
    }
    if (report.deleted.length > 0) {
      sendJson(res, 200, { ok: true, freedBytes: report.freed, resident: report.resident });
      return;
    }
    if (report.running.length > 0) {
      sendJson(res, 409, { ok: false, code: 'running' });
      return;
    }
    if (report.missing.length > 0) {
      sendJson(res, 404, { ok: false, code: 'missing' });
      return;
    }
    const failure = report.failed[0];
    sendJson(res, 500, {
      ok: false,
      code: failure === undefined ? 'unknown' : failure.code,
      detail: failure === undefined || failure.detail === undefined ? '' : failure.detail,
    });
  };

  /** POST /dsh-delete-session/inspect  { sessionId } — 只诊断，不修改任何状态。 */
  const handleInspect = async (req, res) => {
    const body = await readJsonBody(req);
    if (body === undefined || typeof body.sessionId !== 'string' || body.sessionId === '') {
      sendJson(res, 400, { ok: false, code: 'bad-args' });
      return;
    }
    const id = body.sessionId;
    const resolved = await resolveSessionDir(deps.persistence, id);
    sendJson(res, 200, {
      ok: true,
      live: deps.sessions.get(id) !== undefined,
      running: isRunning(deps.agents, id),
      resolvable: resolved.ok,
      dir: resolved.ok ? resolved.dir : undefined,
      code: resolved.ok ? undefined : resolved.code,
      detail: resolved.ok ? undefined : resolved.detail,
    });
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/dsh-delete-session/delete', handler: handleDelete }),
    'dsh-delete-session: delete route',
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/dsh-delete-session/inspect', handler: handleInspect }),
    'dsh-delete-session: inspect route',
  );

  log('host ready: POST /dsh-delete-session/{delete,inspect}');
}
