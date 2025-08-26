// INPI Admin Worker (Basic + optional TOTP, Cron-Proxies, Config-API)
// Bindings/Secrets:
// - KV: CONFIG (required), OPS (optional für Audit)
// - Secrets: ADMIN_USER, ADMIN_PASS
// - Optional Secrets: ADMIN_TOTP_SECRET, ADMIN_TOTP_PERIOD, ADMIN_TOTP_WINDOW
// - ENV/Secret: CRON_BASE (z.B. https://inpinity.online/cron), OPS_API_KEY, OPS_HMAC_ALGO
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
    if (req.method === "GET" && (p === "/admin" || p === "/admin/")) return ui(env);

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
  if (path === "/admin" || path === "/admin/" || path === "/admin/health") return false;
  return path.startsWith("/admin/config") || path.startsWith("/admin/cron") || path.startsWith("/admin/ops");
}

/* --------------------- Config Keys --------------------- */
/* Falls ENV.CONFIG_KEYS nicht gesetzt ist, verwenden wir eine
   umfangreiche Default-Whitelist (deine bestehenden Keys + neue Keys). */
const DEFAULT_KEYS = [
  // Core / Phasen / Preise / Wallets / RPC
  "INPI_MINT",
  "presale_state",
  "tge_ts",
  "presale_price_usdc",
  "public_price_usdc",
  "public_mint_price_usdc",
  "presale_target_usdc",
  "cap_per_wallet_usdc",
  "presale_deposit_usdc",
  "public_rpc_url",

  // Gate (KV & ENV-Fallbacks)
  "nft_gate_enabled",
  "gate_collection",
  "nft_gate_collection",
  "gate_mint",

  // Preis-Tiers
  "tier_nft_price_usdc",
  "tier_public_price_usdc",

  // Public Mint & Fees
  "public_mint_enabled",
  "public_mint_fee_bps",
  "public_mint_fee_dest",

  // Quoten / Overflow
  "sale_nft_quota_bps",
  "sale_public_quota_bps",
  "sale_overflow_action",

  // LP
  "lp_split_bps",
  "lp_bucket_usdc",
  "lp_lock_initial_days",
  "lp_lock_rolling_days",

  // Staking
  "staking_total_inpi",
  "staking_fee_bps",
  "staking_start_ts",
  "staking_end_ts",

  // Buyback / Circuit Breaker / Floor
  "buyback_enabled",
  "buyback_min_usdc",
  "buyback_twap_slices",
  "buyback_cooldown_min",
  "buyback_split_burn_bps",
  "buyback_split_lp_bps",
  "cb_enabled",
  "cb_drop_pct_1h",
  "cb_vol_mult",
  "cb_cooldown_min",
  "floor_enabled",
  "floor_min_usdc_per_inpi",
  "floor_window_min",
  "floor_daily_cap_usdc",

  // Early-Claim + Bonus + separater Fee-ATA
  "early_claim_enabled",
  "early_claim_fee_bps",
  "early_claim_fee_dest",
  "wait_bonus_bps",
  "early_fee_usdc_ata",

  // Creator Streams
  "creator_usdc_stream_monthly_usdc",
  "creator_usdc_stream_months",
  "creator_usdc_stream_next_ts",
  "creator_inpi_stream_bps_per_month",
  "creator_inpi_stream_months",
  "creator_inpi_stream_next_ts",

  // Distribution / Meta
  "supply_total",
  "governance_multisig",
  "timelock_seconds",
  "project_uri",
  "whitepaper_sha256",
  "twap_enabled",
  "dist_presale_bps",
  "dist_dex_liquidity_bps",
  "dist_staking_bps",
  "dist_ecosystem_bps",
  "dist_treasury_bps",
  "dist_team_bps",
  "dist_airdrop_nft_bps",
  "dist_buyback_reserve_bps"
];

