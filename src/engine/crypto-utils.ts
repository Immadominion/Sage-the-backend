/**
 * Crypto utilities for encrypting/decrypting bot keypairs at rest.
 *
 * Uses AES-256-GCM (authenticated encryption) with a master key
 * stored in the environment — never in the database.
 *
 * Format: base64(iv:tag:ciphertext) where iv=12 bytes, tag=16 bytes
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Derive a 32-byte key from the hex-encoded master key.
 * Throws if the key is not exactly 64 hex characters (32 bytes).
 */
function deriveKey(masterKeyHex: string): Buffer {
    if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
        throw new Error(
            "MASTER_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)"
        );
    }
    return Buffer.from(masterKeyHex, "hex");
}

/**
 * Encrypt a Solana keypair's secret key.
 * Returns a base64 string containing iv + tag + ciphertext.
 */
export function encryptKeypair(
    secretKey: Uint8Array,
    masterKeyHex: string
): string {
    const key = deriveKey(masterKeyHex);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([
        cipher.update(Buffer.from(secretKey)),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Pack: iv (12) + tag (16) + ciphertext
    const packed = Buffer.concat([iv, tag, encrypted]);
    return packed.toString("base64");
}

/**
 * Decrypt an encrypted keypair string back to a Solana Keypair.
 * Throws on tampered data or wrong key (GCM auth tag verification).
 */
export function decryptKeypair(
    encryptedBase64: string,
    masterKeyHex: string
): Keypair {
    const key = deriveKey(masterKeyHex);
    const packed = Buffer.from(encryptedBase64, "base64");

    if (packed.length < IV_LENGTH + TAG_LENGTH + 1) {
        throw new Error("Invalid encrypted keypair: too short");
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);

    return Keypair.fromSecretKey(new Uint8Array(decrypted));
}

/**
 * Generate a new random bot keypair and return both the Keypair
 * and its encrypted form for DB storage.
 */
export function generateEncryptedKeypair(masterKeyHex: string): {
    keypair: Keypair;
    publicKey: string;
    encryptedSecret: string;
} {
    const keypair = Keypair.generate();
    const encryptedSecret = encryptKeypair(keypair.secretKey, masterKeyHex);
    return {
        keypair,
        publicKey: keypair.publicKey.toBase58(),
        encryptedSecret,
    };
}

/**
 * Encrypt an arbitrary UTF-8 string (e.g. an API key) with AES-256-GCM.
 * Returns the same base64 iv:tag:ciphertext format as encryptKeypair.
 */
export function encryptString(plaintext: string, masterKeyHex: string): string {
    const key = deriveKey(masterKeyHex);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([
        cipher.update(Buffer.from(plaintext, "utf8")),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext back to a UTF-8 string.
 * Throws on tampered data or wrong key.
 */
export function decryptString(encryptedBase64: string, masterKeyHex: string): string {
    const key = deriveKey(masterKeyHex);
    const packed = Buffer.from(encryptedBase64, "base64");

    if (packed.length < IV_LENGTH + TAG_LENGTH + 1) {
        throw new Error("Invalid encrypted string: too short");
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
