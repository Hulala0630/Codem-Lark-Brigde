#!/usr/bin/env node
/**
 * CodeM 建群 Webhook 服务（零依赖，Node >= 18）
 *
 * 功能：接收 webhook 请求，自动创建飞书群聊：
 *   - 群名动态传入
 *   - 默认把请求发起人（服务部署者，即 lark-cli 登录用户）拉进群
 *   - 可选拉指定成员（支持姓名 / 邮箱 / open_id）
 *   - 自动把 CodeM 机器人拉进群（app_id 见 CODEM_BOT_APP_ID）
 *
 * 环境变量：
 *   PORT             监听端口，默认 3210
 *   HOST             监听地址，默认 0.0.0.0（仅本机测试可改 127.0.0.1）
 *   WEBHOOK_TOKEN    可选；设置后请求需带 header `X-Webhook-Token`
 *   CODEM_BOT_APP_ID CodeM 机器人的 app_id，默认 cli_aac5d4db58385cd3
 *   LARK_CLI         lark-cli 可执行文件路径，默认 lark-cli
 *
 * 请求：POST /webhook/group
 *   Content-Type: application/json
 *   {
 *     "name":     "群名（必填，<= 60 字）",
 *     "description": "群描述（可选，<= 100 字）",
 *     "members":  ["张三", "lisi@corp.com", "ou_xxx"],   // 可选，混合传姓名/邮箱/open_id
 *     "include_me": true                                  // 可选，默认 true
 *   }
 * 响应：{ ok, chat_id, chat_name, link, unresolved_members }
 */

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// ---------- 工作项 → 群映射持久化 ----------
const DATA_DIR = path.join(__dirname, 'data');
const MAP_FILE = path.join(DATA_DIR, 'workitem-groups.json');

function loadGroupMap() {
  try { return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch { return {}; }
}
function saveGroupMap(map) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2)); } catch (e) { console.error('[map] save failed:', e.message); }
}

const PORT = parseInt(process.env.PORT || '3210', 10);
const HOST = process.env.HOST || '0.0.0.0';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';
const CODEM_BOT_APP_ID = process.env.CODEM_BOT_APP_ID || 'cli_aac5d4db58385cd3';
const LARK_CLI = process.env.LARK_CLI || 'lark-cli';
// 服务部署者（lark-cli 登录用户）的 open_id，include_me 时拉进群
const OWNER_OPEN_ID = process.env.OWNER_OPEN_ID || 'ou_65293baac0acd0ca02ccf7bcbd4a24b8';

function runLarkCli(args) {
  return new Promise((resolve) => {
    execFile(LARK_CLI, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* keep null */ }
      resolve({ err, stderr, parsed, raw: stdout });
    });
  });
}

// ---------- Meego 工作项事件 → 待建群草稿 ----------
// 收到 WorkitemUpdateEvent 后生成草稿并自动打开前端页面，由用户确认机器人/成员后建群
const pendingGroups = new Map();
let pendingSeq = 0;

function baseUrl(req) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  return `http://${host}`;
}

// 自动打开浏览器（部署机为 macOS 时；其它平台仅打印链接）
function openBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      require('node:child_process').spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
  } catch { /* ignore */ }
  console.log(`[pending] open in browser: ${url}`);
  return false;
}

// Meego changed_fields → 群内首条消息文本
function formatChangedFields(changedFields, wi) {
  const fields = Array.isArray(changedFields) ? changedFields : [];
  const lines = [];
  for (const f of fields) {
    const label = f.field_alias || f.field_key || 'field';
    const pick = (v, md) => {
      if (md && typeof md === 'object' && typeof md.markdown === 'string') return md.markdown;
      if (v === null || v === undefined || v === '') return '(空)';
      if (typeof v === 'string') return v;
      return JSON.stringify(v);
    };
    const pre = pick(f.pre_field_value, f.pre_field_value_markdown);
    const cur = pick(f.cur_field_value, f.cur_field_value_markdown);
    const t = (s) => (s.length > 120 ? s.slice(0, 117) + '...' : s);
    lines.push(`- ${label}：${t(pre)} → ${t(cur)}`);
  }
  const head = `【Meego 工作项变更】${wi.type || 'workitem'}#${wi.id}「${wi.name || ''}」`;
  return lines.length ? `${head}\n${lines.join('\n')}` : head;
}

