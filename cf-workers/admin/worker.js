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
  // WICHTIG: Im <script> KEINE Backticks/Interpolation benutzen (nur concat).
  const html = `<!doctype html>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>INPI Admin</title>
<style>
:root{ color-scheme: light dark; font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell; }
body{ margin:0; background:#0b0d10; color:#e9eef6; }
header{ padding:12px 16px; border-bottom:1px solid #2a3240; position:sticky; top:0; background:#12151a; display:flex; gap:10px; align-items:center; }
h1{ margin:0; font-size:18px; }
main{ max-width:1100px; margin:0 auto; padding:20px 16px 60px; }
.tabs{ display:flex; gap:6px; margin-bottom:12px; }
.tab{ padding:8px 10px; border:1px solid #2a3240; border-bottom:0; border-radius:10px 10px 0 0; background:#0e1116; cursor:pointer; }
.tab.active{ background:#1a1f2a; }
.card{ border:1px solid #2a3240; border-radius:12px; padding:14px; background:#12151a; margin:14px 0; }
.grid{ display:grid; gap:12px; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); }
.row{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
input,select,textarea{ width:100%; padding:10px 12px; border-radius:10px; border:1px solid #2a3240; background:transparent; color:inherit; }
button{ padding:10px 14px; border-radius:10px; border:0; cursor:pointer; background:#1d64ff; color:#fff; font-weight:600; }
button.secondary{ background:transparent; border:1px solid #2a3240; }
pre{ background:#0e1116; border:1px solid #2a3240; border-radius:10px; padding:10px; overflow:auto; }
.badge{ font-size:12px; border:1px solid #2a3240; padding:2px 8px; border-radius:999px; }
.small{ color:#9fb0c3; font-size:12px; }
.kv{ display:grid; grid-template-columns: 220px 1fr; gap:10px; align-items:center; }
.kv label{ font-size:13px; color:#cfd9ea; }
.kv .hint{ grid-column: 2 / span 1; font-size:12px; color:#9fb0c3; margin-top:-6px;}
.stat{ border:1px solid #2a3240; padding:10px; border-radius:10px; text-align:center; }
.stat b{ font-size:20px; display:block; }
</style>
<header>
  <h1>INPI Admin <span class="badge">Basic${env.ADMIN_TOTP_SECRET ? " + TOTP" : ""}</span></h1>
  <div style="margin-left:auto; display:flex; gap:8px; align-items:center;">
    <input id="otp" placeholder="TOTP (6-stellig)" style="width:160px" inputmode="numeric" />
    <button class="secondary" onclick="saveOtp()">Set OTP</button>
  </div>
</header>
<main>
  <div class="tabs">
    <div class="tab active" id="tabDash" onclick="showTab('dash')">Dashboard</div>
    <div class="tab" id="tabCfg" onclick="showTab('cfg')">Konfigurator</div>
    <div class="tab" id="tabRaw" onclick="showTab('raw')">Raw-Config</div>
  </div>

  <!-- DASHBOARD -->
  <section id="dash">
    <div class="card">
      <div class="row">
        <button onclick="loadStatus()">Status aktualisieren</button>
        <button class="secondary" onclick="reconcileNow()">Reconcile Presale → OPS</button>
        <div class="small" id="dashMsg"></div>
      </div>
      <div class="grid" id="statsGrid"></div>
      <pre id="metricsPre" style="margin-top:12px">(Metriken…)</pre>
    </div>

    <div class="card">
      <h3>Peek Queue</h3>
      <div class="row">
        <select id="peekKind">
          <option value="">(alle)</option>
          <option value="PRESALE_ALLOCATION">PRESALE_ALLOCATION</option>
          <option value="BUYBACK_TWAP_AND_LP">BUYBACK_TWAP_AND_LP</option>
          <option value="CREATOR_PAYOUT_USDC">CREATOR_PAYOUT_USDC</option>
          <option value="CREATOR_PAYOUT_INPI">CREATOR_PAYOUT_INPI</option>
        </select>
        <input id="peekLimit" type="number" min="1" max="100" value="10" style="width:120px"/>
        <button onclick="peekQueue()">Peek</button>
      </div>
      <pre id="peekPre">(leer)</pre>
    </div>
  </section>

  <!-- KONFIGURATOR 2.0 -->
  <section id="cfg" style="display:none;">
    <div class="card">
      <div class="row">
        <button onclick="loadForm()">Werte laden</button>
        <button class="secondary" onclick="saveChanged()">Geänderte speichern</button>
      </div>
      <div id="formGrid" class="kv"></div>
      <div class="small" style="margin-top:8px;">Nur geänderte Felder werden gespeichert. Typen & Bereiche werden validiert.</div>
    </div>
  </section>

  <!-- RAW-Fallback -->
  <section id="raw" style="display:none;">
    <div class="card">
      <div class="row">
        <button onclick="loadRaw()">Konfig laden</button>
        <button class="secondary" onclick="exportCfg()">Export</button>
      </div>
      <pre id="cfgPre">(noch leer)</pre>
      <div class="row" style="margin-top:8px;">
        <input id="k" placeholder="key (z.B. presale_state)">
        <input id="v" placeholder="value">
        <button onclick="setOne()">Set</button>
        <button class="secondary" onclick="delOne()">Delete</button>
      </div>
      <div style="margin-top:10px;">
        <textarea id="batch" rows="6" style="width:100%;" placeholder='{"presale_state":"pre","presale_price_usdc":"0.00031415"}'></textarea>
        <div class="row" style="margin-top:8px;">
          <button onclick="setMany()">Setmany</button>
          <button class="secondary" onclick="importCfg()">Import JSON</button>
        </div>
      </div>
      <div class="card small">
        <b>Erlaubte Keys</b>
        <pre id="keys">Lade…</pre>
      </div>
    </div>
  </section>
</main>

<script>
// -------- Kein Template-Literal/Interpolation im Script! --------

/* ------------- OTP Helpers ------------- */
var LS_KEY="inpi_admin_otp";
function getOtp(){ return localStorage.getItem(LS_KEY)||document.getElementById('otp').value||""; }
function saveOtp(){ localStorage.setItem(LS_KEY, document.getElementById('otp').value||""); alert("OTP gespeichert (local)"); }
function otpHdr(){ var v=getOtp(); return v?{'x-otp': v}:{ }; }

/* ------------- Tabs ------------- */
function showTab(t){
  var ids = ["dash","cfg","raw"];
  for (var i=0;i<ids.length;i++){
    var id = ids[i];
    document.getElementById(id).style.display = (id===t?"block":"none");
  }
  document.getElementById("tabDash").classList.toggle("active", t==="dash");
  document.getElementById("tabCfg").classList.toggle("active", t==="cfg");
  document.getElementById("tabRaw").classList.toggle("active", t==="raw");
}

/* ------------- Dashboard ------------- */
async function loadStatus(){
  document.getElementById('dashMsg').textContent = "Lade Status…";
  var r = await fetch('/admin/cron/status', { headers: otpHdr() });
  if (r.status===401){ alert("401 Unauthorized (OTP?)"); return; }
  var j = await r.json();
  document.getElementById('dashMsg').textContent = "OK";
  // Stats
  var g = document.getElementById('statsGrid');
  g.innerHTML = "";
  var stats = j.stats || {};
  var keys = Object.keys(stats).sort();
  for (var i=0;i<keys.length;i++){
    var k = keys[i];
    var div = document.createElement('div');
    div.className = "stat";
    div.innerHTML = '<b>' + (stats[k]!=null?stats[k]:'') + '</b><div class="small">' + k + '</div>';
    g.appendChild(div);
  }
  // Metrics
  document.getElementById('metricsPre').textContent = JSON.stringify(j.metrics || {}, null, 2);
}

async function reconcileNow(){
  var limit = prompt("Max. Anzahl zu spiegelnder Presale-Intents (z.B. 200):", "200");
  if (!limit) return;
  var r = await fetch('/admin/cron/reconcile', {
    method:'POST',
    headers:{'content-type':'application/json', ...otpHdr()},
    body: JSON.stringify({ limit: Number(limit) })
  });
  alert(await r.text());
  loadStatus();
}

async function peekQueue(){
  var kind = document.getElementById('peekKind').value || "";
  var limit = document.getElementById('peekLimit').value || "10";
  var qs = '?limit=' + encodeURIComponent(limit) + (kind ? '&kind=' + encodeURIComponent(kind) : '');
  var r = await fetch('/admin/ops/peek' + qs, { headers: otpHdr() });
  document.getElementById('peekPre').textContent = await r.text();
}

/* ------------- Konfigurator 2.0 ------------- */
var SCHEMA = [
  // Core / Phasen
  { key:"presale_state", label:"Presale State", type:"select", options:["pre","closed","claim","live"], hint:"Phase steuern" },
  { key:"tge_ts", label:"TGE (ms)", type:"number", min:0, step:1, hint:"Unix ms (Date.now())" },
  { key:"presale_price_usdc", label:"Presale Preis (USDC)", type:"number", min:0, step:"0.00000001" },
  { key:"public_price_usdc",  label:"Public Preis (USDC)",  type:"number", min:0, step:"0.00000001" },
  { key:"presale_target_usdc",label:"Ziel Presale (USDC)",   type:"number", min:0, step:1 },
  { key:"cap_per_wallet_usdc",label:"Cap/WALLET (USDC)",    type:"number", min:0, step:1 },
  { key:"presale_deposit_usdc",label:"USDC ATA (Deposit)",  type:"text",   pattern:"^[1-9A-HJ-NP-Za-km-z]{32,44}$", hint:"USDC-ATA-Adresse" },

  // Gates
  { key:"nft_gate_enabled", label:"NFT-Gate aktiv?", type:"select", options:["false","true"], hint:"Nur Käufer mit NFT-Collection" },
  { key:"nft_gate_collection", label:"NFT Collection", type:"text", hint:"Kollections-Adresse" },
  { key:"public_mint_enabled", label:"Public-Gate aktiv?", type:"select", options:["false","true"], hint:"Ohne NFT erlaubt" },
  { key:"public_mint_price_usdc", label:"Public-Preis (USDC)", type:"number", min:0, step:"0.000001" },
  { key:"public_mint_fee_bps", label:"Public Fee (bps)", type:"number", min:0, max:10000, step:1 },
  { key:"public_mint_fee_dest", label:"Fee Ziel", type:"select", options:["lp","treasury"], hint:"Standard: lp" },

  // LP / Locks
  { key:"lp_split_bps", label:"LP-Split (bps)", type:"number", min:0, max:10000, step:1, hint:"Bsp 5000=50%" },
  { key:"lp_bucket_usdc", label:"LP Bucket (USDC)", type:"number", min:0, step:"0.000001" },
  { key:"lp_lock_initial_days", label:"LP Lock initial (Tage)", type:"number", min:0, step:1 },
  { key:"lp_lock_rolling_days", label:"LP Lock rollierend (Tage)", type:"number", min:0, step:1 },

  // Staking
  { key:"staking_total_inpi", label:"Staking Pool (INPI)", type:"number", min:0, step:1 },
  { key:"staking_fee_bps", label:"Staking Fee (bps)", type:"number", min:0, max:10000, step:1 },
  { key:"staking_start_ts", label:"Staking Start (ms)", type:"number", min:0, step:1 },
  { key:"staking_end_ts", label:"Staking Ende (ms)", type:"number", min:0, step:1 },

  // Buyback / TWAP
  { key:"buyback_enabled", label:"Buyback an?", type:"select", options:["false","true"] },
  { key:"buyback_min_usdc", label:"Buyback min (USDC)", type:"number", min:0, step:"0.000001" },
  { key:"buyback_twap_slices", label:"TWAP Slices", type:"number", min:1, max:48, step:1 },
  { key:"buyback_cooldown_min", label:"Cooldown (min)", type:"number", min:0, step:1 },
  { key:"buyback_split_burn_bps", label:"Buyback Burn bps", type:"number", min:0, max:10000, step:1 },
  { key:"buyback_split_lp_bps", label:"Buyback LP bps", type:"number", min:0, max:10000, step:1 },

  // Safety Net: Floor-Vault
  { key:"floor_enabled", label:"Floor aktiv?", type:"select", options:["false","true"] },
  { key:"floor_min_usdc_per_inpi", label:"Floor USDC/INPI", type:"number", min:0, step:"0.00000001" },
  { key:"floor_window_min", label:"Floor-Fenster (Min)", type:"number", min:0, step:1 },
  { key:"floor_daily_cap_usdc", label:"Floor Tages-Cap (USDC)", type:"number", min:0, step:"0.01" },

  // Safety Net: Circuit Breaker
  { key:"cb_enabled", label:"Circuit Breaker aktiv?", type:"select", options:["false","true"] },
  { key:"cb_drop_pct_1h", label:"Drop % / 1h", type:"number", min:0, max:100, step:1 },
  { key:"cb_vol_mult", label:"Volumen Multiplikator", type:"number", min:0, step:1 },
  { key:"cb_cooldown_min", label:"CB Cooldown (Min)", type:"number", min:0, step:1 },

  // Streams
  { key:"creator_usdc_stream_monthly_usdc", label:"Creator USDC/Monat", type:"number", min:0, step:"0.000001" },
  { key:"creator_usdc_stream_months", label:"Monate (USDC)", type:"number", min:0, step:1 },
  { key:"creator_usdc_stream_next_ts", label:"Nächster USDC-Zeitpunkt (ms)", type:"number", min:0, step:1 },

  { key:"creator_inpi_stream_bps_per_month", label:"Creator INPI bps/Monat", type:"number", min:0, max:10000, step:1 },
  { key:"creator_inpi_stream_months", label:"Monate (INPI)", type:"number", min:0, step:1 },
  { key:"creator_inpi_stream_next_ts", label:"Nächster INPI-Zeitpunkt (ms)", type:"number", min:0, step:1 },

  // Supply & Governance
  { key:"supply_total", label:"Total Supply (INPI)", type:"number", min:0, step:1 },
  { key:"governance_multisig", label:"Governance Multisig", type:"text", hint:"Pubkey/Address" },
  { key:"timelock_seconds", label:"Timelock (s)", type:"number", min:0, step:1 },

  // Meta / Links
  { key:"project_uri", label:"Project URI", type:"text", hint:"https://inpinity.online/token" },
  { key:"whitepaper_sha256", label:"Whitepaper SHA-256", type:"text", hint:"Hash der PDF" },
  { key:"twap_enabled", label:"TWAP aktiv?", type:"select", options:["false","true"] },

  // Distribution (bps, sum=10000)
  { key:"dist_presale_bps", label:"Dist Presale (bps)", type:"number", min:0, max:10000, step:1 },
  { key:"dist_dex_liquidity_bps", label:"Dist DEX/LP (bps)", type:"number", min:0, max:10000, step:1 },
  { key:"dist_staking_bps", label:"Dist Staking (bps)", type:"number", min:0, max:10000, step:1 },
  { key:"dist_ecosystem_bps", label:"Dist Ecosystem (bps)", type:"number", min:0, max:10000, step:1 },
  { key:"dist_treasury_bps", label:"Dist Treasury (bps)", type:"number", min:0, max:10000, step:1 },
  { key:"dist_team_bps", label:"Dist Team (bps)", type:"number", min:0, max:10000, step:1 },
  { key:"dist_airdrop_nft_bps", label:"Dist Airdrop NFT (bps)", type:"number", min:0, max:10000, step:1 },
  { key:"dist_buyback_reserve_bps", label:"Dist Buyback Reserve (bps)", type:"number", min:0, max:10000, step:1 }
];

var CURRENT = {};

function el(tag, attrs, html){
  var e = document.createElement(tag);
  attrs = attrs || {};
  for (var k in attrs){ if (Object.prototype.hasOwnProperty.call(attrs,k)) e.setAttribute(k, attrs[k]); }
  if (html) e.innerHTML = html;
  return e;
}

async function loadForm(){
  var r = await fetch('/admin/config', { headers: otpHdr() });
  if (r.status===401){ alert("401 Unauthorized (OTP?)"); return; }
  var j = await r.json();
  CURRENT = j.values || {};
  var grid = document.getElementById('formGrid');
  grid.innerHTML = "";
  for (var i=0;i<SCHEMA.length;i++){
    var fld = SCHEMA[i];
    var label = el("label", {}, fld.label || fld.key);
    label.setAttribute("for", "fld_"+fld.key);
    grid.appendChild(label);

    var input;
    var val = (CURRENT[fld.key] != null ? CURRENT[fld.key] : "");
    if (fld.type === "select"){
      input = el("select", { id:"fld_"+fld.key, "data-key": fld.key });
      var opts = fld.options || [];
      for (var j2=0;j2<opts.length;j2++){
        var opt = String(opts[j2]);
        var o = el("option", { value: opt }, opt);
        if (String(val) === opt) o.selected = true;
        input.appendChild(o);
      }
    } else if (fld.type === "number"){
      input = el("input", { id:"fld_"+fld.key, type:"number", "data-key": fld.key, value: val });
      if (fld.min!=null) input.min = fld.min;
      if (fld.max!=null) input.max = fld.max;
      if (fld.step!=null) input.step = fld.step;
    } else {
      input = el("input", { id:"fld_"+fld.key, type:"text", "data-key": fld.key, value: val });
      if (fld.pattern) input.pattern = fld.pattern;
    }
    input.addEventListener('change', function(){ this.dataset.changed="1"; });
    grid.appendChild(input);

    var hint = el("div", { class:"hint" }, fld.hint||"");
    grid.appendChild(el("div")); // spacer for grid col 1
    grid.appendChild(hint);
  }
}

function collectChanged(){
  var entries = {};
  for (var i=0;i<SCHEMA.length;i++){
    var fld = SCHEMA[i];
    var elx = document.getElementById("fld_"+fld.key);
    if (!elx || !elx.dataset.changed) continue;
    var v = elx.value;
    if (fld.type==="number" && v!=="") v = String(v); // KV speichert als String
    entries[fld.key] = v;
  }
  return entries;
}

function validate(){
  for (var i=0;i<SCHEMA.length;i++){
    var fld = SCHEMA[i];
    var elx = document.getElementById("fld_"+fld.key);
    if (!elx) continue;
    if (elx.type==="number"){
      var val = elx.value==="" ? null : Number(elx.value);
      if (val!=null){
        if (elx.min!=="" && val < Number(elx.min)) return "Feld " + fld.key + ": kleiner als min";
        if (elx.max!=="" && val > Number(elx.max)) return "Feld " + fld.key + ": größer als max";
      }
    }
    if (elx.pattern){
      var re = new RegExp(elx.pattern);
      if (elx.value && !re.test(elx.value)) return "Feld " + fld.key + ": Format ungültig";
    }
  }
  return null;
}

async function saveChanged(){
  var err = validate();
  if (err) { alert(err); return; }
  var entries = collectChanged();
  if (Object.keys(entries).length===0){ alert("Keine Änderungen"); return; }
  var r = await fetch('/admin/config/setmany', { method:'POST', headers:{'content-type':'application/json', ...otpHdr()}, body: JSON.stringify({ entries: entries }) });
  alert(await r.text());
  loadForm();
}

/* ------------- RAW-Tools (Fallback) ------------- */
async function loadRaw(){
  var r = await fetch('/admin/config', { headers: otpHdr() });
  if (r.status===401){ alert("401 Unauthorized (OTP?)"); return; }
  var j = await r.json();
  document.getElementById('cfgPre').textContent = JSON.stringify(j.values || j, null, 2);
  var ks = await fetch('/admin/config/keys', { headers: otpHdr() }).then(function(r){return r.json();}).catch(function(){return {keys:[]};});
  document.getElementById('keys').textContent = JSON.stringify(ks.keys, null, 2);
}
async function exportCfg(){
  var r = await fetch('/admin/config/export', { headers: otpHdr() });
  if (r.status===401){ alert("401 Unauthorized (OTP?)"); return; }
  var blob = await r.blob();
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'inpi-config-export.json'; a.click();
}
async function setOne(){
  var key = document.getElementById('k').value.trim();
  var value = document.getElementById('v').value;
  if(!key){ alert('key fehlt'); return; }
  var r = await fetch('/admin/config/set', {method:'POST', headers:{'content-type':'application/json', ...otpHdr()}, body: JSON.stringify({key:key,value:value})});
  alert(await r.text()); loadRaw();
}
async function delOne(){
  var key = document.getElementById('k').value.trim();
  if(!key){ alert('key fehlt'); return; }
  if(!confirm('Wirklich löschen: ' + key + ' ?')) return;
  var r = await fetch('/admin/config/delete', {method:'POST', headers:{'content-type':'application/json', ...otpHdr()}, body: JSON.stringify({key:key})});
  alert(await r.text()); loadRaw();
}
async function setMany(){
  var txt = document.getElementById('batch').value||"{}";
  var obj;
  try{ obj = JSON.parse(txt); }catch(e){ alert('Kein gültiges JSON'); return; }
  var r = await fetch('/admin/config/setmany', {method:'POST', headers:{'content-type':'application/json', ...otpHdr()}, body: JSON.stringify({entries: obj})});
  alert(await r.text()); loadRaw();
}

/* ------------- Init ------------- */
(function init(){
  var v = localStorage.getItem(LS_KEY)||"";
  if (v) document.getElementById('otp').value = v;
  loadStatus();
})();
</script>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...secHeaders() } });
}