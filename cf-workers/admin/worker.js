// INPI Admin – Whitelist OFF, alle Keys erlaubt, robustes JSON, CSP Header
export default {
  async fetch(req, env) {
    // Basic + optional OTP
    if (!basicOk(req, env) || !ipOk(req, env))
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Basic realm="${env.ADMIN_REALM || "Admin"}"`,
          ...secHeaders()
        }
      });

    const url = new URL(req.url);
    const p = url.pathname;

    // Mini-UI
    if (req.method === "GET" && (p === "/admin" || p === "/admin/")) return ui();

    // ---- CONFIG API (Whitelist AUS) ----
    if (req.method === "GET" && p === "/admin/config/keys") {
      const keys = await listAll(env.CONFIG);
      return J({ ok: true, allow_all: true, keys });
    }

    if (req.method === "GET" && p === "/admin/config") {
      const qKey = url.searchParams.get("key");
      if (qKey) {
        const v = await env.CONFIG.get(qKey);
        return J({ ok: true, allow_all: true, key: qKey, value: v ?? null });
      }
      const keys = await listAll(env.CONFIG);
      const values = {};
      await Promise.all(keys.map(async k => (values[k] = await env.CONFIG.get(k))));
      return J({ ok: true, allow_all: true, keys, values });
    }

    if (req.method === "POST" && p === "/admin/config/set") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") return badCT();
      const { key, value } = body;
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      await env.CONFIG.put(String(key), String(value ?? ""));
      return J({ ok: true });
    }

    if (req.method === "POST" && p === "/admin/config/setmany") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") return badCT();
      const { entries } = body;
      if (!entries || typeof entries !== "object")
        return J({ ok: false, error: "entries_object_required" }, 400);
      await Promise.all(Object.entries(entries).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? ""))));
      return J({ ok: true });
    }

    if (req.method === "POST" && p === "/admin/config/delete") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") return badCT();
      const { key } = body;
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      await env.CONFIG.delete(String(key));
      return J({ ok: true });
    }

    if (req.method === "GET" && p === "/admin/config/export") {
      const keys = await listAll(env.CONFIG);
      const values = {};
      await Promise.all(keys.map(async k => (values[k] = await env.CONFIG.get(k))));
      return new Response(JSON.stringify({ ts: Date.now(), allow_all: true, values }, null, 2), {
        headers: {
          "content-type": "application/json",
          "content-disposition": "attachment; filename=inpi-config-export.json",
          ...secHeaders()
        }
      });
    }

    if (req.method === "POST" && p === "/admin/config/import") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") return badCT();
      const { values } = body;
      if (!values || typeof values !== "object")
        return J({ ok: false, error: "values_object_required" }, 400);
      await Promise.all(Object.entries(values).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? ""))));
      return J({ ok: true, allow_all: true, written: Object.keys(values).length });
    }

    if (req.method === "GET" && p === "/admin/health") {
      return J({ ok: true, now: Date.now(), allow_all: true });
    }

    return new Response("Not found", { status: 404, headers: secHeaders() });
  }
};

/* ---------- helpers ---------- */
function basicOk(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, p] = atob(h.slice(6)).split(":");
  return u === env.ADMIN_USER && p === env.ADMIN_PASS;
}
function ipOk(req, env) {
  const allow = (env.IP_ALLOWLIST || "").split(",").map(s => s.trim()).filter(Boolean);
  if (allow.length === 0) return true;
  const ip = req.headers.get("cf-connecting-ip") || "";
  return allow.includes(ip);
}
async function listAll(KV, { prefix = "", cap = 5000 } = {}) {
  const out = [];
  let cursor;
  while (out.length < cap) {
    const r = await KV.list({ prefix, cursor });
    (r.keys || []).forEach(k => out.push(k.name));
    if (!r.list_complete && r.cursor) cursor = r.cursor;
    else break;
  }
  return out;
}
async function readJson(req) {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) return null;
  try { return await req.json(); } catch { return null; }
}
function badCT() { return new Response("Bad Content-Type", { status: 415, headers: secHeaders() }); }
function J(x, status = 200) {
  return new Response(JSON.stringify(x), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...secHeaders() }
  });
}
function secHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    // CSP: erlaubt Insights & QR-Bilder; keine Frames, kein Eval nötig
    "content-security-policy":
      "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; connect-src 'self' https://api.mainnet-beta.solana.com https://rpc.helius.xyz; img-src 'self' data: https://api.qrserver.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
  };
}
function ui() {
  const html = `<!doctype html>