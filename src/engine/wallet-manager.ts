/**
 * WalletManager — Secure wallet loading & validation for live trading.
 *
 * Ported from lp-bot/src/wallet/wallet-manager.ts for ESM.
 *
 * Loading modes:
 *  1. JSON file  — standard Solana keypair (array of 64 ints)
 *  2. Environment variable — base64-encoded secret key
 *  3. Direct Keypair injection (for tests / programmatic use)
 *
 * Security rules:
 *  - NEVER log private keys
 *  - Require explicit `confirm()` before live trading
 *  - Validate balance before every trade
 *
 * ⚠️ FINANCIAL WARNING: This manages REAL MONEY.
 */

import {
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "wallet-manager" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface WalletInfo {
  publicKey: PublicKey;
  balanceLamports: number;
  balanceSOL: number;
  isValid: boolean;
}

export interface WalletManagerConfig {
  /** Minimum SOL to keep for tx fees + rent */
  minBalanceSOL: number;
  /** Maximum SOL allowed in positions */
  maxExposureSOL: number;
  /** Require explicit confirm() before trading */
  requireConfirmation: boolean;
}

const DEFAULT_CONFIG: WalletManagerConfig = {
  minBalanceSOL: 0.08,
  maxExposureSOL: 10,
  requireConfirmation: true,
};

// ═══════════════════════════════════════════════════════════════
// WalletManager
// ═══════════════════════════════════════════════════════════════

export class WalletManager {
  private keypair: Keypair | null = null;
  private connection: Connection;
  private config: WalletManagerConfig;
  private confirmed = false;

  constructor(
    connection: Connection,
    config?: Partial<WalletManagerConfig>
  ) {
    this.connection = connection;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Loading ──

  /**
   * Load from standard Solana keypair JSON file (array of 64 numbers).
   */
  loadFromFile(walletPath: string): void {
    const resolved = path.resolve(walletPath);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Wallet file not found: ${resolved}`);
    }

    // Warn about loose permissions (Unix only)
    if (process.platform !== "win32") {
      const stats = fs.statSync(resolved);
      const mode = stats.mode & 0o777;
      if (mode !== 0o600 && mode !== 0o400) {
        log.warn(
          { currentMode: mode.toString(8) },
          "Wallet file permissions too open — recommend chmod 600"
        );
      }
    }

    const keyData: unknown = JSON.parse(fs.readFileSync(resolved, "utf-8"));
    if (!Array.isArray(keyData) || keyData.length !== 64) {
      throw new Error("Invalid wallet file format. Expected array of 64 numbers.");
    }

    this.keypair = Keypair.fromSecretKey(new Uint8Array(keyData as number[]));
    log.info(
      { publicKey: this.keypair.publicKey.toBase58() },
      "Wallet loaded from file"
    );
  }

  /**
   * Load from base64-encoded secret key in an environment variable.
   */
  loadFromEnv(envVar = "WALLET_PRIVATE_KEY"): void {
    const encoded = process.env[envVar];
    if (!encoded) {
      throw new Error(`Environment variable ${envVar} not set`);
    }

    const secretKey = Buffer.from(encoded, "base64");
    if (secretKey.length !== 64) {
      throw new Error("Invalid key length. Expected 64 bytes.");
    }

    this.keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
    log.info(
      { publicKey: this.keypair.publicKey.toBase58() },
      "Wallet loaded from environment"
    );
  }

  /**
   * Load directly from a Keypair instance (programmatic / test use).
   */
  loadFromKeypair(keypair: Keypair): void {
    this.keypair = keypair;
    log.info(
      { publicKey: keypair.publicKey.toBase58() },
      "Wallet loaded from keypair"
    );
  }

  // ── Queries ──

  async getWalletInfo(): Promise<WalletInfo> {
    if (!this.keypair) {
      return {
        publicKey: PublicKey.default,
        balanceLamports: 0,
        balanceSOL: 0,
        isValid: false,
      };
    }

    const balanceLamports = await this.connection.getBalance(
      this.keypair.publicKey
    );

    return {
      publicKey: this.keypair.publicKey,
      balanceLamports,
      balanceSOL: balanceLamports / LAMPORTS_PER_SOL,
      isValid: balanceLamports > this.config.minBalanceSOL * LAMPORTS_PER_SOL,
    };
  }

  /** Available balance for trading (total - fee reserve). */
  async getAvailableBalance(): Promise<number> {
    const info = await this.getWalletInfo();
    return Math.max(0, info.balanceSOL - this.config.minBalanceSOL);
  }

  // ── Validation ──

  /**
   * Validate wallet can trade the given SOL amount.
   * Pass 0 as amountSOL to just check wallet is loaded + confirmed.
   */
  async validateForTrading(
    amountSOL: number
  ): Promise<{ valid: boolean; reason?: string }> {
    if (!this.keypair) {
      return { valid: false, reason: "No wallet loaded" };
    }

    if (!this.confirmed && this.config.requireConfirmation) {
      return {
        valid: false,
        reason: "Live trading not confirmed. Call confirm() first.",
      };
    }

    if (amountSOL > 0) {
      const available = await this.getAvailableBalance();

      if (amountSOL > available) {
        return {
          valid: false,
          reason: `Insufficient balance. Need ${amountSOL} SOL, have ${available.toFixed(4)} SOL available`,
        };
      }

      if (amountSOL > this.config.maxExposureSOL) {
        return {
          valid: false,
          reason: `Amount ${amountSOL} SOL exceeds max exposure limit of ${this.config.maxExposureSOL} SOL`,
        };
      }
    }

    return { valid: true };
  }

  // ── Safety gate ──

  /** Confirm intent to trade with real money. */
  confirm(): void {
    if (!this.keypair) {
      throw new Error("Cannot confirm: No wallet loaded");
    }
    this.confirmed = true;
    log.warn(
      { publicKey: this.keypair.publicKey.toBase58() },
      "LIVE TRADING CONFIRMED — REAL MONEY MODE"
    );
  }

  // ── Accessors ──

  /** Get keypair for signing. Throws if not loaded/confirmed. */
  getKeypair(): Keypair {
    if (!this.keypair) throw new Error("No wallet loaded");
    if (!this.confirmed && this.config.requireConfirmation) {
      throw new Error("Live trading not confirmed. Call confirm() first.");
    }
    return this.keypair;
  }

  /** Get public key (available even before confirmation). */
  getPublicKey(): PublicKey {
    if (!this.keypair) throw new Error("No wallet loaded");
    return this.keypair.publicKey;
  }

  isLoaded(): boolean {
    return this.keypair !== null;
  }

  isConfirmed(): boolean {
    return this.confirmed;
  }

  /** Clear wallet from memory. */
  clear(): void {
    this.keypair = null;
    this.confirmed = false;
    log.info("Wallet cleared from memory");
  }
}

export default WalletManager;