function handleMeegoEvent(body) {
  const payload = (body && body.payload) || {};
  const id = payload.id;
  if (!id) return { status: 400, payload: { ok: false, error: 'payload.id (工作项 id) 缺失' } };

  const type = payload.work_item_type_key || 'workitem';
  const wiName = (payload.name || '').trim();
  const project = payload.project_simple_name || payload.project_key || '';
  const groupName = wiName ? `${type}#${id} ${wiName}`.slice(0, 60) : `${type}#${id}`.slice(0, 60);
  const description = `Meego 工作项：${type} #${id}${wiName ? `「${wiName}」` : ''}${project ? `（空间：${project}）` : ''}。由 webhook 自动创建`.slice(0, 100);

  const pid = String(++pendingSeq);
  const existing = loadGroupMap()[String(id)];
  const wi = { id, name: wiName, type, project };
  pendingGroups.set(pid, {
    pending_id: pid,
    created_at: Date.now(),
    source: 'meego',
    work_item: wi,
    mode: existing ? 'update' : 'create',
    existing_chat: existing || null,
    name: groupName,
    description,
    changed_text: formatChangedFields(payload.changed_fields, wi),
    updated_by: payload.updated_by || '',
    updated_at: payload.updated_at || null,
  });
  return {
    status: 200,
    payload: existing
      ? { ok: true, pending_id: pid, mode: 'update', existing_chat: existing }
      : { ok: true, pending_id: pid, mode: 'create', group_name: groupName },
  };
}

// 把一个成员标识（姓名/邮箱/open_id）解析为 open_id
async function resolveMember(idOrName) {
  const s = String(idOrName).trim();
  if (!s) return { input: idOrName, error: 'empty' };
  if (/^ou_[0-9a-f]{16,}$/i.test(s)) return { openId: s };
  if (/^on_[0-9a-f]{16,}$/i.test(s)) return { openId: s, idType: 'union_id' };

  const r = await runLarkCli([
    'contact', '+search-user', '--query', s, '--exclude-external-users', '--as', 'user', '--json',
  ]);
  if (!r.parsed || !r.parsed.ok) {
    return { input: s, error: (r.parsed && r.parsed.error && r.parsed.error.message) || 'search failed' };
  }
  const users = (r.parsed.data && r.parsed.data.users) || [];
  if (!users.length) return { input: s, error: 'no match' };
  // 同名多人：优先精确匹配，其次取第一个并在结果里提示
  const exact = users.find((u) => u.name === s || (u.email && u.email.toLowerCase() === s.toLowerCase()));
  const hit = exact || users[0];
  return {
    openId: hit.open_id,
    name: hit.name,
    ambiguous: !exact && users.length > 1 ? users.map((u) => u.name) : undefined,
  };
}

// 发送群内消息（以用户身份）
async function sendChatMessage(chatId, text) {
  const r = await runLarkCli(['im', '+messages-send', '--chat-id', chatId, '--text', text, '--as', 'user', '--json']);
  return r.parsed && r.parsed.ok;
}

