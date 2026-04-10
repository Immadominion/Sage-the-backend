/**
 * Decode the on-chain SessionKey PDA data with the CORRECT layout
 * from seal/programs/seal-wallet/src/state/session_key.rs
 */
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = "https://api.devnet.solana.com"; // Or your preferred RPC endpoint
const SESSION_PDA = "FPr52DLrgCTR85SaNgHESndyYKaxf9VbsNa5VtorzdEy";

const conn = new Connection(RPC, "confirmed");
const info = await conn.getAccountInfo(new PublicKey(SESSION_PDA));
if (!info) {
    console.log("Session PDA NOT FOUND on-chain");
    process.exit(1);
}

const d = info.data;
console.log("Account size:", d.length, "bytes");
console.log("Discriminator:", Buffer.from(d.subarray(0, 8)).toString("ascii"));

// Correct layout from session_key.rs:
//   discriminator: [u8; 8]
//   wallet: [u8; 32]
//   agent: [u8; 32]
//   session_pubkey: [u8; 32]
//   bump: u8
//   created_at: i64
//   expires_at: i64
//   max_amount: u64
//   amount_spent: u64
//   max_per_tx: u64
//   is_revoked: bool (1 byte)
//   nonce: u64

let off = 8;
const wallet = new PublicKey(d.subarray(off, off + 32));
off += 32;
const agent = new PublicKey(d.subarray(off, off + 32));
off += 32;
const sessPub = new PublicKey(d.subarray(off, off + 32));
off += 32;
const bump = d[off];
off += 1;
const created_at = d.readBigInt64LE(off);
off += 8;
const expires_at = d.readBigInt64LE(off);
off += 8;
const max_amount = d.readBigUInt64LE(off);
off += 8;
const amount_spent = d.readBigUInt64LE(off);
off += 8;
const max_per_tx = d.readBigUInt64LE(off);
off += 8;
const is_revoked = d[off] !== 0;
off += 1;
const nonce = d.readBigUInt64LE(off);
off += 8;

const SOL = (l: bigint) => (Number(l) / 1e9).toFixed(6) + " SOL";
const TS = (t: bigint) => new Date(Number(t) * 1000).toISOString();

console.log("\n=== SESSION KEY ON-CHAIN DATA ===");
console.log("wallet     :", wallet.toBase58());
console.log("agent      :", agent.toBase58());
console.log("session_pub:", sessPub.toBase58());
console.log("bump       :", bump);
console.log("created_at :", TS(created_at), `(unix: ${created_at})`);
console.log("expires_at :", TS(expires_at), `(unix: ${expires_at})`);
console.log(
    "duration   :",
    Number(expires_at - created_at),
    "seconds =",
    (Number(expires_at - created_at) / 3600).toFixed(1),
    "hours =",
    (Number(expires_at - created_at) / 86400).toFixed(1),
    "days"
);
console.log("max_amount :", SOL(max_amount));
console.log("spent      :", SOL(amount_spent));
console.log("max_per_tx :", SOL(max_per_tx));
console.log("is_revoked :", is_revoked);
console.log("nonce      :", nonce.toString());

const now = Math.floor(Date.now() / 1000);
const expiresIn = Number(expires_at) - now;
if (expiresIn > 0) {
    console.log(
        "\n✅ Session is VALID — expires in",
        (expiresIn / 3600).toFixed(1),
        "hours"
    );
} else {
    console.log(
        "\n❌ Session EXPIRED",
        (-expiresIn / 3600).toFixed(1),
        "hours ago"
    );
}
