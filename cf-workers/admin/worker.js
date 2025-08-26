// INPI Admin Worker (Basic + optional TOTP, Cron-Proxies, Config-API)
// Bindings/Secrets:
// - KV: CONFIG (required), OPS (optional für Audit)
// - Secrets: ADMIN_USER, ADMIN_PASS
// - Optional Secrets: ADMIN_TOTP_SECRET, ADMIN_TOTP_PERIOD, ADMIN_TOTP_WINDOW
// - ENV/Secret: CRON_BASE (z.B. https://inpinity.online/cron), OPS_API_KEY
// - Optional: IP_ALLOWLIST (CSV), CONFIG_KEYS (CSV Whitelist)

export default {
  async fetch(req, env) {
    // Basic + IP-Check
    if (!basicOk(req, env) || !ipOk(req, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Basic realm="${env.ADMIN_REALM || "Admin"}"`,
          ...secHeaders(),
          "x-require-otp": "1"
        }
      });
    }

    const url = new URL(req.url);
    const p = url.pathname;

    // OTP für sensible Routen (Config & Cron-Proxies)
    const mustOtp = needsOtp(p);
    if (mustOtp && env.ADMIN_TOTP_SECRET) {
      const otp = getOtpFromReq(req);
      const ok = await verifyTOTP(env.ADMIN_TOTP_SECRET, otp, {
        period: toNum(env.ADMIN_TOTP_PERIOD, 30),
        window: toNum(env.ADMIN_TOTP_WINDOW, 1),
        digits: 6,
        algo: "SHA-1"
      });
      if (!ok) return J({ ok: false, error: "bad_otp" }, 401, { "x-require-otp": "1" });
    }

    // UI
    if (req.method === "GET" && p === "/admin") return ui(env);

    // -------- CONFIG API --------
    if (req.method === "GET" && p === "/admin/config") {
      const qKey = url.searchParams.get("key");
      if (qKey) {
        const v = await env.CONFIG.get(qKey);
        return J({ ok: true, key: qKey, value: v });
      }
      const keys = getConfigKeys(env);
      const out = {};
      await Promise.all(keys.map(async (k) => (out[k] = await env.CONFIG.get(k))));
      return J({ ok: true, keys, values: out });
    }

    if (req.method === "GET" && p === "/admin/config/keys") {
      return J({ ok: true, keys: getConfigKeys(env) });
    }

    if (req.method === "POST" && p === "/admin/config/set") {
      if (!(await requireJson(req))) return badCT();
      const { key, value } = await req.json().catch(() => ({}));
      if (!keyAllowed(env, key)) return J({ ok: false, error: "key_not_allowed" }, 403);
      await env.CONFIG.put(String(key), String(value ?? ""));
      await audit(env, "config_set", { key });
      return J({ ok: true });
    }

    if (req.method === "POST" && p === "/admin/config/setmany") {
      if (!(await requireJson(req))) return badCT();
      const { entries } = await req.json().catch(() => ({}));
      if (!entries || typeof entries !== "object") return J({ ok: false, error: "entries_object_required" }, 400);
      for (const [k] of Object.entries(entries)) {
        if (!keyAllowed(env, k)) return J({ ok: false, error: `key_not_allowed:${k}` }, 403);
      }
      await Promise.all(Object.entries(entries).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? ""))));
      await audit(env, "config_setmany", { count: Object.keys(entries).length });
      return J({ ok: true });
    }

    if (req.method === "POST" && p === "/admin/config/delete") {
      if (!(await requireJson(req))) return badCT();
      const { key } = await req.json().catch(() => ({}));
      if (!keyAllowed(env, key)) return J({ ok: false, error: "key_not_allowed" }, 403);
      await env.CONFIG.delete(key);
      await audit(env, "config_delete", { key });
      return J({ ok: true });
    }

    if (req.method === "GET" && p === "/admin/config/export") {
      const keys = getConfigKeys(env);
      const out = {};
      await Promise.all(keys.map(async (k) => (out[k] = await env.CONFIG.get(k))));
      return new Response(JSON.stringify({ ts: Date.now(), values: out }, null, 2), {
        headers: {
          "content-type": "application/json",
          "content-disposition": "attachment; filename=inpi-config-export.json",
          ...secHeaders()
        }
      });
    }

    if (req.method === "POST" && p === "/admin/config/import") {
      if (!(await requireJson(req))) return badCT();
      const { values } = await req.json().catch(() => ({}));
      if (!values || typeof values !== "object") return J({ ok: false, error: "values_object_required" }, 400);
      const allowed = getConfigKeys(env);
      const write = {};
      for (const [k, v] of Object.entries(values)) if (allowed.includes(k)) write[k] = v;
      await Promise.all(Object.entries(write).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? ""))));
      await audit(env, "config_import", { count: Object.keys(write).length });
      return J({ ok: true, written: Object.keys(write).length });
    }

    // -------- CRON PROXIES (mit Bearer + HMAC) --------
    if (req.method === "GET" && p === "/admin/cron/status") {
      const r = await proxyCron(env, "/status", "GET", null);
      return pass(r);
    }

    if (req.method === "POST" && p === "/admin/cron/reconcile") {
      if (!(await requireJson(req))) return badCT();
      const body = await req.json().catch(() => ({}));
      const r = await proxyCron(env, "/reconcile-presale", "POST", body);
      return pass(r);
    }

    // NEU: Early-Claims in OPS anstoßen
    if (req.method === "POST" && p === "/admin/cron/early-claims") {
      if (!(await requireJson(req))) return badCT();
      const body = await req.json().catch(() => ({}));
      const r = await proxyCron(env, "/early-claims", "POST", body);
      return pass(r);
    }

    if (req.method === "GET" && p === "/admin/ops/peek") {
      const q = url.searchParams.toString();
      const r = await proxyCron(env, `/ops/peek${q ? "?" + q : ""}`, "GET", null);
      return pass(r);
    }

    // Health
    if (req.method === "GET" && p === "/admin/health") return J({ ok: true, now: Date.now() });

    return new Response("Not found", { status: 404, headers: secHeaders() });
  }
};

/* --------------------- Auth / Allowlist --------------------- */
function basicOk(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, p] = atob(h.slice(6)).split(":");
  return u === env.ADMIN_USER && p === env.ADMIN_PASS;
}
function ipOk(req, env) {
  const allow = (env.IP_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length === 0) return true;
  const ip = req.headers.get("cf-connecting-ip") || "";
  return allow.includes(ip);
}
function needsOtp(path) {
  if (path === "/admin" || path === "/admin/health") return false;
  return path.startsWith("/admin/config") || path.startsWith("/admin/cron") || path.startsWith("/admin/ops");
}

/* --------------------- Config Keys --------------------- */
function getConfigKeys(env) {
  const csv = (env.CONFIG_KEYS || "").trim();
  if (csv) return csv.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}
function keyAllowed(env, k) {
  return getConfigKeys(env).includes(String(k));
}

/* --------------------- Audit (optional) --------------------- */
async function audit(env, action, detail) {
  if (!env.OPS) return;
  const key = `audit:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    await env.OPS.put(key, JSON.stringify({ action, detail, ts: Date.now() }), { expirationTtl: 86400 * 30 });
  } catch {}
}

/* --------------------- Proxy zu Cron --------------------- */
async function proxyCron(env, subpath, method = "GET", bodyObj) {
  const base = (env.CRON_BASE || "").replace(/\/+$/, "");
  const url = `${base}${subpath}`;
  const headers = { authorization: `Bearer ${env.OPS_API_KEY}` };
  let body = null;

  if (method !== "GET" && bodyObj != null) {
    body = JSON.stringify(bodyObj);
    headers["content-type"] = "application/json";
    const algo = env.OPS_HMAC_ALGO || "SHA-256";
    headers["x-ops-hmac"] = await hmacHex(env.OPS_API_KEY, body, algo);
  }
  return fetch(url, { method, headers, body });
}
function pass(r) {
  const h = new Headers({ ...secHeaders() });
  const ct = r.headers.get("content-type");
  if (ct) h.set("content-type", ct);
  return new Response(r.body, { status: r.status, headers: h });
}

/* --------------------- Helpers --------------------- */
async function requireJson(req) {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  return ct.includes("application/json");
}
function badCT() {
  return new Response("Bad Content-Type", { status: 415, headers: secHeaders() });
}
const J = (x, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json", ...secHeaders(), ...extraHeaders } });
function secHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    "cache-control": "no-store"
  };
}
const toNum = (x, def) => (x == null || x === "") ? def : Number(x);

/* --------------------- TOTP (RFC 6238) --------------------- */
function getOtpFromReq(req) {
  return req.headers.get("x-otp") || req.headers.get("x-otp-code") || new URL(req.url).searchParams.get("otp") || "";
}
async function verifyTOTP(secretBase32, code, { period = 30, window = 1, digits = 6, algo = "SHA-1" } = {}) {
  if (!secretBase32) return false;
  const clean = String(code || "").trim();
  if (!/^\d{6,8}$/.test(clean)) return false;
  const K = base32Decode(secretBase32);
  const t = Math.floor(Date.now() / 1000 / period);
  for (let w = -window; w <= window; w++) {
    const otp = await hotp(K, t + w, { digits, algo });
    if (otp === clean) return true;
  }
  return false;
}
async function hotp(keyBytes, counter, { digits = 6, algo = "SHA-1" } = {}) {
  const counterBuf = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    counterBuf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: { name: algo } }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBuf));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  const mod = 10 ** digits;
  const num = (bin % mod).toString();
  return num.padStart(digits, "0");
}
function base32Decode(s) {
  const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const map = Object.fromEntries(ALPH.split("").map((c, i) => [c, i]));
  const str = s.toUpperCase().replace(/=+$/, "").replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of str) {
    const v = map[ch];
    if (v == null) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(out);
}

/* --------------------- HMAC --------------------- */
async function hmacHex(secret, msg, algo = "SHA-256") {
  const mac = await hmac(secret, msg, algo);
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(secret, msg, algo = "SHA-256") {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: { name: algo } }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(msg));
}

/* --------------------- UI (Dashboard + Konfigurator 2.0) --------------------- */
function ui(env) {
  // WICHTIG: Im <script> KEINE Backticks/Interpolation benutzen (nur String-Concats).
  const html = `<!doctype html>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>INPI Admin</title>
<style>
:root{ color-scheme: light dark; font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell; }
body{ margin:0; background:#0b0d10; color