import fs from "fs";

const OPS_API_BASE = process.env.OPS_API_BASE || "https://inpinity.online/cron";
const OPS_API_KEY  = process.env.OPS_API_KEY || "";
if (!OPS_API_KEY) throw new Error("OPS_API_KEY fehlt");

async function main() {
  // Endlosschleife mit Pause
  while (true) {
    const intent = await nextIntent();
    if (!intent) {
      await sleep(5000);
      continue;
    }
    const { key, intent: data } = intent;
    let result=null, error=null;
    try {
      switch (data.kind) {
        case "BUYBACK_TWAP_AND_LP":
          // TODO: hier Swap (Jupiter/Raydium) + Burn + addLiquidity + lock
          console.log("BUYBACK:", data);
          result = { txs: [], note: "stub ok" };
          break;
        case "CREATOR_PAYOUT_USDC":
          // TODO: Transfer USDC an Creator
          console.log("PAYOUT USDC:", data);
          result = { tx: null, note: "stub ok" };
          break;
        case "CREATOR_PAYOUT_INPI":
          // TODO: Transfer INPI an Creator
          console.log("PAYOUT INPI:", data);
          result = { tx: null, note: "stub ok" };
          break;
        default:
          throw new Error("unknown kind "+data.kind);
      }
    } catch(e) {
      error = String(e);
    }
    await completeIntent(key, result, error);
  }
}

async function nextIntent() {
  const r = await fetch(`${OPS_API_BASE}/ops/next`, {
    method: "POST",
    headers: { "authorization": `Bearer ${OPS_API_KEY}`, "content-type":"application/json" },
    body: JSON.stringify({ /* kind: "BUYBACK_TWAP_AND_LP"  // optional filtern */ })
  });
  const j = await r.json();
  if (j && j.key) return j;
  return null;
}
async function completeIntent(key, result, error) {
  await fetch(`${OPS_API_BASE}/ops/complete`, {
    method: "POST",
    headers: { "authorization": `Bearer ${OPS_API_KEY}`, "content-type":"application/json" },
    body: JSON.stringify({ key, result, error })
  });
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

main().catch(console.error);