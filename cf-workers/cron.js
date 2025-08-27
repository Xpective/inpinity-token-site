// Cron-Jobs + OPS-API für INPI
// - Reconcile Presale-Intents aus INPI_PRESALE nach OPS-Queue
// - Buyback/TWAP & Creator-Streams als Intents erzeugen
// - Mini-Status + Peek/Next/Complete für den Off-Chain Bot
//
// Sicherheitsmodell: Bearer OPS_API_KEY für schreibende OPS-Endpunkte

export default {
  async scheduled(event, env, ctx) {
    const now = Date.now();
    const cfg = await loadConfig(env);

    // alle 30 Minuten: Buyback/TWAP + Creator-Streams
    if (event.cron === "*/30 * * * *") {
      if (cfg.buyback_enabled) {
        ctx.waitUntil(handleBuyback(env, cfg, now));
      }
      ctx.waitUntil(handleCreatorStreams(env, cfg, now));
    }

    // alle 10 Minuten: Metriken (Stub)
    if (event.cron === "*/10 * * * *") {
      ctx.waitUntil(handleMetrics(env, cfg, now));
    }
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---- Status (public read) ----
    if (req.method === "GET" && p === "/cron/status") {
      const metrics = await env.OPS.get("last_metrics_json").then(v => v ? JSON.parse(v) : {});
      const intentCount = await countKeys(env.OPS, "intent:");
      const inflightCount = await countKeys(env.OPS, "inflight:");
      const doneCount = await countKeys(env.OPS, "done:");
      return json({
        ok: true,
        metrics,
        stats: { intentCount, inflightCount, doneCount, ts: Date.now() }
      });
    }

    // ---- Reconcile Presale → OPS (admin triggert) ----
    if (req.method === "POST" && p === "/cron/reconcile-presale") {
      if (!checkBearer(req, env)) return unauthorized();
      if (!env.PRESALE) return json({ ok:false, error:"PRESALE binding missing" }, 500);

      const body = await req.json().catch(()=> ({}));
      const limit = Number(body?.limit || 200);
      const list = await env.PRESALE.list({ prefix: "intent:", limit: Math.min(limit, 1000) });

      let moved = 0;
      for (const k of list.keys) {
        const key = k.name;
        const val = await env.PRESALE.get(key);
        if (!val) continue;
        const obj = JSON.parse(val);
        // markiere als reconciled (idempotent)
        const markKey = `${key}:reconciled`;
        const already = await env.PRESALE.get(markKey);
        if (already) continue;

        const outKey = `intent:PRESALE_ALLOCATION:${Date.now()}:${cryptoRandom()}`;
        await env.OPS.put(outKey, JSON.stringify(obj));
        await env.PRESALE.put(markKey, "1", { expirationTtl: 7 * 24 * 3600 }); // 7 Tage
        moved++;
      }
      return json({ ok:true, moved });
    }

    // ---- OPS: Peek (nur lesen) ----
    if (req.method === "GET" && p === "/cron/ops/peek") {
      if (!checkBearer(req, env)) return unauthorized();
      const kind = url.searchParams.get("kind") || "";
      const limit = Number(url.searchParams.get("limit") || "10");
      const list = await env.OPS.list({ prefix: "intent:", limit: Math.min(limit, 100) });
      const out = [];
      for (const k of list.keys) {
        const key = k.name;
        const val = await env.OPS.get(key);
        if (!val) continue;
        const obj = JSON.parse(val);
        if (kind && obj.kind !== kind) continue;
        out.push({ key, kind: obj.kind || null, created: obj.created || null });
      }
      return json({ ok:true, items: out });
    }

    // ---- OPS: Bot holt den nächsten Intent (claim → inflight) ----
    if (req.method === "POST" && p === "/cron/ops/next") {
      if (!checkBearer(req, env)) return unauthorized();
      const { kind } = await req.json().catch(()=> ({}));
      const list = await env.OPS.list({ prefix: "intent:", limit: 200 });
      for (const k of list.keys) {
        const key = k.name;
        const val = await env.OPS.get(key);
        if (!val) continue;
        const obj = JSON.parse(val);
        if (kind && obj.kind !== kind) continue;
        // move to inflight
        await env.OPS.delete(key);
        const infKey = `inflight:${Date.now()}:${cryptoRandom()}`;
        await env.OPS.put(infKey, JSON.stringify(obj));
        return json({ ok:true, key: infKey, intent: obj });
      }
      return json({ ok:true, key: null, intent: null });
    }

    // ---- OPS: Bot bestätigt Abschluss (inflight → done) ----
    if (req.method === "POST" && p === "/cron/ops/complete") {
      if (!checkBearer(req, env)) return unauthorized();
      const { key, result, error } = await req.json().catch(()=> ({}));
      if (!key || (!result && !error)) return json({ ok:false, error:"key/result|error fehlt" }, 400);
      const val = await env.OPS.get(key);
      if (!val) return json({ ok:false, error:"not_found" }, 404);
      const doneKey = `done:${key.replace(/^inflight:/,"")}`;
      await env.OPS.put(doneKey, JSON.stringify({ finished: Date.now(), result, error }));
      await env.OPS.delete(key);
      return json({ ok:true });
    }

    return new Response("Not found", { status: 404 });
  }
};

