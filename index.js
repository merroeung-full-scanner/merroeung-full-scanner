import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import bigInt from "big-integer";

const enc = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

function safeEq(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requirePassword(request, env) {
  const supplied = request.headers.get("X-Scanner-Password") || "";
  return env.SCANNER_PASSWORD && safeEq(supplied, env.SCANNER_PASSWORD);
}

function normalizeGroupRef(value) {
  let s = String(value || "").trim();
  if (!s) throw new Error("Group @username is required.");

  s = s.replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").replace(/\/+$/, "");

  if (/^-?\d+$/.test(s)) {
    throw new Error(
      "This group is Private. A numeric Group ID alone is not enough for this MTProto scanner. Temporarily set the group to Public, give it a username, then scan using @username."
    );
  }

  if (!/^[A-Za-z0-9_]{5,}$/.test(s)) {
    throw new Error("Invalid public group username. Example: @MerRoeungScanTemp");
  }

  return s;
}

async function resolveInputChannel(client, groupRef) {
  const username = normalizeGroupRef(groupRef);
  const resolved = await client.invoke(
    new Api.contacts.ResolveUsername({ username })
  );

  const chats = Array.isArray(resolved?.chats) ? resolved.chats : [];
  const channel = chats.find(c => c?.id && c?.accessHash !== undefined && c?.accessHash !== null);

  if (!channel) {
    throw new Error(
      "Could not resolve this @username to a supergroup. Make sure the group is temporarily Public, the username is correct, and the bot is still an admin."
    );
  }

  return {
    inputChannel: new Api.InputChannel({
      channelId: bigInt(String(channel.id)),
      accessHash: bigInt(String(channel.accessHash))
    }),
    resolvedGroupId: "-100" + String(channel.id),
    resolvedUsername: username
  };
}

function unixToIso(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function displayName(user) {
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  return name || user?.username || String(user?.id || "");
}

function participantUserId(p) {
  if (!p) return "";
  const raw = p.userId ?? p.peer?.userId ?? p.user?.id ?? "";
  return String(raw);
}

function participantRole(p) {
  const name = String(p?.className || p?.constructor?.name || "");
  if (name.includes("Creator")) return "creator";
  if (name.includes("Admin")) return "admin";
  if (name.includes("Banned")) return "restricted";
  if (name.includes("Left")) return "left";
  return "member";
}

async function ensureTables(env) {
  if (!env.db) {
    throw new Error(
      'D1 binding "db" is missing. In Cloudflare: merroeung-full-scanner → Bindings → Add binding → D1 database → variable name db.'
    );
  }

  await env.db.prepare(`
    CREATE TABLE IF NOT EXISTS telegram_members (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      display_name TEXT,
      plan_name TEXT,
      amount REAL NOT NULL DEFAULT 0,
      expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      note TEXT,
      joined_at TEXT,
      join_source TEXT NOT NULL DEFAULT 'unknown',
      last_seen_at TEXT,
      blocked_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const alters = [
    `ALTER TABLE telegram_members ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE telegram_members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE telegram_members ADD COLUMN telegram_role TEXT`,
    `ALTER TABLE telegram_members ADD COLUMN scan_at TEXT`
  ];

  for (const sql of alters) {
    try { await env.db.prepare(sql).run(); } catch (_) {}
  }

  await env.db.prepare(`
    CREATE TABLE IF NOT EXISTS telegram_scanner_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      telegram_total INTEGER NOT NULL DEFAULT 0,
      scanned_count INTEGER NOT NULL DEFAULT 0,
      records_before INTEGER NOT NULL DEFAULT 0,
      records_after INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT
    )
  `).run();
}

async function upsertChunk(env, rows) {
  const statements = rows.map(row => env.db.prepare(`
    INSERT INTO telegram_members(
      user_id, username, first_name, last_name, display_name,
      status, joined_at, join_source, last_seen_at, updated_at,
      is_bot, is_admin, telegram_role, scan_at
    )
    VALUES (?, ?, ?, ?, ?, 'unpaid', ?, 'mtproto_scan', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      display_name = excluded.display_name,
      joined_at = COALESCE(telegram_members.joined_at, excluded.joined_at),
      join_source = CASE
        WHEN telegram_members.join_source IN ('event','payment','manual') THEN telegram_members.join_source
        ELSE 'mtproto_scan'
      END,
      last_seen_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP,
      is_bot = excluded.is_bot,
      is_admin = excluded.is_admin,
      telegram_role = excluded.telegram_role,
      scan_at = CURRENT_TIMESTAMP
  `).bind(
    row.userId,
    row.username || null,
    row.firstName || null,
    row.lastName || null,
    row.displayName || row.userId,
    row.joinedAt || null,
    row.isBot ? 1 : 0,
    row.isAdmin ? 1 : 0,
    row.role
  ));

  if (statements.length) await env.db.batch(statements);
}

async function scanAll(env, groupId) {
  await ensureTables(env);

  const apiId = Number(env.TG_API_ID);
  const apiHash = String(env.TG_API_HASH || "");
  const botToken = String(env.TELEGRAM_BOT_TOKEN || "");

  if (!Number.isInteger(apiId) || apiId <= 0) throw new Error("TG_API_ID is missing or invalid.");
  if (!apiHash) throw new Error("TG_API_HASH is missing.");
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is missing.");


  const beforeRow = await env.db.prepare(`SELECT COUNT(*) AS total FROM telegram_members`).first();
  const beforeCount = Number(beforeRow?.total || 0);
  const startedAt = new Date().toISOString();

  const run = await env.db.prepare(`
    INSERT INTO telegram_scanner_runs(group_id, records_before, started_at, status)
    VALUES (?, ?, ?, 'running')
  `).bind(String(groupId), beforeCount, startedAt).run();

  const runId = run.meta?.last_row_id ?? null;

  const client = new TelegramClient(
    new StringSession(""),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  let scanned = 0;
  let telegramTotal = 0;
  let offset = 0;
  const limit = 200;
  const seen = new Set();

  try {
    await client.start({
      botAuthToken: botToken,
      onError: (err) => console.error("Telegram auth:", err)
    });

    const resolved = await resolveInputChannel(client, groupId);
    const inputChannel = resolved.inputChannel;

    while (true) {
      const result = await client.invoke(
        new Api.channels.GetParticipants({
          channel: inputChannel,
          filter: new Api.ChannelParticipantsRecent({}),
          offset,
          limit,
          hash: bigInt.zero
        })
      );

      telegramTotal = Number(result?.count || telegramTotal || 0);

      const participants = Array.isArray(result?.participants) ? result.participants : [];
      const users = Array.isArray(result?.users) ? result.users : [];

      const pmap = new Map();
      for (const p of participants) {
        const id = participantUserId(p);
        if (id) pmap.set(id, p);
      }

      const rows = [];
      for (const user of users) {
        const userId = String(user?.id || "");
        if (!userId || seen.has(userId)) continue;
        seen.add(userId);

        const p = pmap.get(userId);
        const role = participantRole(p);
        const joinedAt = unixToIso(p?.date);

        rows.push({
          userId,
          username: user?.username || null,
          firstName: user?.firstName || null,
          lastName: user?.lastName || null,
          displayName: displayName(user),
          joinedAt,
          isBot: Boolean(user?.bot),
          isAdmin: role === "admin" || role === "creator",
          role
        });
      }

      for (let i = 0; i < rows.length; i += 50) {
        await upsertChunk(env, rows.slice(i, i + 50));
      }

      scanned += rows.length;

      if (!participants.length) break;
      offset += participants.length;

      if (telegramTotal && offset >= telegramTotal) break;
      if (offset >= 10000) break;
    }

    const afterRow = await env.db.prepare(`SELECT COUNT(*) AS total FROM telegram_members`).first();
    const afterCount = Number(afterRow?.total || 0);

    if (runId !== null) {
      await env.db.prepare(`
        UPDATE telegram_scanner_runs
        SET telegram_total=?, scanned_count=?, records_after=?,
            finished_at=CURRENT_TIMESTAMP, status='success'
        WHERE id=?
      `).bind(telegramTotal, scanned, afterCount, runId).run();
    }

    return {
      ok: true,
      groupId: resolved.resolvedGroupId || String(groupId),
      resolvedUsername: resolved.resolvedUsername || null,
      telegramTotal,
      scanned,
      recordsBefore: beforeCount,
      recordsAfter: afterCount,
      newRecords: Math.max(0, afterCount - beforeCount)
    };
  } catch (error) {
    if (runId !== null) {
      try {
        await env.db.prepare(`
          UPDATE telegram_scanner_runs
          SET finished_at=CURRENT_TIMESTAMP, status='error', error=?
          WHERE id=?
        `).bind(String(error), runId).run();
      } catch (_) {}
    }
    throw error;
  } finally {
    try { await client.disconnect(); } catch (_) {}
  }
}

async function getStatus(env) {
  await ensureTables(env);
  const members = await env.db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN is_bot=1 THEN 1 ELSE 0 END) AS bots,
      SUM(CASE WHEN is_admin=1 THEN 1 ELSE 0 END) AS admins,
      SUM(CASE WHEN status='unpaid' THEN 1 ELSE 0 END) AS unpaid,
      SUM(CASE WHEN expires_at IS NOT NULL AND datetime(expires_at) > datetime('now') THEN 1 ELSE 0 END) AS paid_active
    FROM telegram_members
  `).first();

  const last = await env.db.prepare(`
    SELECT * FROM telegram_scanner_runs
    ORDER BY id DESC LIMIT 1
  `).first();

  return {
    totalTracked: Number(members?.total || 0),
    bots: Number(members?.bots || 0),
    admins: Number(members?.admins || 0),
    unpaid: Number(members?.unpaid || 0),
    paidActive: Number(members?.paid_active || 0),
    lastScan: last || null
  };
}

function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MerRoeung Full Member Scanner v3.1</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#090d16;color:#eef2ff;font-family:Arial,sans-serif}
.wrap{max-width:920px;margin:45px auto;padding:20px}.card{background:#111827;border:1px solid #263247;border-radius:20px;padding:26px;margin-bottom:18px}
h1{margin:0 0 8px}.muted{color:#94a3b8;line-height:1.6}label{display:block;margin:18px 0 7px;color:#b7c3d8}
input{width:100%;padding:14px;border-radius:10px;border:1px solid #334155;background:#0b1220;color:#fff;font-size:16px}
button{padding:13px 18px;border:0;border-radius:10px;background:#8b5cf6;color:#fff;font-weight:700;font-size:16px;cursor:pointer;margin-top:16px}
button:disabled{opacity:.55;cursor:not-allowed}.secondary{background:#1e293b;margin-left:8px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.stat{background:#0b1220;border:1px solid #25334a;border-radius:14px;padding:16px}
.num{font-size:28px;font-weight:800;margin-top:8px}.good{color:#86efac}.warn{color:#fde68a}.err{color:#fca5a5}
#result{white-space:pre-wrap;background:#070b12;border:1px solid #273449;border-radius:12px;padding:16px;min-height:80px}
@media(max-width:700px){.grid{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>MerRoeung Full Member Scanner v3.1</h1>
    <div class="muted">
      Scan-only mode. This page does NOT remove, ban, or change VIP expiry.
      It reads Telegram supergroup participants and saves ID / name / username into the existing D1 member table.
    </div>
  </div>

  <div class="card">
    <div class="grid">
      <div class="stat"><div class="muted">Tracked</div><div class="num" id="tracked">-</div></div>
      <div class="stat"><div class="muted">Paid active</div><div class="num good" id="paid">-</div></div>
      <div class="stat"><div class="muted">Unpaid</div><div class="num warn" id="unpaid">-</div></div>
      <div class="stat"><div class="muted">Admins/Bots</div><div class="num" id="admins">-</div></div>
    </div>
  </div>

  <div class="card">
    <label>Scanner password</label>
    <input id="password" type="password" placeholder="SCANNER_PASSWORD">

    <label>Telegram Group @username</label>
    <input id="groupId" value="" placeholder="@MerRoeungScanTemp">

    <button id="scanBtn">Scan All & Save to D1</button>
    <button class="secondary" id="statusBtn">Refresh Status</button>

    <p class="muted">
      For a private group, temporarily switch it to Public and give it a temporary username, then enter that @username here.
      After the scan succeeds, you can switch the group back to Private. Existing paid/blocked/expiry records are preserved.
      New discovered members are saved as unpaid until you mark or verify payment in MerRoeung Admin.
    </p>
    <div id="result">Ready.</div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
function authHeaders(){ return {"X-Scanner-Password": $("password").value}; }

async function refreshStatus(){
  $("result").textContent = "Loading status...";
  try{
    const r = await fetch("/api/status",{headers:authHeaders()});
    const x = await r.json();
    if(!r.ok) throw new Error(x.error || "Status failed");
    $("tracked").textContent = x.totalTracked;
    $("paid").textContent = x.paidActive;
    $("unpaid").textContent = x.unpaid;
    $("admins").textContent = (x.admins || 0) + "/" + (x.bots || 0);
    $("result").textContent = x.lastScan
      ? "Last scan:\\n" + JSON.stringify(x.lastScan,null,2)
      : "No scan has run yet.";
  }catch(e){ $("result").textContent = "ERROR: " + e.message; }
}

$("statusBtn").addEventListener("click", refreshStatus);

$("scanBtn").addEventListener("click", async () => {
  const btn = $("scanBtn");
  btn.disabled = true;
  $("result").textContent = "Scanning Telegram members... Do not close this page.";
  try{
    const r = await fetch("/api/scan",{
      method:"POST",
      headers:{...authHeaders(),"Content-Type":"application/json"},
      body:JSON.stringify({groupId:$("groupId").value})
    });
    const x = await r.json();
    if(!r.ok) throw new Error(x.error || "Scan failed");
    $("result").textContent =
      "SCAN SUCCESS\\n\\n" +
      "Telegram total: " + x.telegramTotal + "\\n" +
      "Scanned/saved: " + x.scanned + "\\n" +
      "Tracked before: " + x.recordsBefore + "\\n" +
      "Tracked after: " + x.recordsAfter + "\\n" +
      "New records: " + x.newRecords;
    await refreshStatus();
  }catch(e){
    $("result").textContent = "SCAN ERROR:\\n" + e.message;
  }finally{
    btn.disabled = false;
  }
});
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/" && request.method === "GET") {
        return html(page());
      }

      if (url.pathname === "/api/status" && request.method === "GET") {
        if (!requirePassword(request, env)) return json({error:"Wrong scanner password"}, 401);
        return json(await getStatus(env));
      }

      if (url.pathname === "/api/scan" && request.method === "POST") {
        if (!requirePassword(request, env)) return json({error:"Wrong scanner password"}, 401);

        const body = await request.json().catch(() => ({}));
        const groupId = String(body.groupId || "").trim();

        if (!groupId) return json({error:"Group @username is required"}, 400);

        const result = await scanAll(env, groupId);
        return json(result);
      }

      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          service: "MerRoeung Full Scanner",
          d1Binding: Boolean(env.db),
          apiId: Boolean(env.TG_API_ID),
          apiHash: Boolean(env.TG_API_HASH),
          botToken: Boolean(env.TELEGRAM_BOT_TOKEN),
          password: Boolean(env.SCANNER_PASSWORD)
        });
      }

      return new Response("Not found", {status:404});
    } catch (error) {
      console.error(error);
      return json({ok:false,error:String(error)}, 500);
    }
  }
};
