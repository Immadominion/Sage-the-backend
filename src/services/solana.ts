/**
 * Solana connection service + Sentinel PDA derivation.
 * Ported from sentinel/backend/src/services/solana.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import config from "../config.js";

// ═══════════════════════════════════════════════════════════════
// Connection (singleton with timeout)
// ═══════════════════════════════════════════════════════════════

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60_000, // 60s for tx confirmation
      disableRetryOnRateLimit: false,
    });
  }
  return connection;
}

export const SENTINEL_PROGRAM_ID = new PublicKey(config.SENTINEL_PROGRAM_ID);

// ═══════════════════════════════════════════════════════════════
// PDA Derivation
// ═══════════════════════════════════════════════════════════════

/** Derive SmartWallet PDA: seeds = ["sentinel", owner_pubkey] */
export function deriveWalletPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sentinel"), owner.toBuffer()],
    SENTINEL_PROGRAM_ID
  );
}

/** Derive AgentConfig PDA: seeds = ["agent", wallet_pubkey, agent_pubkey] */
export function deriveAgentPda(
  wallet: PublicKey,
  agent: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), wallet.toBuffer(), agent.toBuffer()],
    SENTINEL_PROGRAM_ID
  );
}

/** Derive SessionKey PDA: seeds = ["session", agent_pubkey, session_id_u32le] */
export function deriveSessionPda(
  agent: PublicKey,
  sessionId: number
): [PublicKey, number] {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(sessionId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("session"), agent.toBuffer(), buf],
    SENTINEL_PROGRAM_ID
  );
}
