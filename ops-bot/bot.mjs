// INPI OPS Bot (interactive key prompt)
// - Fragt beim Start nach deinem Private Key (base58/hex), maskiert die Eingabe.
// - Holt Intents vom /cron Worker und führt sie on-chain aus:
//   * BUYBACK_TWAP_AND_LP: USDC in INPI swappen (Jupiter), 25% burn, Rest + USDC in LP-Buffer
//   * CREATOR_PAYOUT_USDC / CREATOR_PAYOUT_INPI: Transfers (ATAs auto)
// Run: node --env-file=.env bot.mjs

import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount,
  transfer, burn, createAssociatedTokenAccountInstruction
} from "@solana/spl-token";
import bs58 from "bs58";
import readline from "readline";

// ---------- ENV (ohne Private Key!) ----------
const OPS_API_BASE = mustEnv("OPS_API_BASE");
const OPS_API_KEY  = mustEnv("OPS_API_KEY");
const RPC_URL      = mustEnv("RPC_URL");

const USDC_MINT = new PublicKey(mustEnv("USDC_MINT"));
const INPI_MINT = new PublicKey(mustEnv("INPI_MINT"));

const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || "50");

const CREATOR_USDC_DEST = process.env.CREATOR_USDC_DEST || "";
const CREATOR_INPI_DEST = process.env.CREATOR_INPI_DEST || "";

const LP_BUFFER_USDC = maybePk(process.env.LP_BUFFER_USDC);
const LP_BUFFER_INPI = maybePk(process.env.LP_BUFFER_INPI);

// ---------- Secure key prompt ----------
const payer = await promptKeypair();
const connection = new Connection(RPC_URL, "confirmed");

(async function main() {
  console.log("INPI OPS Bot start. Payer:", payer.publicKey.toBase58());
  while (true) {
    try {
      const picked = await nextIntent();
      if (!picked) { await sleep(4000); continue; }
      const { key, intent } = picked;
      let result=null, error=null;

      try {
        switch (intent.kind) {
          case "BUYBACK_TWAP_AND_LP":
            result = await handleBuyback(intent);
            break;
          case "CREATOR_PAYOUT_USDC":
            result = await handleCreatorPayout(USDC_MINT, intent.amount_usdc, CREATOR_USDC_DEST);
            break;
          case "CREATOR_PAYOUT_INPI":
            result = await handleCreatorPayout(INPI_MINT, intent.amount_inpi, CREATOR_INPI_DEST);
            break;
          default:
            throw new Error("Unknown intent kind: "+intent.kind);
        }
      } catch (e) {
        error = String(e.stack || e.message || e);
        console.error("Intent failed:", intent.kind, error);
      }
      await completeIntent(key, result, error);
    } catch (outer) {
      console.error("Loop error:", outer);
      await sleep(3000);
    }
  }
})();

// ---------- Intents API ----------
async function nextIntent() {
  const r = await fetch(`${OPS_API_BASE}/ops/next`, {
    method:"POST",
    headers: { authorization: `Bearer ${OPS_API_KEY}`, "content-type":"application/json" },
    body: JSON.stringify({})
  });
  const j = await r.json();
  if (j && j.key) return j;
  return null;
}
async function completeIntent(key, result, error) {
  await fetch(`${OPS_API_BASE}/ops/complete`, {
    method:"POST",
    headers: { authorization: `Bearer ${OPS_API_KEY}`, "content-type":"application/json" },
    body: JSON.stringify({ key, result, error })
  });
}

// ---------- BUYBACK / PAYOUT Handlers ----------
async function handleBuyback(intent) {
  const { usdc, twap_slices=6, split_burn_bps=2500, split_lp_bps=7500 } = intent;
  if (!usdc || usdc <= 0) throw new Error("usdc<=0");

  const usdc_lp_total   = (usdc * split_lp_bps) / 10000;
  const usdc_buyback    = usdc - usdc_lp_total;
  const usdc_lp_swap    = usdc_lp_total / 2;
  const usdc_lp_hold    = usdc_lp_total - usdc_lp_swap;

  const usdcAta = await getOrCreateATA(USDC_MINT, payer.publicKey);
  const inpiAta = await getOrCreateATA(INPI_MINT, payer.publicKey);

  const res = { swaps: [], burns: [], buffers: {} };

  // LP-Swap (USDC->INPI)
  if (usdc_lp_swap > 0) {
    const per = Math.max(Math.floor(usdc_lp_swap / twap_slices), 1);
    let done = 0, gotInpi = 0n;
    while (done < usdc_lp_swap) {
      const amt = Math.min(per, usdc_lp_swap - done);
      const out = await jupSwap({
        inputMint: USDC_MINT, outputMint: INPI_MINT,
        amount: uiToRaw(amt, 6), slippageBps: SLIPPAGE_BPS
      });
      gotInpi += BigInt(out.uiOutAmountRaw);
      res.swaps.push({ type:"LP_SWAP", in_usdc:amt, out_inpi_raw: out.uiOutAmountRaw, sig: out.signature });
      done += amt;
      await sleep(1200);
    }
    res.buffers.inpi_lp_added = gotInpi.toString();
  }

  // Buyback-Swap (USDC->INPI)
  let buybackInpi = 0n;
  if (usdc_buyback > 0) {
    const per = Math.max(Math.floor(usdc_buyback / twap_slices), 1);
    let done = 0;
    while (done < usdc_buyback) {
      const amt = Math.min(per, usdc_buyback - done);
      const out = await jupSwap({
        inputMint: USDC_MINT, outputMint: INPI_MINT,
        amount: uiToRaw(amt, 6), slippageBps: SLIPPAGE_BPS
      });
      buybackInpi += BigInt(out.uiOutAmountRaw);
      res.swaps.push({ type:"BUYBACK_SWAP", in_usdc:amt, out_inpi_raw: out.uiOutAmountRaw, sig: out.signature });
      done += amt;
      await sleep(1200);
    }
  }

  // Burn 25% vom Buyback-INPI
  if (buybackInpi > 0n && split_burn_bps > 0) {
    const burnRaw = (buybackInpi * BigInt(split_burn_bps)) / 10000n;
    if (burnRaw > 0n) {
      await burnToken(INPI_MINT, inpiAta, burnRaw);
      res.burns.push({ inpi_raw: burnRaw.toString() });
      buybackInpi -= burnRaw;
    }
  }

  res.buffers.usdc_lp_hold_ui = usdc_lp_hold;
  res.buffers.inpi_buyback_left_raw = buybackInpi.toString();
  return res;
}

