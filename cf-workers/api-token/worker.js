export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace("/api/token", "");

    if (path === "/status") {
      const [state, tge, price, cap, deposit] = await Promise.all([
        env.CONFIG.get("presale_state"),
        env.CONFIG.get("tge_ts"),
        env.CONFIG.get("presale_price_usdc"),
        env.CONFIG.get("cap_per_wallet_usdc"),
        env.CONFIG.get("presale_deposit_usdc"),
      ]);
      return json({
        ok:true,
        presale_state: state || "pre",
        tge_ts: tge ? Number(tge) : null,
        tge_iso: tge ? new Date(Number(tge)).toISOString() : null,
        presale_price_usdc: price ? Number(price) : null,
        cap_per_wallet_usdc: cap ? Number(cap) : null,
        deposit_usdc_ata: deposit || null
      });
    }

    if (path === "/presale/intent" && req.method === "POST") {
      const body = await req.json().catch(()=> ({}));
      if (!body.wallet || !body.amount_usdc) return json({ok:false,error:"wallet/amount_usdc fehlt"},400);
      const key = `intent:${Date.now()}:${body.wallet}`;
      await env.PRESALE.put(key, JSON.stringify({
        ...body, ts: Date.now(), ip: req.headers.get("cf-connecting-ip") || null
      }));
      return json({ok:true, key});
    }

    return json({ok:false, error:"not_found"}, 404);
  }
}
function json(x, status=200){ return new Response(JSON.stringify(x), {status, headers:{'content-type':'application/json','cache-control':'no-store'}}); }