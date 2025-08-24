/* ===========================================
   Inpinity Token – Frontend (Phantom-only)
   Pfad: /public/token/app.js
   =========================================== */

/* ==================== KONFIG ==================== */
const CFG = {
  RPC: "https://inpinity.online/rpc",
  INPI_MINT: "<DEIN_INPI_MINT>",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  API_BASE: "https://inpinity.online/api/token",

  // Fallbacks, falls API mal nichts liefert:
  P0_USDC: 0.00031415,         // Basispreis
  PRESALE_DISCOUNT: 0.10,      // 10% Discount fürs Gate-Fenster (Fallback)
};

/* ================ SOLANA / PHANTOM ================ */
const { Connection, PublicKey } = solanaWeb3; // Phantom injiziert solanaWeb3

// Helfer
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isB58 = (s) => /^[1-9A-HJ-NP-Za-km-z]+$/.test(s) && s.length >= 32 && s.length <= 44;
const short = (a) => (a?.slice(0, 4) + "…" + a?.slice(-4));

function fmt(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return "–";
  return Number(n).toLocaleString("de-DE", { maximumFractionDigits: d });
}
function solscan(addr){ return `https://solscan.io/account/${addr}`; }

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

// State
let connection = null;
let provider = null; // Phantom
let pubkey = null;
let POLL = null;

const STATE = {
  price_presale: null,   // aus /status.presale_price_usdc
  price_public: null,    // aus /status.public_price_usdc (optional)
  presale_state: "pre",  // "pre" | "public" | "closed"
  tge_ts: null,          // unix seconds
  deposit_ata: null      // USDC-ATA (Vault/Deposit)
};

function nowSec(){ return Math.floor(Date.now()/1000); }

/* ---------- Preis/Erwartung dynamisch aus Status ---------- */
function currentPriceUSDC() {
  if (STATE.presale_state === "pre" && STATE.price_presale) return STATE.price_presale;
  if (STATE.presale_state === "public" && STATE.price_public) return STATE.price_public;
  // Fallback: Presale-Fallback mit Discount
  return CFG.P0_USDC * (1 - CFG.PRESALE_DISCOUNT);
}
function calcExpectedInpi(usdc) {
  if (!usdc || usdc <= 0) return "–";
  const price = currentPriceUSDC();               // USDC / 1 INPI
  const tokens = usdc / price;
  return fmt(tokens, 0) + " INPI";
}

/* ==================== INIT ==================== */
async function init() {
  connection = new Connection(CFG.RPC, "confirmed");
  p0.textContent = `${CFG.P0_USDC.toFixed(6)} USDC (Fallback)`;

  // 1) Status ziehen
  await refreshStatus();

  // 2) Phantom vorhanden?
  if (window.solana?.isPhantom) {
    provider = window.solana;
    // Auto-connect wenn vertraut
    try { await provider.connect({ onlyIfTrusted: true }).then(({ publicKey }) => onConnected(publicKey)); } catch {}
    btnConnect.disabled = false;
  } else {
    btnConnect.textContent = "Phantom installieren";
    btnConnect.onclick = () => window.open("https://phantom.app", "_blank");
  }

  // 3) Countdown zu TGE
  tickTGE();
  setInterval(tickTGE, 1000);
}

// Status von API holen und UI aktualisieren
async function refreshStatus(){
  try {
    const r = await fetch(`${CFG.API_BASE}/status`, { headers: { "accept":"application/json" }});
    const j = await r.json().catch(()=> ({}));
    STATE.presale_state  = j?.presale_state || "pre";
    STATE.tge_ts         = j?.tge_ts || null;
    STATE.price_presale  = j?.presale_price_usdc ?? null;
    STATE.price_public   = j?.public_price_usdc ?? null;
    STATE.deposit_ata    = j?.deposit_usdc_ata || null;

    presaleState.textContent = STATE.presale_state;
    if (STATE.price_presale) p0.textContent = `${Number(STATE.price_presale).toFixed(6)} USDC (live)`;
  } catch (e) {
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
  // Events
  provider?.on?.("accountChanged", (pk) => {
    if (!pk) { onDisconnected(); return; }
    onConnected(pk);
  });
  provider?.on?.("disconnect", onDisconnected);

  // Balances & Polling
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

/* ---------- UI Interaktionen ---------- */
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

/* ---------- Presale Intent (mit Message-Signatur) ---------- */
let inFlight = false;
btnPresaleIntent.addEventListener("click", async () => {
  if (inFlight) return;
  if (!pubkey) return alert("Bitte zuerst mit Phantom verbinden.");
  const usdc = Number(inpAmount.value || "0");
  if (!usdc || usdc <= 0) return alert("Bitte gültigen USDC-Betrag eingeben.");

  inFlight = true;
  intentMsg.textContent = "Prüfe Caps & registriere Intent …";
  try {
    // Optional: Intent signieren = „ich bin Besitzer dieser Wallet“
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
      body: JSON.stringify({
        wallet: pubkey.toBase58(),
        amount_usdc: usdc,
        sig_b58, msg_str
      })
    });
    const text = await r.text();
    // sicher rendern – kein innerHTML mit untrusted Daten:
    intentMsg.textContent = "";
    const p = document.createElement("p"); p.textContent = text; intentMsg.appendChild(p);

    // Falls Deposit-ATA aus Status vorhanden, biete Link
    if (STATE.deposit_ata) {
      const small = document.createElement("small");
      small.innerText = `Deposit-Adresse (USDC): ${STATE.deposit_ata} `;
      const a = document.createElement("a");
      a.href = solscan(STATE.deposit_ata); a.target="_blank"; a.rel="noopener";
      a.textContent = `(Solscan)`;
      small.appendChild(a);
      intentMsg.appendChild(small);
    }

    // nach Intent Status neu laden (falls Price/State sich geändert hat)
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
  // via RPC-Proxy → getTokenAccountsByOwner
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
      getSplBalance(CFG.INPI_MINT, pubkey),
    ]);
    usdcBal.textContent = fmt(u, 2) + " USDC";
    inpiBal.textContent = fmt(i, 2) + " INPI";
  } catch (e) {
    console.error(e);
    usdcBal.textContent = "—";
    inpiBal.textContent = "—";
  }
}

/* ---------- Utilities ---------- */
function bs58Encode(bytes){ // kleine Helper-Implementierung ohne externes Bundle
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const BASE = BigInt(58);
  let x = 0n; for (const b of bytes) x = (x << 8n) + BigInt(b);
  let out = ""; while (x > 0n) { const mod = x % BASE; out = alphabet[Number(mod)] + out; x = x / BASE; }
  // führende Nullen:
  let zeros = 0; for (const b of bytes) { if (b === 0) zeros++; else break; }
  return "1".repeat(zeros) + out;
}

window.addEventListener("load", init);