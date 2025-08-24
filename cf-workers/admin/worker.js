export default {
  async fetch(req, env) {
    // Basic/Realm + (optional) IP-Allowlist
    if (!basicOk(req, env) || !ipOk(req, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Basic realm="${env.ADMIN_REALM||'Admin'}"`,
          ...secHeaders()
        }
      });
    }

    const url = new URL(req.url);
    const p = url.pathname;

    // UI
    if (req.method === "GET" && p === "/admin") return ui(env);

    // Konfig lesen (alles oder einzelner Key)
    if (req.method === "GET" && p === "/admin/config") {
      const key = url.searchParams.get("key");
      if (key) {
        const v = await env.CONFIG.get(key);
        return J({ ok:true, key, value: v });
      }
      const keys = getConfigKeys(env);
      const out = {};
      await Promise.all(keys.map(async k => { out[k] = await env.CONFIG.get(k); }));
      return J({ ok:true, keys, values: out });
    }

    // Schlüssel auflisten (aus ENV oder Fallback)
    if (req.method === "GET" && p === "/admin/config/keys") {
      return J({ ok:true, keys: getConfigKeys(env) });
    }

    // Setzen eines Keys
    if (req.method === "POST" && p === "/admin/config/set") {
      await requireJson(req);
      const { key, value } = await req.json().catch(()=> ({}));
      if (!key) return J({ ok:false, error:"key_required" }, 400);
      if (!keyAllowed(env, key)) return J({ ok:false, error:"key_not_allowed" }, 403);
      await env.CONFIG.put(String(key), String(value ?? ""));
      await audit(env, "config_set", { key, value });
      return J({ ok:true });
    }

    // Viele Keys in einem Rutsch setzen
    if (req.method === "POST" && p === "/admin/config/setmany") {
      await requireJson(req);
      const { entries } = await req.json().catch(()=> ({}));
      if (!entries || typeof entries !== "object") return J({ ok:false, error:"entries_object_required" }, 400);

      for (const [k,v] of Object.entries(entries)) {
        if (!keyAllowed(env, k)) return J({ ok:false, error:`key_not_allowed:${k}` }, 403);
      }
      await Promise.all(Object.entries(entries).map(([k,v]) => env.CONFIG.put(String(k), String(v ?? ""))));
      await audit(env, "config_setmany", { count: Object.keys(entries).length });
      return J({ ok:true });
    }

    // Löschen eines Keys
    if (req.method === "POST" && p === "/admin/config/delete") {
      await requireJson(req);
      const { key } = await req.json().catch(()=> ({}));
      if (!key) return J({ ok:false, error:"key_required" }, 400);
      if (!keyAllowed(env, key)) return J({ ok:false, error:"key_not_allowed" }, 403);
      await env.CONFIG.delete(key);
      await audit(env, "config_delete", { key });
      return J({ ok:true });
    }

    // Export aller erlaubten Keys
    if (req.method === "GET" && p === "/admin/config/export") {
      const keys = getConfigKeys(env);
      const out = {};
      await Promise.all(keys.map(async k => { out[k] = await env.CONFIG.get(k); }));
      return new Response(JSON.stringify({ ts: Date.now(), values: out }, null, 2), {
        headers: {
          "content-type":"application/json",
          "content-disposition":"attachment; filename=inpi-config-export.json",
          ...secHeaders()
        }
      });
    }

    // Import (überschreibt nur erlaubte Keys)
    if (req.method === "POST" && p === "/admin/config/import") {
      await requireJson(req);
      const { values } = await req.json().catch(()=> ({}));
      if (!values || typeof values !== "object") return J({ ok:false, error:"values_object_required" }, 400);
      const allowed = getConfigKeys(env);
      const write = {};
      for (const [k,v] of Object.entries(values)) if (allowed.includes(k)) write[k]=v;
      await Promise.all(Object.entries(write).map(([k,v]) => env.CONFIG.put(String(k), String(v ?? ""))));
      await audit(env, "config_import", { count: Object.keys(write).length });
      return J({ ok:true, written: Object.keys(write).length });
    }

    // Health
    if (req.method === "GET" && p === "/admin/health") {
      return J({ ok:true, now: Date.now(), account: env.__STATIC_CONTENT ? "pages" : "workers" });
    }

    return new Response("Not found", { status: 404, headers: secHeaders() });
  }
};

/* ---------- Auth / Allowlist ---------- */
function basicOk(req, env){
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  const [u,p] = atob(h.slice(6)).split(":");
  return u === env.ADMIN_USER && p === env.ADMIN_PASS;
}
function ipOk(req, env){
  const allow = (env.IP_ALLOWLIST||"").split(",").map(s=>s.trim()).filter(Boolean);
  if (allow.length===0) return true;
  const ip = req.headers.get("cf-connecting-ip") || "";
  return allow.includes(ip);
}

/* ---------- Config Keys ---------- */
function getConfigKeys(env){
  const csv = (env.CONFIG_KEYS||"").trim();
  if (csv) return csv.split(",").map(s=>s.trim()).filter(Boolean);
  // Fallback-Liste (wenn CONFIG_KEYS leer ist)
  return [
    "presale_state","tge_ts","presale_price_usdc","public_price_usdc","presale_target_usdc","cap_per_wallet_usdc",
    "presale_deposit_usdc","lp_split_bps","lp_lock_initial_days","lp_lock_rolling_days",
    "staking_total_inpi","staking_fee_bps","staking_start_ts","staking_end_ts",
    "buyback_enabled","buyback_min_usdc","buyback_twap_slices","buyback_cooldown_min",
    "governance_multisig","timelock_seconds","project_uri","whitepaper_sha256","ops_api_key","twap_enabled"
  ];
}
function keyAllowed(env, k){
  return getConfigKeys(env).includes(String(k));
}

/* ---------- Audit (optional via OPS KV) ---------- */
async function audit(env, action, detail){
  if (!env.OPS) { /* kein OPS gebunden */ return; }
  const key = `audit:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
  try { await env.OPS.put(key, JSON.stringify({ action, detail, ts: Date.now() }), { expirationTtl: 86400*30 }); } catch {}
}

/* ---------- Helpers ---------- */
async function requireJson(req){
  const ct = (req.headers.get("content-type")||"").toLowerCase();
  if (!ct.includes("application/json")) throw new Response("Bad Content-Type", { status: 415, headers: secHeaders() });
}
const J = (x, status=200)=> new Response(JSON.stringify(x), { status, headers: { "content-type":"application/json", ...secHeaders() } });

function secHeaders(){
  return {
    "x-content-type-options":"nosniff",
    "x-frame-options":"DENY",
    "referrer-policy":"strict-origin-when-cross-origin",
    "permissions-policy":"geolocation=(), microphone=(), camera=()",
    "strict-transport-security":"max-age=31536000; includeSubDomains; preload",
    "cache-control":"no-store"
  };
}

/* ---------- UI ---------- */
function ui(env){
  const html = `<!doctype html>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>INPI Admin</title>
<style>
:root{ color-scheme: light dark; font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell; }
body{ margin:0; background:#0b0d10; color:#e9eef6; }
header{ padding:12px 16px; border-bottom:1px solid #2a3240; position:sticky; top:0; background:#12151a; }
main{ max-width:1000px; margin:0 auto; padding:20px 16px 60px; }
h1{ margin:0; font-size:18px; }
.card{ border:1px solid #2a3240; border-radius:12px; padding:14px; background:#12151a; margin:14px 0; }
input,textarea{ width:100%; padding:10px 12px; border-radius:10px; border:1px solid #2a3240; background:transparent; color:inherit; }
button{ padding:10px 14px; border-radius:10px; border:0; cursor:pointer; background:#1d64ff; color:#fff; font-weight:600; }
button.secondary{ background:transparent; border:1px solid #2a3240; }
pre{ background:#0e1116; border:1px solid #2a3240; border-radius:10px; padding:10px; overflow:auto; }
.small{ color:#9fb0c3; font-size:12px; }
.grid{ display:grid; gap:12px; grid-template-columns: repeat(auto-fit, minmax(240px,1fr)); }
.row{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
</style>
<header><h1>INPI Admin</h1></header>
<main>
  <div class="card">
    <div class="row">
      <button onclick="load()">Konfig laden</button>
      <button class="secondary" onclick="exportCfg()">Export</button>
    </div>
    <pre id="cfg">(noch leer)</pre>
    <div class="small">Hinweis: <code>tge_ts</code> wird als Unix-Sekunden gespeichert (Worker rechnet intern für ISO um).</div>
  </div>

  <div class="card">
    <h3>Key setzen</h3>
    <div class="grid">
      <div><input id="k" placeholder="key (z.B. presale_state)"></div>
      <div><input id="v" placeholder="value"></div>
    </div>
    <div class="row" style="margin-top:8px;">
      <button onclick="setOne()">Set</button>
      <button class="secondary" onclick="delOne()">Delete</button>
    </div>
  </div>

  <div class="card">
    <h3>Batch-Set (JSON Objekt)</h3>
    <textarea id="batch" rows="8" placeholder='{"presale_state":"pre","presale_price_usdc":"0.00031415"}'></textarea>
    <div class="row" style="margin-top:8px;">
      <button onclick="setMany()">Setmany</button>
      <button class="secondary" onclick="importCfg()">Import JSON</button>
    </div>
  </div>

  <div class="card small">
    <b>Erlaubte Keys</b>
    <pre id="keys">Lade…</pre>
  </div>
</main>
<script>
async function load(){
  const r = await fetch('/admin/config');
  const j = await r.json();
  document.getElementById('cfg').textContent = JSON.stringify(j.values || j, null, 2);
}
async function exportCfg(){
  const r = await fetch('/admin/config/export');
  const blob = await r.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'inpi-config-export.json'; a.click();
}
async function setOne(){
  const key = document.getElementById('k').value.trim();
  const value = document.getElementById('v').value;
  if(!key) return alert('key fehlt');
  const r = await fetch('/admin/config/set', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key,value})});
  alert(await r.text()); load();
}
async function delOne(){
  const key = document.getElementById('k').value.trim();
  if(!key) return alert('key fehlt');
  if(!confirm('Wirklich löschen: '+key+' ?')) return;
  const r = await fetch('/admin/config/delete', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key})});
  alert(await r.text()); load();
}
async function setMany(){
  let obj; try{ obj = JSON.parse(document.getElementById('batch').value||"{}"); }catch(e){ return alert('Kein gültiges JSON'); }
  const r = await fetch('/admin/config/setmany', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({entries: obj})});
  alert(await r.text()); load();
}
async function importCfg(){
  const txt = prompt('Bitte JSON einfügen ({"values":{...}} oder direkt Werte-Objekt)');
  if(!txt) return;
  let data; try{ data = JSON.parse(txt); }catch(e){ return alert('Kein gültiges JSON'); }
  const body = data.values ? data : { values: data };
  const r = await fetch('/admin/config/import', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
  alert(await r.text()); load();
}
async function loadKeys(){
  const j = await (await fetch('/admin/config/keys')).json();
  document.getElementById('keys').textContent = JSON.stringify(j.keys || [], null, 2);
}
loadKeys(); load();
</script>`;
  return new Response(html, { headers: { "content-type":"text/html; charset=utf-8", ...secHeaders() }});
}