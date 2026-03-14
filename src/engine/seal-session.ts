/**
 * SealSession — Wraps DLMM instructions in executeViaSession for
 * autonomous trade execution through the Seal smart wallet.
 *
 * The session keypair (stored server-side) signs the outer TX.
 * The Seal program validates limits, then CPI-invokes the inner
 * instruction with the wallet PDA promoted to signer (invoke_signed).
 *
 * This replaces WalletManager for live-mode bots that use Seal.
 */

import {
    Connection,
    ComputeBudgetProgram,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
} from "@solana/web3.js";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
    deriveAgentPda,
    deriveSessionPda,
    SEAL_PROGRAM_ID,
} from "../services/solana.js";
import config from "../config.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "seal-session" });

// ═══════════════════════════════════════════════════════════════
// Encoding helpers (same as seal-ts SDK)
// ═══════════════════════════════════════════════════════════════

/** Encode a u64 as little-endian 8 bytes */
function encodeU64(value: bigint): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value);
    return buf;
}

/** ExecuteViaSession discriminant in the Seal program */
const EXECUTE_VIA_SESSION_DISC = 3;
/** TransferLamports discriminant in the Seal program */
const TRANSFER_LAMPORTS_DISC = 13;
const MEMO_PROGRAM_ID = new PublicKey(
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);
const DEFAULT_WRAPPABLE_PROGRAMS = [
    SystemProgram.programId,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    MEMO_PROGRAM_ID,
];

function parseConfiguredProgramIds(value?: string): PublicKey[] {
    if (!value) return [];

    return value
        .split(",")
        .map((programId) => programId.trim())
        .filter(Boolean)
        .map((programId) => new PublicKey(programId));
}

function getSupportedWrappedPrograms(): PublicKey[] {
    const clusterSpecific =
        config.SOLANA_NETWORK === "mainnet-beta"
            ? config.SEAL_ALLOWED_PROGRAMS_MAINNET
            : config.SEAL_ALLOWED_PROGRAMS_DEVNET;

    const all = [
        ...DEFAULT_WRAPPABLE_PROGRAMS,
        ...parseConfiguredProgramIds(config.SEAL_ALLOWED_PROGRAMS),
        ...parseConfiguredProgramIds(clusterSpecific),
    ];

    const unique = new Map<string, PublicKey>();
    for (const program of all) {
        unique.set(program.toBase58(), program);
    }
    return Array.from(unique.values());
}

// ═══════════════════════════════════════════════════════════════
// SealSession
// ═══════════════════════════════════════════════════════════════

export interface SealSessionConfig {
    /** Canonical smart wallet PDA address */
    walletAddress: PublicKey;
    /** Agent keypair (server-generated, stored in DB) */
    agentKeypair: Keypair;
    /** Session keypair (server-generated, stored in DB) — signs all TXs */
    sessionKeypair: Keypair;
    /** Solana connection */
    connection: Connection;
}

export class SealSession {
    readonly walletPda: PublicKey;
    readonly agentPubkey: PublicKey;
    readonly agentPda: PublicKey;
    readonly sessionPubkey: PublicKey;
    readonly sessionPda: PublicKey;

    private readonly sessionKeypair: Keypair;
    private readonly connection: Connection;
    private readonly supportedWrappedPrograms: PublicKey[];

