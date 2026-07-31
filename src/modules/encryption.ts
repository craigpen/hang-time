/**
 * Hang Time - NIP-04 Message Encryption
 * Implements Nostr Improvement Proposal 4 for encrypted direct messages
 * Uses secp256k1 ECDH + AES-256-CBC per NIP-04 spec
 */

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';

// Configure secp256k1 to use sha256 for Schnorr signing
secp.hashes.sha256 = sha256;

export class EncryptionManager {
  /**
   * Encrypt message using NIP-04 (Nostr encrypted DMs)
   * Uses secp256k1 ECDH + AES-256-CBC per NIP-04 spec
   * Returns base64 encoded payload
   */
  async encrypt(plaintext: string, recipientPublicKey: string, senderSecretKey: string): Promise<string> {
    try {
      // Validate inputs
      if (!plaintext || typeof plaintext !== 'string') {
        throw new Error('Invalid plaintext for encryption');
      }
      if (!recipientPublicKey || typeof recipientPublicKey !== 'string') {
        throw new Error('Invalid recipient public key');
      }
      if (!senderSecretKey || typeof senderSecretKey !== 'string') {
        throw new Error('Invalid sender secret key');
      }

      console.debug(`[Encryption] Encrypting with recipient=${recipientPublicKey.substring(0, 16)}..., sender_secret=${senderSecretKey.substring(0, 16)}...`);

      // Convert keys from hex to bytes
      const recipientPubkeyHex = this._schnorrToSecp256k1(recipientPublicKey);
      const recipientPubkeyBytes = this._hexToBytes(recipientPubkeyHex);
      const senderSecretBytes = this._hexToBytes(senderSecretKey);

      // Compute ECDH shared secret: secp256k1_ecdh(sender_secret, recipient_pubkey)
      console.debug(`[Encryption] ECDH sender: secret=${senderSecretKey.substring(0, 16)}..., pubkey=${recipientPubkeyHex}`);
      const sharedSecretPoint = secp.getSharedSecret(senderSecretBytes, recipientPubkeyBytes);
      // Extract just the x-coordinate (skip the compression prefix byte)
      const sharedSecretBytes = sharedSecretPoint.slice(1);
      console.debug(`[Encryption] ECDH shared secret (x-only): ${sharedSecretBytes.length}b`);

      // Hash the shared secret to get AES key
      const sharedSecretHashed = sha256(sharedSecretBytes);
      const aesKey = sharedSecretHashed.slice(0, 32); // 32 bytes for AES-256
      console.debug(`[Encryption] AES key (sender): ${this._bytesToHex(aesKey).substring(0, 16)}...`);

      // Generate random IV (16 bytes for AES-CBC)
      const iv = new Uint8Array(16);
      crypto.getRandomValues(iv);

      // Encode plaintext as UTF-8
      const encoder = new TextEncoder();
      const plaintextBytes = encoder.encode(plaintext);

      // Encrypt using AES-256-CBC with crypto.subtle
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        aesKey,
        { name: 'AES-CBC' },
        false,
        ['encrypt']
      );

      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv },
        cryptoKey,
        plaintextBytes
      );

      // Combine IV + ciphertext and encode as base64
      const payload = new Uint8Array(iv.length + ciphertext.byteLength);
      payload.set(iv, 0);
      payload.set(new Uint8Array(ciphertext), iv.length);

      const base64Payload = this._bytesToBase64(payload);
      console.debug(`[Encryption] ✅ Encryption successful, payload length: ${base64Payload.length}`);

      return base64Payload;
    } catch (error) {
      throw new Error(`Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Decrypt message using NIP-04
   * Input should be base64 encoded (IV + ciphertext)
   */
  async decrypt(ciphertext: string, senderPublicKey: string, recipientSecretKey?: string): Promise<string> {
    try {
      // Validate inputs
      if (!ciphertext || typeof ciphertext !== 'string') {
        throw new Error('Invalid ciphertext for decryption');
      }
      if (!senderPublicKey || typeof senderPublicKey !== 'string') {
        throw new Error('Invalid sender public key');
      }
      if (!recipientSecretKey) {
        throw new Error('Recipient secret key required for decryption');
      }

      console.debug(`[Encryption] Attempting decryption with sender=${senderPublicKey.substring(0, 16)}..., secret_key=${recipientSecretKey.substring(0, 16)}...`);

      // Decode base64 payload
      const payload = this._base64ToBytes(ciphertext);

      // Extract IV (first 16 bytes) and actual ciphertext
      if (payload.length < 16) {
        throw new Error('Invalid encrypted payload (too short)');
      }

      const iv = payload.slice(0, 16);
      const encryptedContent = payload.slice(16);

      // Convert keys from hex to bytes
      const senderPubkeyHex = this._schnorrToSecp256k1(senderPublicKey);
      const senderPubkeyBytes = this._hexToBytes(senderPubkeyHex);
      const recipientSecretBytes = this._hexToBytes(recipientSecretKey);

      // Compute ECDH shared secret: secp256k1_ecdh(recipient_secret, sender_pubkey)
      console.debug(`[Encryption] ECDH recipient: secret=${recipientSecretKey.substring(0, 16)}..., pubkey=${senderPubkeyHex}`);
      const sharedSecretPoint = secp.getSharedSecret(recipientSecretBytes, senderPubkeyBytes);
      // Extract just the x-coordinate (skip the compression prefix byte)
      const sharedSecretBytes = sharedSecretPoint.slice(1);
      console.debug(`[Encryption] ECDH shared secret (x-only): ${sharedSecretBytes.length}b`);

      // Hash the shared secret to get AES key
      const sharedSecretHashed = sha256(sharedSecretBytes);
      const aesKey = sharedSecretHashed.slice(0, 32); // 32 bytes for AES-256
      console.debug(`[Encryption] AES key (recipient): ${this._bytesToHex(aesKey).substring(0, 16)}...`);

      // Decrypt using AES-256-CBC with crypto.subtle
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        aesKey,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
      );

      let plaintext: ArrayBuffer;
      try {
        console.debug(`[Encryption] About to decrypt: iv.length=${iv.length}, encryptedContent.length=${encryptedContent.length}`);
        plaintext = await crypto.subtle.decrypt(
          { name: 'AES-CBC', iv },
          cryptoKey,
          encryptedContent
        );
      } catch (decryptError) {
        const err = decryptError as any;
        console.error(`[Encryption] crypto.subtle.decrypt failed - name: ${err?.name}, message: ${err?.message}, type: ${typeof err}`);
        throw new Error(`crypto.subtle.decrypt failed: ${err?.message || err?.name || String(err)}`);
      }

      if (!plaintext || plaintext.byteLength === 0) {
        throw new Error('Decryption returned empty result');
      }

      const decoder = new TextDecoder();
      const result = decoder.decode(plaintext);

      console.debug(`[Encryption] ✅ Decryption successful, decoded ${result.length} chars`);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Encryption] ❌ Decryption error details: ${errorMsg}`);
      throw new Error(`Decryption failed: ${errorMsg}`);
    }
  }

  /**
   * Generate a key pair for encryption
   * Returns hex-encoded keys
   */
  generateKeyPair(): { publicKey: string; secretKey: string } {
    const keyPair = nacl.box.keyPair();
    return {
      publicKey: this._bytesToHex(keyPair.publicKey),
      secretKey: this._bytesToHex(keyPair.secretKey),
    };
  }

  /**
   * Encrypt data for local storage
   * Uses a simpler cipher for storage encryption
   */
  encryptForStorage(data: string, password: string): string {
    try {
      // Use password to derive a key
      const keyHash = nacl.hash(new TextEncoder().encode(password));
      const key = keyHash.slice(0, 32); // Take first 32 bytes for key

      // Generate nonce
      const nonce = nacl.randomBytes(24);

      // Encrypt
      const plaintext = decodeUTF8(data);
      const ciphertext = nacl.secretbox(plaintext, nonce, key);

      // Combine nonce + ciphertext
      const payload = new Uint8Array(nonce.length + ciphertext.length);
      payload.set(nonce, 0);
      payload.set(ciphertext, nonce.length);

      return encodeBase64(payload);
    } catch (error) {
      throw new Error(`Storage encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Decrypt data from local storage
   */
  decryptFromStorage(encrypted: string, password: string): string {
    try {
      // Derive key from password
      const keyHash = nacl.hash(new TextEncoder().encode(password));
      const key = keyHash.slice(0, 32);

      // Decode base64
      const payload = decodeBase64(encrypted);

      if (payload.length < 24) {
        throw new Error('Invalid encrypted payload');
      }

      // Extract nonce and ciphertext
      const nonce = payload.slice(0, 24);
      const ciphertext = payload.slice(24);

      // Decrypt
      const plaintext = nacl.secretbox.open(ciphertext, nonce, key);

      if (!plaintext) {
        throw new Error('Decryption failed - password may be incorrect');
      }

      return new TextDecoder().decode(plaintext);
    } catch (error) {
      throw new Error(`Storage decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Hash a string (SHA-512 via NaCl, for validation/checksums)
   */
  hash(data: string): string {
    const hash = nacl.hash(decodeUTF8(data));
    return this._bytesToHex(hash);
  }

  /**
   * Compute SHA-256 hash (for Nostr event IDs per NIP-01)
   */
  async sha256(data: string): Promise<string> {
    try {
      const encoder = new TextEncoder();
      const dataBuffer = encoder.encode(data);
      const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
      return this._bytesToHex(new Uint8Array(hashBuffer));
    } catch (error) {
      throw new Error(`SHA-256 hashing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Sign an event ID with a secret key (Schnorr signature for Nostr per BIP-340)
   */
  signEvent(eventId: string, secretKeyHex: string): string {
    try {
      const secretKeyBytes = this._hexToBytes(secretKeyHex);
      const eventIdBytes = this._hexToBytes(eventId);
      // Sign using secp256k1 Schnorr signature (BIP-340)
      const signature = secp.schnorr.sign(eventIdBytes, secretKeyBytes);
      // Return as hex string (64-char hex = 32 bytes)
      return signature.toHex();
    } catch (error) {
      throw new Error(`Event signing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Private utility methods
  private _hexToBytes(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) {
      throw new Error('Invalid hex string length');
    }

    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  private _bytesToHex(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i].toString(16);
      hex += byte.length === 1 ? '0' + byte : byte;
    }
    return hex;
  }

  private _bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private _base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Convert Schnorr pubkey (32 bytes) to compressed secp256k1 pubkey (33 bytes)
   * Schnorr keys in Nostr are just the x-coordinate. For ECDH, we need full pubkey.
   * Add 0x02 prefix to indicate compressed even point (assuming even y-coordinate).
   */
  private _schnorrToSecp256k1(schnorrHex: string): string {
    if (schnorrHex.length !== 64) {
      throw new Error('Invalid schnorr key length (expected 64 hex chars)');
    }
    // Prefix with 0x02 for compressed secp256k1 pubkey (even y-coordinate)
    return '02' + schnorrHex;
  }
}

export const encryptionManager = new EncryptionManager();
