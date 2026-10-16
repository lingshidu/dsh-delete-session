/**
 * dsh-delete-session — 会话「永久删除」的 Host 半。
 *
 * 职责：
 *   - 在 ctx.webServer 上注册同源路由，供客户端半（client.js）调用：
 *       POST /dsh-delete-session/delete   { sessionId } -> 删除单个会话
 *       POST /dsh-delete-session/inspect  { sessionId } -> 只做定位与校验，不删除
 *   - 删除 = 移除会话产物目录（<home>/sessions/<项目>/<会话>/）+ 维护工作区账目
 *     （unarchive + detach）+ 尽力清理投影缓存。
 *
 * 安全设计：
 *   - 活跃（本进程内 live）会话一律拒绝，避免删掉正在运行/已打开的会话。
 *   - 路径三重守卫：解析出的目录必须满足
 *       dirname(dirname(dir)) 的 basename === 'sessions'
 *     且该目录内确实存在 *.jsonl(.zstd) 会话产物，才允许递归删除。
 *   - 先删文件、后做簿记：任何失败都不会留下「已隐藏但未删除」的半删状态。
 *
 * 兼容性：依据 DSH 0.2.0-rc.2 的实际接口编写。
 *   - sessionPersistence.list() 返回 { header, revision, sizeBytes }[]（不是 header[]）
 *     这里对两种形状都兼容。
 *   - sessionPersistence.locate(header) 返回 { kind, path }，path 是**日志文件**路径，
 *     其 dirname 才是会话目录。
 */

import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const MODULE = '[dsh-delete-session]';

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

/**
 * 在 persistence.list() 的结果中按 id 找 header。
 * 兼容 0.1.x（header[]）与 0.2.x（{header,...}[]）两种形状。
 */
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
 * @returns {{ ok: true, dir: string, file: string, home: string }
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

  const file = location.path;
  const dir = dirname(file);
  const projectDir = dirname(dir);
  const sessionsRoot = dirname(projectDir);
  const home = dirname(sessionsRoot);

  /* 守卫 1：会话根目录必须真的叫 "sessions"，否则拒绝。 */
  if (basename(sessionsRoot) !== 'sessions') return { ok: false, code: 'bad-path' };
  /* 守卫 2：必须存在「项目目录 / 会话目录」两级，且互不相同。 */
  if (dir === projectDir || projectDir === sessionsRoot || sessionsRoot === home) {
    return { ok: false, code: 'bad-path' };
  }

  /* 守卫 3：该目录内必须存在会话产物文件。目录已不存在时视为已删除。 */
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error !== null && error.code === 'ENOENT') return { ok: false, code: 'missing' };
    return { ok: false, code: 'readdir-failed', detail: textOf(error) };
  }
  const hasArtifact = entries.some(
    (name) => name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'),
  );
  if (!hasArtifact) return { ok: false, code: 'not-a-session-dir' };

  return { ok: true, dir, file, home };
}

/** 工作区账目：把该会话从归档集合与归属工作区的 sessionIds 中摘掉。 */
async function detachFromLedger(registry, id) {
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
    /* 下次启动自愈 */
  }
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

/** 删除一个会话。结果写入 report 的四类桶。 */
async function deleteOne(deps, id, report) {
  if (deps.sessions.get(id) !== undefined) {
    report.live.push(id);
    return;
  }

  const resolved = await resolveSessionDir(deps.persistence, id);
  if (!resolved.ok) {
    if (resolved.code === 'missing') report.missing.push(id);
    else report.failed.push({ id, code: resolved.code, detail: resolved.detail });
    return;
  }

  /* 1) 先删文件。失败则状态完全未变。 */
  let freed = 0;
  try {
    freed = await directorySize(resolved.dir);
    await fs.rm(resolved.dir, { recursive: true, force: true });
  } catch (error) {
    report.failed.push({ id, code: 'rm-failed', detail: textOf(error) });
    return;
  }

  /* 2) 文件已删，做簿记（失败只影响显示）。 */
  await detachFromLedger(deps.registry, id);
  await dropProjectionCache(resolved.home, id);

  report.deleted.push(id);
  report.freed += freed;
  log(`deleted session ${id} (${freed} bytes) at ${resolved.dir}`);
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

export const name = 'dsh-delete-session';
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry', 'sessions'];

export function apply(ctx) {
  const deps = {
    persistence: ctx.sessionPersistence,
    registry: ctx.workspaceRegistry,
    sessions: ctx.sessions,
  };

  /** POST /dsh-delete-session/delete  { sessionId } */
  const handleDelete = async (req, res) => {
    const body = await readJsonBody(req);
    if (body === undefined || typeof body.sessionId !== 'string' || body.sessionId === '') {
      sendJson(res, 400, { ok: false, code: 'bad-args' });
      return;
    }
    const report = { deleted: [], live: [], missing: [], failed: [], freed: 0 };
    try {
      await deleteOne(deps, body.sessionId, report);
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'unknown', detail: textOf(error) });
      return;
    }
    if (report.deleted.length > 0) {
      sendJson(res, 200, { ok: true, freedBytes: report.freed });
      return;
    }
    if (report.live.length > 0) {
      sendJson(res, 409, { ok: false, code: 'live' });
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

  /** POST /dsh-delete-session/inspect  { sessionId } — 只做定位与校验，用于诊断。 */
  const handleInspect = async (req, res) => {
    const body = await readJsonBody(req);
    if (body === undefined || typeof body.sessionId !== 'string' || body.sessionId === '') {
      sendJson(res, 400, { ok: false, code: 'bad-args' });
      return;
    }
    const live = deps.sessions.get(body.sessionId) !== undefined;
    const resolved = await resolveSessionDir(deps.persistence, body.sessionId);
    sendJson(res, 200, {
      ok: true,
      live,
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