function getConfigKeys(env) {
  const csv = (env.CONFIG_KEYS || "").trim();
  if (!csv) return DEFAULT_KEYS;
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
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

/* --------------------- Mini-UI --------------------- */
function ui(env) {
  const html =
`<!doctype html>
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
code,kbd{ background:#0b0f14; padding:2px 6px; border-radius:6px; border:1px solid #223; }
small.mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; }
.grid{ display:grid; grid-template-columns: 220px 1fr; gap:.6rem .8rem; align-items:center; }
.muted{ color:#a9b3be }
hr{ border:0; border-top:1px solid #233; margin:12px 0; }
pre.small{ font-size:12px; white-space:pre-wrap; word-break:break-word }
.row{ display:flex; gap:.5rem; flex-wrap:wrap; align-items:center }
input[type="number"]{ width:120px }
</style>
<header>
  <h1>INPI Admin</h1>
  <div class="row" style="margin-left:auto">
    <label for="otp" class="muted">OTP</label>
    <input id="otp" placeholder="123456" inputmode="numeric" pattern="\\d*" />
    <button id="saveOtp" class="secondary">Save OTP</button>
  </div>
</header>
<main>
  <section class="card">
    <h2>Config bearbeiten</h2>
    <div class="grid">
      <label>Key</label>
      <div>
        <select id="key"></select>
        <small class="muted">z.B. <code>gate_collection</code>, <code>public_mint_price_usdc</code>, <code>early_claim_enabled</code>, <code>public_rpc_url</code></small>
      </div>
      <label>Value</label>
      <textarea id="val" rows="2" placeholder="Wert (String)"></textarea>
      <div></div>
      <div class="row">
        <button id="btnSet">Set</button>
        <button id="btnDel" class="secondary">Delete</button>
      </div>
    </div>
    <p class="muted" style="margin-top:.6rem">
      Hinweis: Für dein NFT-Gate ist <b>gate_collection</b> = <code>6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ</code> korrekt.
      <br/>Child-NFTs (einzelne Asset/Mint IDs) sind ebenfalls zulässig. Mehrere Werte via Komma.
      <br/>Early-Claim: <code>early_claim_enabled = true</code>. Separater Fee-ATA: <code>early_fee_usdc_ata</code>.
    </p>
  </section>

  <section class="card">
    <h2>Export / Import</h2>
    <div class="row">
      <button id="btnExport">Export JSON</button>
      <input type="file" id="file" accept="application/json"/>
      <button id="btnImport" class="secondary">Import</button>
    </div>
    <p class="muted">Es werden nur erlaubte Keys geschrieben (Whitelist / ENV.CONFIG_KEYS).</p>
  </section>

  <section class="card">
    <h2>Cron & Ops</h2>
    <div class="row">
      <button id="btnCronStatus">Cron Status</button>
    </div>
    <hr/>
    <div>
      <h3>Presale Reconcile</h3>
      <div class="row">
        <input id="recWallet" placeholder="optional wallet"/>
        <input id="recSince" type="number" placeholder="since_slot (optional)"/>
        <input id="recLimit" type="number" placeholder="limit (optional)"/>
        <button id="btnReconcile">Run</button>
      </div>
    </div>
    <hr/>
    <div>
      <h3>Early-Claims</h3>
      <div class="row">
        <input id="ecLimit" type="number" placeholder="limit (optional)"/>
        <label><input type="checkbox" id="ecDry"/> dry_run</label>
        <button id="btnEarlyClaims">Run</button>
      </div>
    </div>
    <hr/>
    <div>
      <h3>OPS Peek</h3>
      <div class="row">
        <input id="opsPrefix" placeholder="prefix z.B. early_job:"/>
        <input id="opsLimit" type="number" placeholder="limit"/>
        <button id="btnOpsPeek">Peek</button>
      </div>
    </div>
    <pre id="cronOut" class="small"></pre>
  </section>

  <section class="card">
    <h2>Gate Checker</h2>
    <div class="row">
      <input id="chkWallet" placeholder="Wallet Adresse" />
      <button id="btnGateCheck">Check gate_ok</button>
    </div>
    <pre id="gateOut" class="small"></pre>
  </section>

  <section class="card">
    <h2>Aktuelle Werte</h2>
    <pre id="dump" class="small"></pre>
  </section>
</main>
<script>
const OTP_KEY = "inpi_admin_otp";
function getOtp(){ return document.getElementById('otp').value.trim(); }
function setOtp(v){ document.getElementById('otp').value = v || ""; }
document.getElementById('saveOtp').onclick = ()=>{ localStorage.setItem(OTP_KEY, getOtp()); alert('OTP gespeichert'); };
setOtp(localStorage.getItem(OTP_KEY) || "");

async function jfetch(url, opt={}){
  const otp = getOtp();
  opt.headers = opt.headers || {};
  if (otp) opt.headers['x-otp'] = otp;
  const r = await fetch(url, opt);
  const t = await r.text();
  let j=null; try { j = JSON.parse(t); } catch {}
  return { ok:r.ok, status:r.status, j, raw:t, r };
}

async function loadKeys(){
  const { j } = await jfetch('/admin/config/keys');
  const sel = document.getElementById('key');
  sel.innerHTML='';
  (j?.keys||[]).forEach(k=>{ const o=document.createElement('option'); o.value=k; o.textContent=k; sel.appendChild(o); });
}
async function loadDump(){
  const { j } = await jfetch('/admin/config');
  const dump = document.getElementById('dump');
  dump.textContent = JSON.stringify(j?.values||{}, null, 2);
}
document.getElementById('btnSet').onclick = async()=>{
  const key = document.getElementById('key').value;
  const value = document.getElementById('val').value;
  const { j:res } = await jfetch('/admin/config/set', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ key, value }) });
  alert(JSON.stringify(res));
  loadDump();
};
document.getElementById('btnDel').onclick = async()=>{
  const key = document.getElementById('key').value;
  const { j:res } = await jfetch('/admin/config/delete', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ key }) });
  alert(JSON.stringify(res));
  loadDump();
};
document.getElementById('btnExport').onclick = async()=>{
  const { r } = await jfetch('/admin/config/export');
  const b = await r.blob(); const a=document.createElement('a'); a.href= URL.createObjectURL(b); a.download='inpi-config-export.json'; a.click();
};
document.getElementById('btnImport').onclick = async()=>{
  const f = document.getElementById('file').files[0]; if(!f) return alert('JSON wählen');
  const txt = await f.text(); const { j:res } = await jfetch('/admin/config/import', { method:'POST', headers:{'content-type':'application/json'}, body: txt });
  alert(JSON.stringify(res)); loadDump();
};

/* Cron & Ops */
document.getElementById('btnCronStatus').onclick = async()=>{
  const r = await jfetch('/admin/cron/status');
  document.getElementById('cronOut').textContent = r.raw;
};
document.getElementById('btnReconcile').onclick = async()=>{
  const wallet = document.getElementById('recWallet').value.trim();
  const since = Number(document.getElementById('recSince').value||'');
  const limit = Number(document.getElementById('recLimit').value||'');
  const body = {};
  if (wallet) body.only_wallet = wallet;
  if (Number.isFinite(since) && since>0) body.since_slot = since;
  if (Number.isFinite(limit) && limit>0) body.limit = limit;
  const r = await jfetch('/admin/cron/reconcile', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  document.getElementById('cronOut').textContent = r.raw;
};
document.getElementById('btnEarlyClaims').onclick = async()=>{
  const limit = Number(document.getElementById('ecLimit').value||'');
  const dry = document.getElementById('ecDry').checked;
  const body = {};
  if (Number.isFinite(limit) && limit>0) body.limit = limit;
  if (dry) body.dry_run = true;
  const r = await jfetch('/admin/cron/early-claims', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  document.getElementById('cronOut').textContent = r.raw;
};
document.getElementById('btnOpsPeek').onclick = async()=>{
  const prefix = encodeURIComponent(document.getElementById('opsPrefix').value||'');
  const l = encodeURIComponent(document.getElementById('opsLimit').value||'');
  const qs = new URLSearchParams(); if (prefix) qs.set('prefix', decodeURIComponent(prefix)); if (l) qs.set('limit', decodeURIComponent(l));
  const r = await jfetch('/admin/ops/peek' + (qs.toString() ? ('?' + qs.toString()) : ''));
  document.getElementById('cronOut').textContent = r.raw;
};

/* Gate Check */
document.getElementById('btnGateCheck').onclick = async ()=>{
  const w = document.getElementById('chkWallet').value.trim();
  if(!w) return alert('Wallet eingeben');
  const r = await fetch('/api/token/wallet/balances?wallet=' + encodeURIComponent(w));
  const t = await r.text();
  document.getElementById('gateOut').textContent = t;
};

loadKeys().then(loadDump);
</script>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...secHeaders() }});
}