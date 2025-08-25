/* ===========================================
   Inpinity Token – Frontend (Phantom-only)
   Pfad: /public/token/app.js
   =========================================== */

/* ==================== KONFIG (Fallbacks) ==================== */
const CFG = {
  RPC: "https://inpinity.online/rpc",
  // Fallback – wird von /api/token/status überschrieben, wenn vorhanden:
  INPI_MINT: "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
  // Du hast diese USDC-Adresse verifiziert:
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  API_BASE: "https://inpinity.online/api/token",

  // Fallbacks (nur wenn API nichts liefert)
  P0_USDC: 0.00031415,
  PRESALE_DISCOUNT: 0.10,
  DEPOSIT_USDC_ATA_FALLBACK: "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",
  TGE_TS_FALLBACK: Math.floor(Date.now()/1000) + 60*60*24*90
};

/* ================ SOLANA / PHANTOM ================ */
const { Connection } = solanaWeb3;

const $ = (sel) => document.querySelector(sel);
const short = (a) => (a?.slice(0, 4) + "…" + a?.slice(-4));
const fmt = (n, d=2) => (n==null || Number.isNaN(n)) ? "–" : Number(n).toLocaleString("de-DE",{ maximumFractionDigits:d });
const solscan = (addr) => `https://solscan.io/account/${addr}`;
const nowSec = () => Math.floor(Date.now()/1000);

// UI-Refs
const btnConnect = $("#btnConnect");
const walletAddr = $("#walletAddr");
const usdcBal = $("#usdcBal");
const inpiBal = $("#inpiBal");
const presaleState = $("#presaleState");
const tgeTime = $("#tgeTime");
const p0 = $("#p0");
const inpAmount = $("#inpAmount");
const expectedInpi = $("#expectedInpi");
const btnPresaleIntent = $("#btnPresaleIntent");
const btnHowTo = $("#btnHowTo");
const intentMsg = $("#intentMsg");

let connection = null;
let provider = null; // Phantom
let pubkey = null;
let POLL = null;

// Laufender State (aus /api/token/status)
const STATE = {
  inpi_mint: CFG.INPI_MINT,
  price_presale: null,
  price_public: null,
  presale_state: "pre",
  tge_ts: CFG.TGE_TS_FALLBACK,
  deposit_ata: CFG.DEPOSIT_USDC_ATA_FALLBACK
};

/* ---------- Preis/Erwartung ---------- */
function currentPriceUSDC() {
  if (STATE.presale_state === "pre" && STATE.price_presale) return STATE.price_presale;
  if (STATE.presale_state === "public" && STATE.price_public) return STATE.price_public;
  return CFG.P0_USDC * (1 - CFG.PRESALE_DISCOUNT);
}
function calcExpectedInpi(usdc) {
  if (!usdc || usdc <= 0) return "–";
  const price = currentPriceUSDC();   // USDC pro 1 INPI
  const tokens = usdc / price;
  return fmt(tokens, 0) + " INPI";
}

/* ==================== INIT ==================== */
async function init() {
  connection = new Connection(CFG.RPC, "confirmed");
  p0.textContent = `${CFG.P0_USDC.toFixed(6)} USDC (Fallback)`;

  // 1) Status laden (INPI_MINT, Preise, TGE, Deposit-ATA aus Admin/KV)
  await refreshStatus();

  // 2) Phantom?
  if (window.solana?.isPhantom) {
    provider = window.solana;
    try {
      await provider.connect({ onlyIfTrusted: true })
        .then(({ publicKey }) => onConnected(publicKey));
    } catch {}
    btnConnect.disabled = false;
  } else {
    btnConnect.textContent = "Phantom installieren";
    btnConnect.onclick = () => window.open("https://phantom.app", "_blank");
  }

  // 3) Countdown
  tickTGE();
  setInterval(tickTGE, 1000);
}

/* ---------- Status laden ---------- */
async function refreshStatus(){
  try {
    const r = await fetch(`${CFG.API_BASE}/status`, { headers: { "accept":"application/json" }});
    const j = await r.json().catch(()=> ({}));

    // Sicheres Lesen + Konvertierung (tge_ts kann ms oder sec sein)
    const tge_raw = j?.tge_ts;
    let tge_s = Number(tge_raw || 0);
    if (tge_s > 1e12) tge_s = Math.floor(tge_s/1000);

    STATE.inpi_mint     = j?.inpi_mint || j?.INPI_MINT || CFG.INPI_MINT;
    STATE.presale_state = j?.presale_state || "pre";
    STATE.tge_ts        = tge_s || CFG.TGE_TS_FALLBACK;
    STATE.price_presale = (j?.presale_price_usdc != null) ? Number(j.presale_price_usdc) : null;
    STATE.price_public  = (j?.public_price_usdc  != null) ? Number(j.public_price_usdc)  : null;
    STATE.deposit_ata   = j?.deposit_usdc_ata || CFG.DEPOSIT_USDC_ATA_FALLBACK;

    presaleState.textContent = STATE.presale_state;
    const liveOrFallback = Number(STATE.price_presale ?? (CFG.P0_USDC*(1-CFG.PRESALE_DISCOUNT)));
    p0.textContent = `${liveOrFallback.toFixed(6)} USDC`;

    // Deposit UI
    const dep = $("#depositAddr");
    const depA = $("#depositSolscan");
    if (dep) {
      dep.textContent = STATE.deposit_ata || "—";
      if (depA && STATE.deposit_ata) {
        depA.href = solscan(STATE.deposit_ata);
        depA.style.display = "inline";
      } else if (depA) depA.style.display = "none";
    }
  } catch (e) {
    console.warn("Status-API offline, nutze Fallbacks.", e);
    presaleState.textContent = "API offline";
  }
}

