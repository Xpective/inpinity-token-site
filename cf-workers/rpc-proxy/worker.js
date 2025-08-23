// Pfad: cf-workers/rpc-proxy/worker.js
// Zweck: JSON-RPC Proxy → nutzt (1) env.UPSTREAM, sonst (2) Ankr public, sonst (3) Solana official.
// Fix für 403: Fallbacks + Weiterprobieren bei 403/429/5xx.

export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("Only POST", { status: 405 });

    const body = await req.text();

    // Minimal-Whitelist (nach Bedarf erweitern)
    try {
      const j = JSON.parse(body);
      const method = j?.method || "";
      const allow = new Set([
        "getTokenAccountsByOwner",
        "getBalance",
        "getAccountInfo",
        "getProgramAccounts",
        "getLatestBlockhash",
        "getMinimumBalanceForRentExemption",
        "simulateTransaction",
        "getSlot",
        "getEpochInfo"
      ]);
      if (!allow.has(method)) {
        return json({ error: "method not allowed" }, 400);
      }
    } catch {
      // falls kein valides JSON: trotzdem weiterleiten (die meisten Clients senden valides JSON)
    }

    const upstreams = [
      env.UPSTREAM || "",                          // z.B. https://rpc.helius.xyz/?api-key=XXXX
      "https://rpc.ankr.com/solana",               // öffentlicher Fallback (ohne Key)
      "https://api.mainnet-beta.solana.com"        // offizieller RPC (kann CF-IPs drosseln)
    ].filter(Boolean);

    let lastErr, lastResp;
    for (const url of upstreams) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body
        });
        // bei 403/429/5xx direkt nächsten versuchen
        if (r.status === 403 || r.status === 429 || r.status >= 500) {
          lastResp = r;
          continue;
        }
        const headers = new Headers(r.headers);
        headers.set("access-control-allow-origin", "*");
        headers.set("content-type", "application/json");
        return new Response(r.body, { status: r.status, headers });
      } catch (e) {
        lastErr = e;
        continue;
      }
    }
    if (lastResp) {
      return json({ error: `upstreams failed with status ${lastResp.status}` }, 502);
    }
    return json({ error: lastErr?.message || "no upstream reachable" }, 502);
  }
};

function json(obj, status=200){
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type":"application/json", "access-control-allow-origin":"*" }
  });
}