    constructor(config: SealSessionConfig) {
        this.walletPda = config.walletAddress;
        this.sessionKeypair = config.sessionKeypair;
        this.connection = config.connection;
        this.supportedWrappedPrograms = getSupportedWrappedPrograms();

        this.agentPubkey = config.agentKeypair.publicKey;
        const [agentPda] = deriveAgentPda(this.walletPda, this.agentPubkey);
        this.agentPda = agentPda;

        this.sessionPubkey = config.sessionKeypair.publicKey;
        const [sessionPda] = deriveSessionPda(
            this.walletPda,
            this.agentPubkey,
            this.sessionPubkey
        );
        this.sessionPda = sessionPda;

        log.info(
            {
                walletPda: this.walletPda.toBase58().slice(0, 8) + "…",
                sessionPubkey: this.sessionPubkey.toBase58().slice(0, 8) + "…",
            },
            "SealSession initialized"
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // Core: Wrap instruction in executeViaSession
    // ═══════════════════════════════════════════════════════════════

    /**
     * Wrap a single instruction in an executeViaSession envelope.
     *
     * The inner instruction's accounts are passed as remaining_accounts
     * to the Seal program. Any account matching the wallet PDA that is
     * marked as a signer gets its signer flag REMOVED (the Seal program
     * adds it back via invoke_signed).
     *
     * @param innerIx     The DLMM instruction to wrap
     * @param amountLamports  Amount for spending-limit tracking (use 0 for reads)
     */
    wrapInstruction(
        innerIx: TransactionInstruction,
        amountLamports: bigint = 0n
    ): TransactionInstruction {
        // Build remaining accounts from inner instruction:
        // - Strip signer flag from wallet PDA (Seal handles via invoke_signed)
        const remainingAccounts = innerIx.keys.map((key) => ({
            pubkey: key.pubkey,
            isSigner: key.pubkey.equals(this.walletPda) ? false : key.isSigner,
            isWritable: key.isWritable,
        }));

        // Instruction data: [disc(1)] + [amount(8)] + [inner_data(N)]
        const data = Buffer.concat([
            Buffer.from([EXECUTE_VIA_SESSION_DISC]),
            encodeU64(amountLamports),
            innerIx.data,
        ]);

        // Account ordering matches the on-chain processor
        const keys = [
            { pubkey: this.sessionPubkey, isSigner: true, isWritable: false },
            { pubkey: this.walletPda, isSigner: false, isWritable: true },
            { pubkey: this.agentPda, isSigner: false, isWritable: true },
            { pubkey: this.sessionPda, isSigner: false, isWritable: true },
            { pubkey: innerIx.programId, isSigner: false, isWritable: false },
            ...remainingAccounts,
        ];

        return new TransactionInstruction({
            programId: SEAL_PROGRAM_ID,
            keys,
            data,
        });
    }

    /**
     * Wrap ALL instructions in a Transaction with executeViaSession.
     * Returns a new Transaction with wrapped instructions.
     *
     * @param tx  The original transaction (e.g. from DLMM SDK)
     * @param amountLamports  Spending amount for limit tracking
     */
    wrapTransaction(
        tx: Transaction,
        amountLamports: bigint = 0n
    ): Transaction {
        const wrappedTx = new Transaction();
        wrappedTx.feePayer = this.sessionPubkey;

        for (const ix of tx.instructions) {
            if (ix.programId.equals(ComputeBudgetProgram.programId)) {
                wrappedTx.add(ix);
                continue;
            }

            const isSupported = this.supportedWrappedPrograms.some((programId) =>
                programId.equals(ix.programId)
            );

            if (!isSupported) {
                throw new Error(
                    `Unsupported instruction program for Seal-wrapped transaction: ${ix.programId.toBase58()}`
                );
            }

            wrappedTx.add(this.wrapInstruction(ix, amountLamports));
        }

        return wrappedTx;
    }

    async assertFeePayerFunded(minLamports = 200_000): Promise<void> {
        const balance = await this.connection.getBalance(this.sessionPubkey);

        if (balance < minLamports) {
            throw new Error(
                `Session signer balance too low for transaction fees: ${balance} lamports available, ${minLamports} required`
            );
        }
    }

    /**
     * Get the session keypair for signing transactions.
     * Used by TransactionSender as a signer.
     */
    getSessionKeypair(): Keypair {
        return this.sessionKeypair;
    }

    /**
     * Get the wallet PDA — this is the "user" for DLMM operations.
     * All positions are owned by this PDA, not the user's direct wallet.
     */
    getWalletPda(): PublicKey {
        return this.walletPda;
    }

    /**
     * Get the balance of the Seal wallet PDA on-chain.
     */
    async getWalletBalance(): Promise<number> {
        return this.connection.getBalance(this.walletPda);
    }

    /**
     * Build a TransferLamports instruction that moves lamports from
     * the wallet PDA to the session signer (or any destination).
     *
     * This uses the Seal program's TransferLamports instruction
     * (discriminant 13) which directly debits the PDA since the
     * Seal program owns it.
     */
    buildTransferLamportsIx(
        amountLamports: bigint,
        destination?: PublicKey
    ): TransactionInstruction {
        const dest = destination ?? this.sessionPubkey;
        const data = Buffer.concat([
            Buffer.from([TRANSFER_LAMPORTS_DISC]),
            encodeU64(amountLamports),
        ]);

        return new TransactionInstruction({
            programId: SEAL_PROGRAM_ID,
            keys: [
                { pubkey: this.sessionPubkey, isSigner: true, isWritable: false },
                { pubkey: this.walletPda, isSigner: false, isWritable: true },
                { pubkey: this.agentPda, isSigner: false, isWritable: true },
                { pubkey: this.sessionPda, isSigner: false, isWritable: true },
                { pubkey: dest, isSigner: false, isWritable: true },
            ],
            data,
        });
    }

    /**
     * Pre-fund the session signer from the wallet PDA.
     *
     * Checks the wallet PDA balance, calculates how much the session
     * signer needs for the upcoming operation, and transfers the
     * difference.
     *
     * @param neededLamports  Total lamports the session signer needs
     * @returns The transfer signature, or null if no transfer needed
     */
    async fundSessionFromWallet(
        neededLamports: number
    ): Promise<{ funded: boolean; transferred: number; signature?: string; error?: string }> {
        const [sessionBalance, walletBalance] = await Promise.all([
            this.connection.getBalance(this.sessionPubkey),
            this.connection.getBalance(this.walletPda),
        ]);

        if (sessionBalance >= neededLamports) {
            return { funded: true, transferred: 0 };
        }

        const deficit = neededLamports - sessionBalance;
        // Keep minimum rent on wallet PDA (SmartWallet = 278 bytes ≈ 0.003 SOL)
        const MIN_WALLET_RENT = 890_880;
        const maxTransferable = walletBalance - MIN_WALLET_RENT;

        if (maxTransferable <= 0) {
            const walletSOL = (walletBalance / LAMPORTS_PER_SOL).toFixed(4);
            return {
                funded: false,
                transferred: 0,
                error: `Wallet PDA has ${walletSOL} SOL, entire balance needed for rent`,
            };
        }

        // Transfer the minimum of what we need vs what's available
        const transferAmount = Math.min(deficit, maxTransferable);

        if (transferAmount < 10_000) {
            return {
                funded: false,
                transferred: 0,
                error: `Transfer amount too small: ${transferAmount} lamports`,
            };
        }

        log.info(
            {
                sessionBalance: (sessionBalance / LAMPORTS_PER_SOL).toFixed(4),
                walletBalance: (walletBalance / LAMPORTS_PER_SOL).toFixed(4),
                transferAmount: (transferAmount / LAMPORTS_PER_SOL).toFixed(4),
                needed: (neededLamports / LAMPORTS_PER_SOL).toFixed(4),
            },
            "Pre-funding session signer from wallet PDA"
        );

        const ix = this.buildTransferLamportsIx(BigInt(transferAmount));
        const { blockhash, lastValidBlockHeight } =
            await this.connection.getLatestBlockhash();

        const tx = new Transaction();
        tx.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
            ix
        );
        tx.feePayer = this.sessionPubkey;
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;

        tx.sign(this.sessionKeypair);

        try {
            const signature = await this.connection.sendRawTransaction(
                tx.serialize(),
                { skipPreflight: false, preflightCommitment: "confirmed" }
            );
            await this.connection.confirmTransaction(
                { signature, blockhash, lastValidBlockHeight },
                "confirmed"
            );

            log.info(
                { signature, amountSOL: (transferAmount / LAMPORTS_PER_SOL).toFixed(4) },
                "Session signer pre-funded from wallet PDA"
            );

            return { funded: true, transferred: transferAmount, signature };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ error: msg }, "Failed to pre-fund session from wallet PDA");
            return { funded: false, transferred: 0, error: msg };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Static: Load from DB fields
    // ═══════════════════════════════════════════════════════════════

    /**
     * Construct a SealSession from DB bot row fields.
     *
     * @param walletAddress       Canonical smart wallet PDA address (base58)
     * @param agentSecretKeyB64   Base64-encoded 64-byte agent keypair
     * @param sessionSecretKeyB64 Base64-encoded 64-byte session keypair
     * @param connection          Solana connection
     */
    static fromDb(
        walletAddress: string,
        agentSecretKeyB64: string,
        sessionSecretKeyB64: string,
        connection: Connection
    ): SealSession {
        const walletPda = new PublicKey(walletAddress);
        const agentKeypair = Keypair.fromSecretKey(
            Buffer.from(agentSecretKeyB64, "base64")
        );
        const sessionKeypair = Keypair.fromSecretKey(
            Buffer.from(sessionSecretKeyB64, "base64")
        );

        return new SealSession({
            walletAddress: walletPda,
            agentKeypair,
            sessionKeypair,
            connection,
        });
    }
}

export default SealSession;