async function handleCreatorPayout(mint, uiAmount, destMaybeOwner) {
  if (!uiAmount || uiAmount <= 0) throw new Error("uiAmount<=0");
  const decimals = mint.equals(USDC_MINT) ? 6 : 9;
  const raw = uiToRaw(uiAmount, decimals);

  const srcAta = await getOrCreateATA(mint, payer.publicKey);
  const dest = await resolveDestATA(mint, destMaybeOwner);
  const sig = await transfer(connection, payer, srcAta, dest, payer, Number(raw));
  await connection.confirmTransaction(sig, "confirmed");
  return { tx: sig, amount_raw: raw.toString() };
}

// ---------- Jupiter Swap ----------
async function jupSwap({ inputMint, outputMint, amount, slippageBps }) {
  const params = new URLSearchParams({
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    amount: String(amount),
    slippageBps: String(slippageBps),
    onlyDirectRoutes: "false",
    asLegacyTransaction: "false"
  });
  const quote = await (await fetch(`https://quote-api.jup.ag/v6/quote?${params}`)).json();
  if (!quote || !quote.outAmount) throw new Error("No Jupiter quote");

  const swapRes = await (await fetch("https://quote-api.jup.ag/v6/swap", {
    method:"POST", headers:{ "content-type":"application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: payer.publicKey.toBase58(), wrapAndUnwrapSol: true })
  })).json();

  const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, "base64"));
  tx.sign([payer]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight:false, maxRetries:3 });
  await connection.confirmTransaction(sig, "confirmed");
  return { signature: sig, uiOutAmountRaw: quote.outAmount };
}

// ---------- Token helpers ----------
async function getOrCreateATA(mint, owner) {
  const ata = await getAssociatedTokenAddress(mint, owner, false);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    const ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint);
    const tx = new Transaction().add(ix);
    const sig = await connection.sendTransaction(tx, [payer], { skipPreflight:false });
    await connection.confirmTransaction(sig, "confirmed");
  }
  return ata;
}
async function resolveDestATA(mint, destMaybeOwner) {
  const pk = new PublicKey(destMaybeOwner);
  const info = await connection.getAccountInfo(pk);
  if (info && info.data?.length === 165) return pk;           // ist bereits ATA
  const owner = pk;                                           // sonst Owner -> ATA erzeugen
  return await getOrCreateATA(mint, owner);
}
async function burnToken(mint, fromAta, rawAmount) {
  const sig = await burn(connection, payer, fromAta, mint, payer, Number(rawAmount));
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ---------- Utils ----------
function mustEnv(k){ const v=process.env[k]; if(!v) throw new Error(`Missing env ${k}`); return v; }
function maybePk(v){ return v ? new PublicKey(v) : null; }
function uiToRaw(ui, decimals){
  const s = ui.toString();
  const [a,b=""] = s.split(".");
  const frac = (b+"0".repeat(decimals)).slice(0,decimals);
  return BigInt(a + frac);
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// --- secure prompt (masked) ---
async function promptKeypair(){
  const secret = await promptHidden("Paste Private Key (base58 or hex). DO NOT paste seed phrase: ");
  const kp = parseKeypair(secret.trim());
  console.log("\nLoaded key. Public:", kp.publicKey.toBase58());
  const ok = (await promptText("Continue with this key? (y/N): ")).trim().toLowerCase()==="y";
  if (!ok) throw new Error("Aborted by user");
  return kp;
}
function parseKeypair(secret){
  // hex?
  if (/^[0-9A-Fa-f]+$/.test(secret) && secret.length>=64) {
    const bytes = Uint8Array.from(secret.match(/.{1,2}/g).map(h=>parseInt(h,16)));
    return Keypair.fromSecretKey(bytes);
  }
  // assume base58
  const bytes = bs58.decode(secret);
  return Keypair.fromSecretKey(bytes);
}
function promptHidden(question){
  return new Promise((resolve)=>{
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = function(){ /* suppress echo */ };
    rl.question(question, (answer)=>{ rl.close(); resolve(answer); });
  });
}
function promptText(question){
  return new Promise((resolve)=>{
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer)=>{ rl.close(); resolve(answer); });
  });
}