/* --------------------- Helpers --------------------- */
function unauthorized(){ return new Response("Unauthorized", { status: 401 }); }
function checkBearer(req, env){
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  return h.slice(7) === env.OPS_API_KEY;
}
function json(x, status=200){
  return new Response(JSON.stringify(x), {
    status,
    headers:{ "content-type":"application/json", "cache-control":"no-store" }
  });
}
function cryptoRandom(){ return Math.random().toString(36).slice(2); }

async function countKeys(ns, prefix){
  const list = await ns.list({ prefix, limit: 1000 });
  return (list?.keys?.length || 0);
}

/* --------------------- Config & Jobs --------------------- */
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

    const intent = {
      kind: "BUYBACK_TWAP_AND_LP",
      created: now,
      usdc: bucket,
      twap_slices: cfg.buyback_twap_slices,
      split_burn_bps: cfg.buyback_split_burn_bps,
      split_lp_bps: cfg.buyback_split_lp_bps
    };
    const key = `intent:buyback:${now}:${cryptoRandom()}`;
    await env.OPS.put(key, JSON.stringify(intent));
    await env.CONFIG.put("lp_bucket_usdc", "0");
  } catch (e) {
    await env.OPS.put(`error:buyback:${now}`, String(e));
  }
}

async function handleMetrics(env, cfg, now) {
  try {
    // TODO: echte Onchain Metriken (TVL/Halter/etc.) via /rpc
    const metrics = { ts: now };
    await env.OPS.put("last_metrics_json", JSON.stringify(metrics));
  } catch (e) {
    await env.OPS.put(`error:metrics:${now}`, String(e));
  }
}

async function handleCreatorStreams(env, cfg, now) {
  try {
    // USDC-Stream (monatlich)
    const mUsd = Number(await env.CONFIG.get("creator_usdc_stream_monthly_usdc") || "0");
    const monthsUsd = Number(await env.CONFIG.get("creator_usdc_stream_months") || "0");
    const nextUsd = Number(await env.CONFIG.get("creator_usdc_stream_next_ts") || "0");
    if (mUsd > 0 && monthsUsd > 0 && now >= nextUsd) {
      const intent = { kind:"CREATOR_PAYOUT_USDC", created: now, amount_usdc: mUsd };
      await env.OPS.put(`intent:creator:usdc:${now}:${cryptoRandom()}`, JSON.stringify(intent));
      await env.CONFIG.put("creator_usdc_stream_next_ts", String(nextUsd + 30*24*3600*1000)); // +30 Tage
      await env.CONFIG.put("creator_usdc_stream_months", String(monthsUsd - 1));
    }

    // INPI-Stream (bps vom Total Supply, monatlich)
    const bps = Number(await env.CONFIG.get("creator_inpi_stream_bps_per_month") || "0");
    const monthsInpi = Number(await env.CONFIG.get("creator_inpi_stream_months") || "0");
    const nextInpi = Number(await env.CONFIG.get("creator_inpi_stream_next_ts") || "0");
    const supply = Number(await env.CONFIG.get("supply_total") || "0");
    if (bps > 0 && monthsInpi > 0 && now >= nextInpi && supply > 0) {
      const amountInpi = Math.floor(supply * (bps/10000));
      const intent = { kind:"CREATOR_PAYOUT_INPI", created: now, amount_inpi: amountInpi };
      await env.OPS.put(`intent:creator:inpi:${now}:${cryptoRandom()}`, JSON.stringify(intent));
      await env.CONFIG.put("creator_inpi_stream_next_ts", String(nextInpi + 30*24*3600*1000)); // +30 Tage
      await env.CONFIG.put("creator_inpi_stream_months", String(monthsInpi - 1));
    }
  } catch(e) {
    await env.OPS.put(`error:creator:${now}`, String(e));
  }
}
