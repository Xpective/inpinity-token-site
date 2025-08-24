// Pfad: onchain/create-mint.mjs
// Erstellt einen SPL-Mint (9 Decimals), legt dein ATA an und mintet INITIAL_MINT.
// Liest Secret entweder aus onchain/keypair.json (Solana-CLI Format) ODER env SECRET_KEY (hex/base58).
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import fs from "fs";

const RPC = process.env.RPC_URL || "https://inpinity.online/rpc";
const OWNER = process.env.OWNER || "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp"; // deine Wallet
const DECIMALS = 9n;
// Beispiel: anfänglich nur 1,000 INPI prägen
const INITIAL_MINT = 1000n * (10n ** DECIMALS);

function loadKeypair() {
  // 1) keypair.json (CLI-Format)
  const p = new URL("./keypair.json", "file://"+process.cwd()+"/onchain/").pathname;
  if (fs.existsSync(p)) {
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    const secret = Uint8Array.from(arr);
    return Keypair.fromSecretKey(secret);
  }
  // 2) env SECRET_KEY (hex oder base58)
  const sk = process.env.SECRET_KEY;
  if (!sk) throw new Error("Kein Secret gefunden. Leg onchain/keypair.json an ODER setze env SECRET_KEY.");
  const bs58 = await import("bs58");
  let secret;
  if (/^[0-9a-fA-F]+$/.test(sk) && sk.length >= 64) {
    // hex → bytes
    secret = Uint8Array.from(sk.match(/.{1,2}/g).map((b)=>parseInt(b,16)));
  } else {
    // base58
    secret = bs58.default.decode(sk);
  }
  return Keypair.fromSecretKey(secret);
}

(async () => {
  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  console.log("RPC:", RPC);
  console.log("Owner:", OWNER);
  console.log("Payer pubkey:", payer.publicKey.toBase58());

  // 1) Mint anlegen (Mint-Authority = payer, Freeze-Authority = payer)
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,     // mintAuthority
    payer.publicKey,     // freezeAuthority
    Number(DECIMALS)     // decimals
  );
  console.log("INPI Mint:", mint.toBase58());

  // 2) Owner-ATA anlegen
  const ownerPk = new PublicKey(OWNER);
  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, ownerPk);
  console.log("Owner ATA:", ata.address.toBase58());

  // 3) Erste Prägung (optional klein starten)
  if (INITIAL_MINT > 0n) {
    await mintTo(connection, payer, mint, ata.address, payer, Number(INITIAL_MINT));
    console.log("Minted (raw):", INITIAL_MINT.toString());
  }

  // 4) Mint-Adresse lokal ablegen (nicht ins Repo pushen)
  fs.writeFileSync("./onchain/mint.txt", mint.toBase58());
  console.log("Mint-Adresse gespeichert in onchain/mint.txt");
})();