/**
 * Sponsor wallet service — pays rent + tx fees for user wallet creation.
 *
 * Two strategies, checked in order:
 *
 *   1. **Keypair** (SPONSOR_KEYPAIR) — server-side Ed25519 secret key.
 *      Fastest, zero external deps, perfect for dev / hackathon.
 *      Just `solana-keygen new` → base58 encode → env var.
 *
 *   2. **Turnkey HSM** (TURNKEY_*) — remote signing via Turnkey API.
 *      Production-grade, key never leaves HSM. Higher latency.
 *
 * If neither is configured, sponsoring is disabled and the user
 * pays for wallet creation out of their own pocket.
 *
 * Flow (same for both strategies):
 *   backend builds TX with sponsor as funder + feePayer
 *   → sponsor signs (locally or via Turnkey)
 *   → partially-signed TX returned to Flutter
 *   → user signs via MWA → submits to Solana
 */

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import config from "../config.js";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface SponsorInfo {
  /** The sponsor's Solana public key */
  publicKey: PublicKey;
  /** The sponsor's base58 address */
  address: string;
  /** Which strategy is active */
  strategy: "keypair" | "turnkey";
}

/** Internal signer abstraction — same API for both strategies. */
interface SponsorSigner {
  strategy: "keypair" | "turnkey";
  publicKey: PublicKey;
  sign(tx: Transaction): Promise<Transaction>;
}

// ═══════════════════════════════════════════════════════════════
// Strategy 1: Server-side Keypair
// ═══════════════════════════════════════════════════════════════

function tryInitKeypair(): SponsorSigner | null {
  const { SPONSOR_KEYPAIR } = config;
  if (!SPONSOR_KEYPAIR) return null;

  try {
    const secretKey = bs58.decode(SPONSOR_KEYPAIR);
    const keypair = Keypair.fromSecretKey(secretKey);

    console.log(
      `✅ Sponsor initialized (keypair): ${keypair.publicKey.toBase58()}`
    );

    return {
      strategy: "keypair",
      publicKey: keypair.publicKey,
      async sign(tx: Transaction): Promise<Transaction> {
        tx.partialSign(keypair);
        return tx;
      },
    };
  } catch (error) {
    console.error("❌ Invalid SPONSOR_KEYPAIR:", error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Strategy 2: Turnkey HSM
// ═══════════════════════════════════════════════════════════════

async function tryInitTurnkey(): Promise<SponsorSigner | null> {
  const {
    TURNKEY_API_PUBLIC_KEY,
    TURNKEY_API_PRIVATE_KEY,
    TURNKEY_ORGANIZATION_ID,
    TURNKEY_SPONSOR_ADDRESS,
  } = config;

  if (
    !TURNKEY_API_PUBLIC_KEY ||
    !TURNKEY_API_PRIVATE_KEY ||
    !TURNKEY_ORGANIZATION_ID ||
    !TURNKEY_SPONSOR_ADDRESS
  ) {
    return null;
  }

  try {
    // Dynamic import — these packages are only loaded if Turnkey is configured.
    // This means the app works fine without @turnkey/* installed when using
    // the keypair strategy.
    const { Turnkey } = await import("@turnkey/sdk-server");
    const { TurnkeySigner } = await import("@turnkey/solana");

    const turnkey = new Turnkey({
      apiBaseUrl: "https://api.turnkey.com",
      apiPublicKey: TURNKEY_API_PUBLIC_KEY,
      apiPrivateKey: TURNKEY_API_PRIVATE_KEY,
      defaultOrganizationId: TURNKEY_ORGANIZATION_ID,
    });

    const signer = new TurnkeySigner({
      organizationId: TURNKEY_ORGANIZATION_ID,
      client: turnkey.apiClient(),
    });

    const publicKey = new PublicKey(TURNKEY_SPONSOR_ADDRESS);

    console.log(
      `✅ Sponsor initialized (Turnkey HSM): ${TURNKEY_SPONSOR_ADDRESS}`
    );

    return {
      strategy: "turnkey",
      publicKey,
      async sign(tx: Transaction): Promise<Transaction> {
        await signer.addSignature(tx, publicKey.toBase58());
        return tx;
      },
    };
  } catch (error) {
    console.error("❌ Failed to initialize Turnkey sponsor:", error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Singleton — priority: Keypair > Turnkey > disabled
// ═══════════════════════════════════════════════════════════════

let activeSigner: SponsorSigner | null = null;
let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // 1. Try server-side keypair first (fast, no external deps)
  activeSigner = tryInitKeypair();
  if (activeSigner) return;

  // 2. Fall back to Turnkey HSM
  activeSigner = await tryInitTurnkey();
  if (activeSigner) return;

  // 3. No sponsor configured
  console.warn(
    "⚠️  No sponsor configured — wallet creation will be self-funded.\n" +
    "   Set SPONSOR_KEYPAIR (simple) or TURNKEY_* (HSM) env vars."
  );
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

/**
 * Check whether sponsored wallet creation is available.
 */
export async function isSponsorAvailable(): Promise<boolean> {
  await ensureInitialized();
  return activeSigner !== null;
}

/**
 * Get the sponsor's public key and address.
 * Throws if sponsoring is not configured.
 */
export async function getSponsorInfo(): Promise<SponsorInfo> {
  await ensureInitialized();
  if (!activeSigner) {
    throw new Error(
      "Sponsor not configured. Set SPONSOR_KEYPAIR or TURNKEY_* env vars."
    );
  }
  return {
    publicKey: activeSigner.publicKey,
    address: activeSigner.publicKey.toBase58(),
    strategy: activeSigner.strategy,
  };
}

/**
 * Partially sign a transaction as the sponsor (fee payer / rent funder).
 *
 * The transaction's `feePayer` must already be set to the sponsor's pubkey.
 * After this call, the TX has the sponsor's signature; the user must
 * add their own signature via MWA before submitting.
 */
export async function sponsorSign(tx: Transaction): Promise<Transaction> {
  await ensureInitialized();
  if (!activeSigner) {
    throw new Error("Sponsor not configured — cannot sign transaction.");
  }
  return activeSigner.sign(tx);
}
