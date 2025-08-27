// INPI Admin Worker – Whitelist HARD OFF, Basic-Auth + optional OTP
// KV Bindings: CONFIG (required), OPS (optional)
// Secrets: ADMIN_USER, ADMIN_PASS
// Optional: ADMIN_TOTP_SECRET (+ PERIOD/WINDOW), IP_ALLOWLIST

export default {
  async fetch(req, env) {
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

    // OTP nur, wenn Secret gesetzt
    if (needsOtp(p) && env.ADMIN_TOTP_SECRET) {
      const otp = getOtpFromReq(req);
      const ok = await verifyTOTP(env.ADMIN_TOTP_SECRET, otp, {
        period: toNum(env.ADMIN_TOTP_PERIOD, 30),
        window: toNum(env.ADMIN_TOTP_WINDOW, 1),
        digits: 6,
        algo: "SHA-1"
      });
      if (!ok) return J({ ok: false, error: "bad_otp" }, 401, { "x-require-otp": "1" });
    }

    // Mini-UI
    if (req.method === "GET" && (p === "/admin" || p === "/admin/")) return ui();

    // ---- CONFIG API (immer ALLES erlaubt) ----

    if (req.method === "GET" && p === "/admin/config/keys") {
      const all = await listAllConfigKeys(env, { cap: 5000 });
      return J({ ok: true, allow_all: true, keys: all });
    }

    if (req.method === "GET" && p === "/admin/config") {
      const qKey = url.searchParams.get("key");
      if (qKey) {
        const v = await env.CONFIG.get(qKey);
        return J({ ok: true, allow_all: true, key: qKey, value: v });
      }
      const keys = await listAllConfigKeys(env, { cap: 5000 });
      const out = {};
      await Promise.all(keys.map(async (k) => (out[k] = await env.CONFIG.get(k))));
      return J({ ok: true, allow_all: true, keys, values: out });
    }

    if (req.method === "POST" && p === "/admin/config/set") {
      if (!(await requireJson(req))) return badCT();
      const { key, value } = await req.json().catch(() => ({}));
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      await env.CONFIG.put(String(key), String(value ?? ""));
      await audit(env, "config_set", { key });
      return J({ ok: true });
    }

    if (req.method === "POST" && p === "/admin/config/setmany") {
      if (!(await requireJson(req))) return badCT();
      const body = await req.json().catch(() => ({}));
      const entries = body && typeof body === "object" ? body.entries : null;
      if (!entries || typeof entries !== "object") return J({ ok: false, error: "entries_object_required" }, 400);
      await Promise.all(Object.entries(entries).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? ""))));
      await audit(env, "config_setmany", { count: Object.keys(entries).length });
      return J({ ok: true });
    }

    if (req.method === "POST" && p === "/admin/config/delete") {
      if (!(await requireJson(req))) return badCT();
      const { key } = await req.json().catch(() => ({}));
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      await env.CONFIG.delete(String(key));
      await audit(env, "config_delete", { key });
      return J({ ok: true });
    }

    if (req.method === "GET" && p === "/admin/config/export") {
      const keys = await listAllConfigKeys(env, { cap: 5000 });
      const out = {};
      await Promise.all(keys.map(async (k) => (out[k] = await env.CONFIG.get(k))));
      return new Response(JSON.stringify({ ts: Date.now(), allow_all: true, values: out }, null, 2), {
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
      await Promise.all(Object.entries(values).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? ""))));
      await audit(env, "config_import", { count: Object.keys(values).length, allow_all: true });
      return J({ ok: true, allow_all: true, written: Object.keys(values).length });
    }

    // Health
    if (req.method === "GET" && p === "/admin/health") return J({ ok: true, now: Date.now(), allow_all: true });

    return new Response("Not found", { status: 404, headers: secHeaders() });
  }
};

/* ---------- Auth / Allowlist ---------- */
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
function needsOtp(path) {
  if (path === "/admin" || path === "/admin/" || path === "/admin/health") return false;
  return path.startsWith("/admin/config");
}

/* ---------- KV Keys auflisten ---------- */
async function listAllConfigKeys(env, { prefix = "", cap = 1000 } = {}) {
  let cursor = undefined;
  const found = [];
  while (found.length < cap) {
    const res = await env.CONFIG.list({ prefix, cursor });
    (res.keys || []).forEach(k => found.push(k.name));
    if (!res.list_complete && res.cursor) cursor = res.cursor;
    else break;
  }
  return found;
}