// 把新用户/机器人拉进已有群（已存在的会被过滤，不重复拉）
async function addToExistingChat(chatId, users, bots) {
  const result = { users_added: 0, bots_added: 0, skipped: [], errors: [] };

  // 查询群内现有成员与机器人
  const cur = await runLarkCli(['im', '+chat-members-list', '--chat-id', chatId, '--as', 'user', '--json']);
  let existingUsers = new Set();
  let existingBots = new Set();
  if (cur.parsed && cur.parsed.ok) {
    const d = cur.parsed.data || {};
    existingUsers = new Set((d.users || []).map((u) => u.member_id));
    existingBots = new Set((d.bots || []).map((b) => b.app_id));
  }

  const newUsers = users ? users.split(',').filter((u) => !existingUsers.has(u)) : [];
  const newBots = bots.filter((b) => !existingBots.has(b));
  result.skipped = [...(users ? users.split(',').filter((u) => existingUsers.has(u)) : []), ...bots.filter((b) => existingBots.has(b))];

  if (newUsers.length) {
    const r = await runLarkCli([
      'im', 'chat.members', 'create',
      '--chat-id', chatId,
      '--member-id-type', 'open_id',
      '--succeed-type', '1',
      '--data', JSON.stringify({ id_list: newUsers }),
      '--as', 'user', '--json',
    ]);
    if (r.parsed && r.parsed.ok) result.users_added = newUsers.length;
    else result.errors.push((r.parsed && r.parsed.error && r.parsed.error.message) || 'add users failed');
  }
  if (newBots.length) {
    const r = await runLarkCli([
      'im', 'chat.members', 'create',
      '--chat-id', chatId,
      '--member-id-type', 'app_id',
      '--succeed-type', '1',
      '--data', JSON.stringify({ id_list: newBots }),
      '--as', 'user', '--json',
    ]);
    if (r.parsed && r.parsed.ok) result.bots_added = newBots.length;
    else result.errors.push((r.parsed && r.parsed.error && r.parsed.error.message) || 'add bots failed');
  }
  return result;
}

async function handleCreateGroup(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { status: 400, payload: { ok: false, error: 'field "name" is required' } };
  if (name.length > 60) return { status: 400, payload: { ok: false, error: '"name" exceeds 60 chars' } };

  // 机器人列表：body.bots 显式传入时完全以传入为准（可为空数组=不拉任何机器人）；
  // 未传时默认拉 CodeM 机器人。单群上限 5 个。
  let bots;
  if (Array.isArray(body.bots)) {
    bots = [...new Set(body.bots.map((b) => String(b).trim()).filter((b) => /^cli_[0-9a-z]+$/i.test(b)))].slice(0, 5);
  } else {
    bots = [CODEM_BOT_APP_ID];
  }
  const botsStr = bots.join(',');

  const includeMe = body.include_me !== false;
  const members = Array.isArray(body.members) ? body.members : [];

  // 关联的 Meego 草稿（决定：已有群→更新模式；建群后发首条消息、存映射）
  const pending = body.pending_id ? pendingGroups.get(String(body.pending_id)) : null;
  if (body.pending_id && !pending) return { status: 404, payload: { ok: false, error: 'pending not found' } };

  const resolved = [];
  const unresolved = [];
  for (const m of members) {
    const r = await resolveMember(m);
    if (r.openId) resolved.push(r);
    else unresolved.push({ member: String(m), reason: r.error });
  }

  // 去重（含部署者本人）
  const userSet = new Set();
  if (includeMe) userSet.add(OWNER_OPEN_ID);
  for (const r of resolved) if (r.openId) userSet.add(r.openId);
  const users = [...userSet].join(',');

  // ---------- 更新模式：群已存在，拉新机器人/成员 + 发变更消息，不新建 ----------
  if (pending && pending.mode === 'update' && pending.existing_chat) {
    const ec = pending.existing_chat;
    const upd = await addToExistingChat(ec.chat_id, users, bots);
    let message_sent = false;
    if (pending.changed_text) message_sent = await sendChatMessage(ec.chat_id, pending.changed_text);
    return {
      status: 200,
      payload: {
        ok: true,
        mode: 'update',
        chat_id: ec.chat_id,
        chat_name: ec.chat_name,
        link: `https://applink.feishu.cn/client/chat/open?openChatId=${ec.chat_id}`,
        users_added: upd.users_added,
        bots_added: upd.bots_added,
        already_in_chat: upd.skipped,
        changed_fields_message_sent: message_sent,
        errors: upd.errors.length ? upd.errors : undefined,
        unresolved_members: unresolved,
      },
    };
  }

  // ---------- 创建模式 ----------
  const args = [
    'im', '+chat-create',
    '--name', name,
    '--type', 'private',
    '--users', users,
    '--bots', botsStr,
    '--as', 'user',
    '--json',
  ];
  if (typeof body.description === 'string' && body.description.trim()) {
    args.push('--description', body.description.trim().slice(0, 100));
  }

  const r = await runLarkCli(args);
  if (!r.parsed || !r.parsed.ok) {
    return {
      status: 502,
      payload: { ok: false, error: (r.parsed && r.parsed.error && r.parsed.error.message) || r.stderr || 'chat create failed' },
    };
  }
  const chat = (r.parsed.data && (r.parsed.data.chat || r.parsed.data)) || {};

    // 工作项 → 群映射落盘（后续同工作项事件走更新模式）
    if (pending && pending.work_item && chat.chat_id) {
      const map = loadGroupMap();
      map[String(pending.work_item.id)] = { chat_id: chat.chat_id, chat_name: chat.name || name, created_at: Date.now() };
      saveGroupMap(map);
      }

      // Meego 变更字段作为群内第一条消息
      let first_message_sent = false;
    if (pending && pending.changed_text && chat.chat_id) {
  first_message_sent = await sendChatMessage(chat.chat_id, pending.changed_text);
}

  return {
    status: 200,
    payload: {
      ok: true,
      mode: 'create',
      chat_id: chat.chat_id,
      chat_name: chat.name || name,
      link: chat.chat_app_link || (chat.chat_id ? `https://applink.feishu.cn/client/chat/open?openChatId=${chat.chat_id}` : undefined),
      members_added: users ? users.split(',').length : 0,
      bots_invited: botsStr ? botsStr.split(',') : [],
      changed_fields_message_sent: first_message_sent,
      unresolved_members: unresolved,
    },
  };
}

