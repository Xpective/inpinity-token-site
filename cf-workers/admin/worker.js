export default {
  async fetch(req, env) {
    if (!checkAuth(req, env)) {
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="INPI Admin"' }});
    }

    const url = new URL(req.url);
    if (url.pathname === "/admin") return ui();
    if (url.pathname === "/admin/config" && req.method === "GET") {
      const keys = [
        "presale_state","tge_ts","presale_price_usdc","presale_target_usdc","cap_per_wallet_usdc",
        "presale_deposit_usdc","lp_split_bps","lp_lock_initial_days","lp_lock_rolling_days",
        "staking_total_inpi","staking_fee_bps","staking_start_ts","staking_end_ts",
        "buyback_enabled","buyback_min_usdc","buyback_twap_slices","buyback_cooldown_min",
        "governance_multisig","timelock_seconds"
      ];
      const out = {};
      await Promise.all(keys.map(async k => { out[k] = await env.CONFIG.get(k); }));
      return json(out);
    }
    if (url.pathname === "/admin/config" && req.method === "POST") {
      const body = await req.json().catch(()=> ({}));
      const { key, value } = body;
      if (!key || typeof value === "undefined") return json({ok:false, error:"key/value fehlt"}, 400);
      await env.CONFIG.put(key, String(value));
      return json({ok:true});
    }
    return new Response("Not found", { status: 404 });
  }
};

function checkAuth(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  const [user, pass] = atob(h.slice(6)).split(":");
  return user === env.ADMIN_USER && pass === env.ADMIN_PASS;
}
function ui() {
  const html = `<!doctype html><meta charset="utf-8"/>
  <title>INPI Admin</title>
  <h1>INPI Admin</h1>
  <button onclick="load()">Laden</button>
  <pre id="cfg" style="background:#111;color:#0f0;padding:8px;"></pre>
  <hr/>
  <form onsubmit="setkv(event)">
    <input id="k" placeholder="key" required>
    <input id="v" placeholder="value" required>
    <button>Set</button>
  </form>
  <script>
  async function load(){
    const r = await fetch('/admin/config'); 
    document.getElementById('cfg').textContent = JSON.stringify(await r.json(), null, 2);
  }
  async function setkv(e){
    e.preventDefault();
    const key = document.getElementById('k').value;
    const value = document.getElementById('v').value;
    const r = await fetch('/admin/config', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key,value})});
    alert(JSON.stringify(await r.json()));
    load();
  }
  </script>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" }});
}
function json(x, status=200){ return new Response(JSON.stringify(x), {status, headers:{'content-type':'application/json'}}); }