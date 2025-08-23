export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace("/api/token", "");

    try {
      if (req.method === "GET" && path === "/status") {
        const tge = (await env.CONFIG.get("tge_ts")) || "";
        const presale = (await env.CONFIG.get("presale_state")) || "pre";
        const tge_iso = tge ? new Date(Number(tge) * 1000).toISOString() : null;
        return json({ ok: true, presale, tge_ts: tge, tge_iso });
      }

      if (req.method === "POST" && path === "/presale/intent") {
        const body = await req.json().catch(() => ({}));
        const { wallet, amount_usdc } = body;
        if (!wallet || !amount_usdc) return bad("wallet/amount_usdc fehlt");

        const cap = Number((await env.CONFIG.get("cap_per_wallet_usdc")) || "1000");
        if (Number(amount_usdc) > cap) return bad(`Per-Wallet-Cap ${cap} USDC`);

        const deposit_address = (await env.CONFIG.get("presale_deposit_usdc")) || "<DEINE_USDC_ADRESSE>";
        const key = `intent:${wallet}:${Date.now()}`;
        await env.PRESALE.put(key, JSON.stringify({ wallet, amount_usdc, ts: Date.now() }));

        return json({ ok: true, deposit_address });
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ ok:false, error: e.message }, 500);
    }
  }
}
function json(obj, status=200){ return new Response(JSON.stringify(obj),{status,headers:{"content-type":"application/json","cache-control":"no-store"}}); }
function bad(msg){ return json({ ok:false, error: msg }, 400); }