/* ---------- Audit (optional) ---------- */
async function audit(env, action, detail) {
  if (!env.OPS) return;
  const key = `audit:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    await env.OPS.put(key, JSON.stringify({ action, detail, ts: Date.now() }), { expirationTtl: 86400 * 30 });
  } catch {}
}

/* ---------- Helpers ---------- */
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

/* ---------- TOTP ---------- */
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
  for (let i = 7; i >= 0; i--) { counterBuf[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: { name: algo } }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBuf));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return (bin % mod).toString().padStart(digits, "0");
}
function base32Decode(s) {
  const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const map = Object.fromEntries(ALPH.split("").map((c, i) => [c, i]));
  const str = s.toUpperCase().replace(/=+$/, "").replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of str) { const v = map[ch]; if (v == null) continue; bits += v.toString(2).padStart(5, "0"); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(out);
}

/* ---------- Simple UI ---------- */
function ui() {
  const html = `<!doctype html>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>INPI Admin</title>
<style>
:root{ color-scheme: light dark; font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell; }
body{ margin:0; background:#0b0d10; color:#e8eef6 }
header{ display:flex; gap:1rem; align-items:center; padding:12px 16px; background:#0f1318; border-bottom:1px solid #233; }
main{ padding:16px; max-width:1100px; margin:0 auto; }
.card{ border:1px solid #233; border-radius:10px; padding:12px; background:#0f1318; margin:12px 0; }
input,select,button,textarea{ font:inherit; padding:.5rem; border-radius:8px; border:1px solid #345; background:#0b0f14; color:#e8eef6; }
button{ background:#1e6ad1; border:none; cursor:pointer; }
button.secondary{ background:#263446; }
pre.small{ font-size:12px; white-space:pre-wrap; word-break:break-word }
.grid{ display:grid; grid-template-columns: 220px 1fr; gap:.6rem .8rem; align-items:center; }
.muted{ color:#a9b3be }
</style>
<header><h1>INPI Admin</h1><small class="muted">Whitelist: OFF</small></header>
<main>
  <section class="card">
    <h2>Config bearbeiten</h2>
    <div class="grid">
      <label>Key</label>
      <select id="key"></select>
      <label>Value</label>
      <textarea id="val" rows="2"></textarea>
      <div></div>
      <div>
        <button id="btnSet">Set</button>
        <button id="btnDel" class="secondary">Delete</button>
      </div>
    </div>
  </section>
  <section class="card"><h2>Export / Import</h2>
    <button id="btnExport">Export JSON</button>
    <input type="file" id="file" accept="application/json"/>
    <button id="btnImport" class="secondary">Import</button>
  </section>
  <section class="card"><h2>Aktuelle Werte</h2><pre id="dump" class="small"></pre></section>
</main>
<script>
async function jfetch(u,opt={}){const r=await fetch(u,opt);const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}return{ok:r.ok,status:r.status,j,raw:t,r};}
async function loadKeys(){const {j}=await jfetch('/admin/config/keys');const sel=document.getElementById('key');sel.innerHTML='';(j?.keys||[]).forEach(k=>{const o=document.createElement('option');o.value=k;o.textContent=k;sel.appendChild(o);});}
async function loadDump(){const {j}=await jfetch('/admin/config');document.getElementById('dump').textContent=JSON.stringify(j?.values||{},null,2);}
document.getElementById('btnSet').onclick=async()=>{const key=document.getElementById('key').value;const value=document.getElementById('val').value;const {j:res}=await jfetch('/admin/config/set',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,value})});alert(JSON.stringify(res));loadDump();};
document.getElementById('btnDel').onclick=async()=>{const key=document.getElementById('key').value;const {j:res}=await jfetch('/admin/config/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})});alert(JSON.stringify(res));loadDump();};
document.getElementById('btnExport').onclick=async()=>{const {r}=await jfetch('/admin/config/export');const b=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='inpi-config-export.json';a.click();};
document.getElementById('btnImport').onclick=async()=>{const f=document.getElementById('file').files[0];if(!f)return alert('JSON wählen');const txt=await f.text();const {j:res}=await jfetch('/admin/config/import',{method:'POST',headers:{'content-type':'application/json'},body:txt});alert(JSON.stringify(res));loadDump();};
loadKeys().then(loadDump);
</script>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...secHeaders() }});
}