const server = http.createServer((req, res) => {
  const json = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/healthz') return json(200, { ok: true });

  // Meego 工作项变更 webhook：生成待建群草稿并自动打开前端页面
  if (req.method === 'POST' && req.url === '/webhook/meego') {
    if (WEBHOOK_TOKEN && req.headers['x-webhook-token'] !== WEBHOOK_TOKEN) {
      return json(401, { ok: false, error: 'invalid or missing X-Webhook-Token' });
    }
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(buf || '{}'); } catch { return json(400, { ok: false, error: 'invalid JSON body' }); }
      const { status, payload } = handleMeegoEvent(body);
      if (status === 200 && payload.ok) {
        const url = `${baseUrl(req)}/?pending=${payload.pending_id}`;
        payload.review_url = url;
        payload.browser_opened = openBrowser(url);
        console.log(`[meego] pending=${payload.pending_id} group="${payload.group_name}" review=${url}`);
      }
      json(status, payload);
    });
    return;
  }

  // 查询草稿（前端页面打开时拉取预填信息）
  if (req.method === 'GET' && /^\/api\/pending(\/|$)/.test(req.url)) {
    const pid = req.url.split('/').pop();
    const g = pendingGroups.get(pid);
    if (!g) return json(404, { ok: false, error: 'pending not found' });
    return json(200, { ok: true, pending: g });
  }

  // 前端测试页（兼容带 query 的 URL，如 /?pending=1）
  const pathname = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const htmlPath = require('node:path').join(__dirname, 'public', 'index.html');
    require('node:fs').readFile(htmlPath, (e, data) => {
      if (e) return json(500, { ok: false, error: 'index.html missing: ' + e.message });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook/group') {
    if (WEBHOOK_TOKEN && req.headers['x-webhook-token'] !== WEBHOOK_TOKEN) {
      return json(401, { ok: false, error: 'invalid or missing X-Webhook-Token' });
    }
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 64 * 1024) req.destroy(); });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(buf || '{}'); } catch { return json(400, { ok: false, error: 'invalid JSON body' }); }
      try {
        const { status, payload } = await handleCreateGroup(body);
        json(status, payload);
      } catch (e) {
        json(500, { ok: false, error: String((e && e.message) || e) });
      }
    });
    return;
  }

  json(404, { ok: false, error: 'not found', endpoints: ['GET /', 'GET /healthz', 'POST /webhook/group', 'POST /webhook/meego', 'GET /api/pending/:id'] });
});

server.listen(PORT, HOST, () => {
  console.log(`[codem-group-webhook] listening on http://${HOST}:${PORT}`);
  console.log(`  POST /webhook/group  {"name":"...","members":["姓名|邮箱|open_id",...],"include_me":true}`);
  if (WEBHOOK_TOKEN) console.log('  auth: header X-Webhook-Token required');
});
