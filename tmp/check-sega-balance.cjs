const pg = require("pg");
const { Connection, PublicKey } = require("@solana/web3.js");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const conn = new Connection(
  "https://REDACTED-RPC-URL"
);

async function main() {
  const { rows } = await pool.query(
    "SELECT agent_pubkey, session_pubkey FROM bots WHERE bot_id = '0131429c'"
  );
  const row = rows[0];
  console.log("Agent:", row.agent_pubkey);
  console.log("Session:", row.session_pubkey);

  const walletPda = "HNNBATNGcxUAn7Ye7tp9GWpyGj5EijQwT55QC1GFcnef";

  const [w, a, s] = await Promise.all([
    conn.getBalance(new PublicKey(walletPda)),
    conn.getBalance(new PublicKey(row.agent_pubkey)),
    conn.getBalance(new PublicKey(row.session_pubkey)),
  ]);

  console.log("Wallet PDA:", (w / 1e9).toFixed(6), "SOL");
  console.log("Agent:", (a / 1e9).toFixed(6), "SOL");
  console.log("Session:", (s / 1e9).toFixed(6), "SOL");
  console.log("Total:", ((w + a + s) / 1e9).toFixed(6), "SOL");

  // Also check user 5 (the new user with Solitudinary bot)
  const { rows: rows5 } = await pool.query(
    "SELECT agent_pubkey, session_pubkey, seal_wallet_address FROM bots b JOIN users u ON b.user_id = u.id WHERE bot_id = '8825e82c'"
  );
  if (rows5.length > 0) {
    const r5 = rows5[0];
    const wAddr = r5.seal_wallet_address;
    console.log("\n--- User 5 (Solitudinary) ---");
    console.log("Wallet PDA:", wAddr);
    console.log("Agent:", r5.agent_pubkey);
    console.log("Session:", r5.session_pubkey);
    if (wAddr) {
      const [w5, a5] = await Promise.all([
        conn.getBalance(new PublicKey(wAddr)),
        r5.agent_pubkey
          ? conn.getBalance(new PublicKey(r5.agent_pubkey))
          : Promise.resolve(0),
      ]);
      console.log("Wallet PDA bal:", (w5 / 1e9).toFixed(6), "SOL");
      console.log("Agent bal:", (a5 / 1e9).toFixed(6), "SOL");
    }
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  pool.end();
});