function tickTGE(){
  if (!STATE.tge_ts) { tgeTime.textContent = "tbd"; return; }
  const secs = Math.max(0, STATE.tge_ts - nowSec());
  const d = Math.floor(secs/86400), h = Math.floor((secs%86400)/3600), m = Math.floor((secs%3600)/60), s = secs%60;
  tgeTime.textContent = `${d}d ${h}h ${m}m ${s}s`;
}

/* ---------- Wallet Connect ---------- */
btnConnect.addEventListener("click", async () => {
  if (!window.solana?.isPhantom) return;
  try {
    const { publicKey } = await window.solana.connect();
    onConnected(publicKey);
  } catch (e) {
    console.error(e);
    alert("Wallet-Verbindung abgebrochen.");
  }
});

function onConnected(publicKey){
  pubkey = publicKey;
  walletAddr.textContent = publicKey.toBase58();
  provider?.on?.("accountChanged", (pk) => { if (!pk) { onDisconnected(); return; } onConnected(pk); });
  provider?.on?.("disconnect", onDisconnected);

  refreshBalances();
  clearInterval(POLL);
  POLL = setInterval(refreshBalances, 30000);
}
function onDisconnected(){
  pubkey = null;
  walletAddr.textContent = "—";
  usdcBal.textContent = "—";
  inpiBal.textContent = "—";
  clearInterval(POLL);
}

/* ---------- UI ---------- */
inpAmount.addEventListener("input", () => {
  const usdc = Number(inpAmount.value || "0");
  expectedInpi.textContent = calcExpectedInpi(usdc);
});

btnHowTo.addEventListener("click", () => {
  alert(
`Kurzanleitung:
1) Phantom verbinden
2) Intent senden (wir prüfen Cap & registrieren dich)
3) USDC an die angezeigte Presale-Adresse senden
4) Nach TGE claimst du deine INPI`
  );
});

/* ---------- Presale Intent ---------- */
let inFlight = false;
btnPresaleIntent.addEventListener("click", async () => {
  if (inFlight) return;
  if (!pubkey) return alert("Bitte zuerst mit Phantom verbinden.");
  const usdc = Number(inpAmount.value || "0");
  if (!usdc || usdc <= 0) return alert("Bitte gültigen USDC-Betrag eingeben.");

  inFlight = true;
  intentMsg.textContent = "Prüfe Caps & registriere Intent …";
  try {
    // optionaler Sign-In via Nachricht (falls Phantom signMessage unterstützt)
    let sig_b58 = null, msg_str = null;
    if (provider.signMessage) {
      msg_str = `INPI Presale Intent\nwallet=${pubkey.toBase58()}\namount_usdc=${usdc}\nts=${Date.now()}`;
      const enc = new TextEncoder().encode(msg_str);
      const { signature } = await provider.signMessage(enc, "utf8");
      sig_b58 = bs58Encode(signature);
    }

    const r = await fetch(`${CFG.API_BASE}/presale/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: pubkey.toBase58(), amount_usdc: usdc, sig_b58, msg_str })
    });
    const text = await r.text();

    intentMsg.textContent = "";
    const p = document.createElement("p"); p.textContent = text; intentMsg.appendChild(p);

    if (STATE.deposit_ata) {
      const small = document.createElement("small");
      small.innerText = `Deposit-Adresse (USDC): ${STATE.deposit_ata} `;
      const a = document.createElement("a");
      a.href = solscan(STATE.deposit_ata); a.target="_blank"; a.rel="noopener";
      a.textContent = `(Solscan)`;
      small.appendChild(a);
      intentMsg.appendChild(small);
    }

    // Status neu laden (falls Price/State sich geändert haben)
    refreshStatus();
  } catch (e) {
    console.error(e);
    intentMsg.textContent = "API nicht erreichbar.";
  } finally {
    inFlight = false;
  }
});

/* ---------- SPL Balances ---------- */
async function getSplBalance(mint, owner) {
  // JSON-RPC via Proxy
  const out = await fetch(CFG.RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [owner.toBase58(), { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]
    })
  }).then(r => r.json()).catch(()=>null);

  const arr = out?.result?.value || [];
  let raw = 0n, decimals = 0;
  for (const it of arr) {
    const info = it?.account?.data?.parsed?.info;
    if (!info) continue;
    const uiAmt = info?.tokenAmount;
    decimals = Number(uiAmt?.decimals || 0);
    raw += BigInt(uiAmt?.amount || "0");
  }
  const den = BigInt(10) ** BigInt(decimals || 0);
  return Number(raw) / Number(den || 1n);
}

async function refreshBalances() {
  if (!pubkey) return;
  try {
    const [u, i] = await Promise.all([
      getSplBalance(CFG.USDC_MINT, pubkey),
      getSplBalance(STATE.inpi_mint || CFG.INPI_MINT, pubkey),
    ]);
    usdcBal.textContent = fmt(u, 2) + " USDC";
    inpiBal.textContent = fmt(i, 2) + " INPI";
  } catch (e) {
    console.error(e);
    usdcBal.textContent = "—";
    inpiBal.textContent = "—";
  }
}

/* ---------- bs58 Helper ---------- */
function bs58Encode(bytes){
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const BASE = BigInt(58);
  let x = 0n; for (const b of bytes) x = (x << 8n) + BigInt(b);
  let out = ""; while (x > 0n) { const mod = x % BASE; out = alphabet[Number(mod)] + out; x = x / BASE; }
  let zeros = 0; for (const b of bytes) { if (b === 0) zeros++; else break; }
  return "1".repeat(zeros) + out;
}

window.addEventListener("load", init);