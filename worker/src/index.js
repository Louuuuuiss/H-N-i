const ORIGIN = "https://louuuuuiss.github.io";
const SESSION_SECONDS = 60 * 60 * 12;
const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_LIMIT = 5;
const encoder = new TextEncoder();

function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin === ORIGIN ? ORIGIN : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  }});
}

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join("");
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signed)].map(v => v.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(v => v.toString(16).padStart(2, "0")).join("");
}

async function authorized(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer ([a-f0-9]{64})$/i);
  if (!match) return false;
  const row = await env.DB.prepare("SELECT expires FROM sessions WHERE token = ?").bind(await digest(match[1])).first();
  if (!row || Number(row.expires) < Date.now()) return false;
  return true;
}

function validContent(value) {
  if (!value || typeof value !== "object" || typeof value.title !== "string" || typeof value.dateRange !== "string" || typeof value.duration !== "string") return false;
  if (!Array.isArray(value.days) || !value.places || !["attractions", "entertainment", "food"].every(key => Array.isArray(value.places[key]))) return false;
  if (JSON.stringify(value).length > 500_000 || value.days.length > 60) return false;
  for (const day of value.days) {
    if (typeof day.date !== "string" || typeof day.destination !== "string" || !Array.isArray(day.items) || day.items.length > 200) return false;
    if (day.items.some(item => !item || ["time", "title", "description"].some(key => typeof item[key] !== "string"))) return false;
  }
  for (const key of ["attractions", "entertainment", "food"]) {
    if (value.places[key].length > 1000) return false;
    for (const item of value.places[key]) {
      if (!item || ["name", "category", "description", "url"].some(k => typeof item[k] !== "string")) return false;
      if (item.name.length > 250 || item.description.length > 2000 || item.category.length > 100 || item.url.length > 2000) return false;
      for (const coordinate of [item.latitude, item.longitude]) if (coordinate !== "" && !Number.isFinite(Number(coordinate))) return false;
    }
  }
  return true;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (origin && origin !== ORIGIN) return json({ error: "來源不允許。" }, 403, origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    }});

    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/login" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const ipHash = await hmac(ip, env.AUTH_SECRET);
        const now = Date.now();
        const attempt = await env.DB.prepare("SELECT attempts, window_started FROM login_attempts WHERE ip_hash = ?").bind(ipHash).first();
        if (attempt && now - Number(attempt.window_started) < LOGIN_WINDOW && Number(attempt.attempts) >= LOGIN_LIMIT) return json({ error: "登入嘗試過多，請 15 分鐘後再試。" }, 429, origin);
        const body = await request.json().catch(() => ({}));
        const submitted = await hmac(String(body.password || ""), env.AUTH_SECRET);
        const expected = await hmac(env.ADMIN_PASSWORD, env.AUTH_SECRET);
        if (!constantTimeEqual(submitted, expected)) {
          const attempts = attempt && now - Number(attempt.window_started) < LOGIN_WINDOW ? Number(attempt.attempts) + 1 : 1;
          await env.DB.prepare("INSERT INTO login_attempts(ip_hash, attempts, window_started) VALUES(?, ?, ?) ON CONFLICT(ip_hash) DO UPDATE SET attempts = excluded.attempts, window_started = excluded.window_started").bind(ipHash, attempts, now).run();
          return json({ error: "密碼不正確。" }, 401, origin);
        }
        await env.DB.prepare("DELETE FROM login_attempts WHERE ip_hash = ?").bind(ipHash).run();
        const token = randomToken();
        await env.DB.prepare("INSERT INTO sessions(token, user_id, expires) VALUES(?, NULL, ?)" ).bind(await digest(token), now + SESSION_SECONDS * 1000).run();
        return json({ token, expiresIn: SESSION_SECONDS }, 200, origin);
      }

      if (url.pathname === "/api/content" && request.method === "GET") {
        const row = await env.DB.prepare("SELECT content FROM trip_content WHERE section = ?").bind("editor-v1").first();
        return json({ content: row ? JSON.parse(row.content) : null }, 200, origin);
      }

      if (url.pathname === "/api/content" && request.method === "POST") {
        if (!await authorized(request, env)) return json({ error: "登入已逾期，請重新登入。" }, 401, origin);
        const body = await request.json().catch(() => null);
        if (!body || !validContent(body.content)) return json({ error: "資料格式不正確，請檢查後再儲存。" }, 400, origin);
        await env.DB.prepare("INSERT INTO trip_content(section, content, updated_at) VALUES(?, ?, datetime('now')) ON CONFLICT(section) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at").bind("editor-v1", JSON.stringify(body.content)).run();
        return json({ saved: true }, 200, origin);
      }

      if (url.pathname === "/api/favorites/share" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body || !/^[a-f0-9-]{36}$/i.test(String(body.clientId || ""))) return json({ error: "識別碼不正確。" }, 400, origin);
        const clientHash = await hmac(body.clientId, env.AUTH_SECRET);
        if (!Array.isArray(body.favorites) || body.favorites.length > 1000 || body.favorites.some(id => typeof id !== "string" || id.length > 1000)) return json({ error: "收藏資料格式不正確。" }, 400, origin);
        const favorites = [...new Set(body.favorites)];
        if (!favorites.length) return json({ error: "目前沒有最愛項目可分享，請先加入景點、娛樂或美食。" }, 400, origin);
        const token = randomToken();
        const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
        await env.DB.prepare("INSERT INTO favorite_shares(token_hash, client_hash, favorite_ids, expires) VALUES(?, ?, ?, ?)").bind(await digest(token), clientHash, JSON.stringify(favorites), expires).run();
        return json({ token, expiresIn: 30 * 24 * 60 * 60 }, 200, origin);
      }

      if (url.pathname === "/api/favorites/share" && request.method === "GET") {
        const token = url.searchParams.get("token") || "";
        if (!/^[a-f0-9]{64}$/i.test(token)) return json({ error: "分享連結不正確。" }, 400, origin);
        const row = await env.DB.prepare("SELECT favorite_ids, expires FROM favorite_shares WHERE token_hash = ?").bind(await digest(token)).first();
        if (!row || Number(row.expires) < Date.now()) {
          if (row) await env.DB.prepare("DELETE FROM favorite_shares WHERE token_hash = ?").bind(await digest(token)).run();
          return json({ error: "分享連結已逾期或不存在。" }, 410, origin);
        }
        return json({ favorites: JSON.parse(row.favorite_ids), expires: Number(row.expires) }, 200, origin);
      }

      if (url.pathname === "/api/favorites" && request.method === "GET") {
        const clientId = url.searchParams.get("clientId") || "";
        if (!/^[a-f0-9-]{36}$/i.test(clientId)) return json({ error: "識別碼不正確。" }, 400, origin);
        const clientHash = await hmac(clientId, env.AUTH_SECRET);
        const rows = await env.DB.prepare("SELECT place_id FROM place_favorites WHERE client_hash = ?").bind(clientHash).all();
        return json({ favorites: (rows.results || []).map(row => row.place_id) }, 200, origin);
      }

      if (url.pathname === "/api/favorites" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body || !/^[a-f0-9-]{36}$/i.test(String(body.clientId || "")) || typeof body.placeId !== "string" || body.placeId.length > 1000 || typeof body.favorite !== "boolean") return json({ error: "收藏資料格式不正確。" }, 400, origin);
        const clientHash = await hmac(body.clientId, env.AUTH_SECRET);
        if (body.favorite) {
          await env.DB.prepare("INSERT INTO place_favorites(client_hash, place_id) VALUES(?, ?) ON CONFLICT(client_hash, place_id) DO NOTHING").bind(clientHash, body.placeId).run();
        } else {
          await env.DB.prepare("DELETE FROM place_favorites WHERE client_hash = ? AND place_id = ?").bind(clientHash, body.placeId).run();
        }
        return json({ saved: true }, 200, origin);
      }

      if (url.pathname === "/api/logout" && request.method === "POST") {
        const authorization = request.headers.get("Authorization") || "";
        const match = authorization.match(/^Bearer ([a-f0-9]{64})$/i);
        if (match) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(await digest(match[1])).run();
        return json({ loggedOut: true }, 200, origin);
      }
      return json({ error: "找不到這個服務。" }, 404, origin);
    } catch (error) {
      console.error("Trip editor API error", error);
      return json({ error: "服務暫時無法處理請求，請稍後再試。" }, 500, origin);
    }
  }
};

