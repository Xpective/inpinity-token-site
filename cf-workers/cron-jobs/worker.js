// Cron-Jobs + OPS-API zum Abholen/Abschließen von Intents durch den Signer-Bot.
// Sicherheit: Bearer OPS_API_KEY Secret.

export default {
  async scheduled(event, env, ctx) {
    const now = Date.now();
    const cfg = await loadConfig(env);
    if (event.cron === "*/30 * * * *" && cfg.buyback_enabled) {
      ctx.waitUntil(handleBuyback(env, cfg, now));
      ctx.waitUntil(handleCreatorStreams(env, cfg, now));
    }
    if (event.cron === "*/10 * * * *") {
      ctx.waitUntil(handleMetrics(env, cfg, now));
    }
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    // Mini-Status
    if (url.pathname === "/cron/status") {
      const last = await env.OPS.get("last_metrics_json");
      return json(last ? JSON.parse(last) : {});
    }
    // OPS: Intents abrufen (nur mit Bearer)
    if (url.pathname === "/cron/ops/next" && req.method === "POST") {
      if (!checkBearer(req, env)) return unauthorized();
      const { kind } = await req.json().catch(()=> ({}));
      const list = await env.OPS.list({ prefix: "intent:" });
      for (const k of list.keys) {
        const key = k.name;
        const val = await env.OPS.get(key);
        if (!val) continue;
        const obj = JSON.parse(val);
        if (kind && obj.kind !== kind) continue;
        // claim: move to inflight
        await env.OPS.delete(key);
        const claimKey = `inflight:${Date.now()}:${cryptoRandom()}`;
        await env.OPS.put(claimKey, JSON.stringify(obj));
        return json({ ok: true, key: claimKey, intent: obj });
      }
      return json({ ok: true, key: null, intent: null });
    }
    // OPS: Intent abschließen
    if (url.pathname === "/cron/ops/complete" && req.method === "POST") {
      if (!checkBearer(req, env)) return unauthorized();
      const { key, result, error } = await req.json().catch(()=> ({}));
      if (!key || (!result && !error)) return json({ ok:false, error:"key/result|error fehlt" }, 400);
      const val = await env.OPS.get(key);
      if (!val) return json({ ok:false, error:"not found" }, 404);
      const doneKey = `done:${key.replace(/^inflight:/,"")}`;
      await env.OPS.put(doneKey, JSON.stringify({ finished: Date.now(), result, error }));
      await env.OPS.delete(key);
      return json({ ok:true });
    }

    return new Response("OK");
  }
};

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}
function checkBearer(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  const token = h.slice(7);
  return token === env.OPS_API_KEY;
}
function json(x, status=200){ return new Response(JSON.stringify(x), {status, headers:{'content-type':'application/json'}}); }
function cryptoRandom(){ return Math.random().toString(36).slice(2); }

async function loadConfig(env) {
  const get = (k, d=null) => env.CONFIG.get(k).then(v => v ?? d);
  const [
    buyback_enabled, buyback_min_usdc, buyback_twap_slices,
    buyback_cooldown_min, buyback_split_burn_bps, buyback_split_lp_bps
  ] = await Promise.all([
    get("buyback_enabled","false"), get("buyback_min_usdc","2000"), get("buyback_twap_slices","6"),
    get("buyback_cooldown_min","30"), get("buyback_split_burn_bps","2500"), get("buyback_split_lp_bps","7500")
  ]);
  return {
    buyback_enabled: String(buyback_enabled) === "true",
    buyback_min_usdc: Number(buyback_min_usdc),
    buyback_twap_slices: Number(buyback_twap_slices),
    buyback_cooldown_min: Number(buyback_cooldown_min),
    buyback_split_burn_bps: Number(buyback_split_burn_bps),
    buyback_split_lp_bps: Number(buyback_split_lp_bps)
  };
}

async function handleBuyback(env, cfg, now) {
  try {
    const bucketStr = await env.CONFIG.get("lp_bucket_usdc");
    const bucket = Number(bucketStr || "0");
    if (bucket < cfg.buyback_min_usdc) return;

    // Intent bauen (Bot führt Swap + Burn + LP-Add aus)
    const intent = {
      kind: "BUYBACK_TWAP_AND_LP",
      created: now,
      usdc: bucket,
      twap_slices: cfg.buyback_twap_slices,
      split_burn_bps: cfg.buyback_split_burn_bps,
      split_lp_bps: cfg.buyback_split_lp_bps
    };
    const key = `intent:buyback:${now}`;
    await env.OPS.put(key, JSON.stringify(intent));
    await env.CONFIG.put("lp_bucket_usdc", "0");
  } catch (e) {
    await env.OPS.put(`error:buyback:${now}`, String(e));
  }
}

async function handleMetrics(env, cfg, now) {
  try {
    // TODO: hier echte Onchain-Reads über /rpc (TVL, Holder, Unlocks)
    const metrics = { ts: now };
    await env.OPS.put("last_metrics_json", JSON.stringify(metrics));
  } catch (e) {
    await env.OPS.put(`error:metrics:${now}`, String(e));
  }
}

async function handleCreatorStreams(env, cfg, now) {
  try {
    // USDC-Stream
    const mUsd = Number(await env.CONFIG.get("creator_usdc_stream_monthly_usdc") || "0");
    const monthsUsd = Number(await env.CONFIG.get("creator_usdc_stream_months") || "0");
    const nextUsd = Number(await env.CONFIG.get("creator_usdc_stream_next_ts") || "0");
    if (mUsd > 0 && monthsUsd > 0 && now >= nextUsd) {
      const intent = { kind:"CREATOR_PAYOUT_USDC", created: now, amount_usdc: mUsd };
      await env.OPS.put(`intent:creator:usdc:${now}`, JSON.stringify(intent));
      // set next to +30d
      await env.CONFIG.put("creator_usdc_stream_next_ts", String(nextUsd + 30*24*3600*1000));
      await env.CONFIG.put("creator_usdc_stream_months", String(monthsUsd - 1));
    }
    // INPI-Stream
    const bps = Number(await env.CONFIG.get("creator_inpi_stream_bps_per_month") || "0");
    const monthsInpi = Number(await env.CONFIG.get("creator_inpi_stream_months") || "0");
    const nextInpi = Number(await env.CONFIG.get("creator_inpi_stream_next_ts") || "0");
    const supply = Number(await env.CONFIG.get("supply_total") || "0");
    if (bps > 0 && monthsInpi > 0 && now >= nextInpi && supply > 0) {
      const amountInpi = Math.floor(supply * (bps/10000));
      const intent = { kind:"CREATOR_PAYOUT_INPI", created: now, amount_inpi: amountInpi };
      await env.OPS.put(`intent:creator:inpi:${now}`, JSON.stringify(intent));
      await env.CONFIG.put("creator_inpi_stream_next_ts", String(nextInpi + 30*24*3600*1000));
      await env.CONFIG.put("creator_inpi_stream_months", String(monthsInpi - 1));
    }
  } catch(e) {
    await env.OPS.put(`error:creator:${now}`, String(e));
  }
}