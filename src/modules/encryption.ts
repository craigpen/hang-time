/**
 * Hang Time - NIP-04 Message Encryption
 * Implements Nostr Improvement Proposal 4 for encrypted direct messages
 * Uses TweetNaCl.js for encryption/decryption
 */

import nacl from 'tweetnacl';
import { decodeUTF8, encodeBase64, decodeBase64 } from 'tweetnacl-util';

export class EncryptionManager {
  /**
   * Encrypt message using NIP-04 (Nostr encrypted DMs)
   * Returns base64 encoded ciphertext
   */
  encrypt(plaintext: string, recipientPublicKey: string): string {
    try {
      // Validate inputs
      if (!plaintext || typeof plaintext !== 'string') {
        throw new Error('Invalid plaintext for encryption');
      }
      if (!recipientPublicKey || typeof recipientPublicKey !== 'string') {
        throw new Error('Invalid recipient public key');
      }

      // For NIP-04, we need the recipient's actual public key (hex format)
      // Convert recipient identifier to a consistent key format
      const recipientBytes = this._hexToBytes(recipientPublicKey);

      // Generate ephemeral key pair for this message
      const ephemeralKeyPair = nacl.box.keyPair();

      // Create plaintext bytes
      const plaintextBytes = decodeUTF8(plaintext);

      // Create nonce (24 random bytes)
      const nonce = nacl.randomBytes(24);

      // Encrypt: ephemeral_sk + recipient_pk
      const ciphertext = nacl.box(plaintextBytes, nonce, recipientBytes, ephemeralKeyPair.secretKey);

      // Return: base64(nonce + ciphertext)
      const payload = new Uint8Array(nonce.length + ciphertext.length);
      payload.set(nonce, 0);
      payload.set(ciphertext, nonce.length);

      return encodeBase64(payload);
    } catch (error) {
      throw new Error(`Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Decrypt message using NIP-04
   * Input should be base64 encoded (nonce + ciphertext)
   */
  decrypt(ciphertext: string, senderPublicKey: string, recipientSecretKey?: string): string {
    try {
      // Validate inputs
      if (!ciphertext || typeof ciphertext !== 'string') {
        throw new Error('Invalid ciphertext for decryption');
      }
      if (!senderPublicKey || typeof senderPublicKey !== 'string') {
        throw new Error('Invalid sender public key');
      }

      // Decode base64 payload
      const payload = decodeBase64(ciphertext);

      // Extract nonce (first 24 bytes) and actual ciphertext
      if (payload.length < 24) {
        throw new Error('Invalid encrypted payload (too short)');
      }

      const nonce = payload.slice(0, 24);
      const encryptedContent = payload.slice(24);

      // Sender's public key
      const senderBytes = this._hexToBytes(senderPublicKey);

      // For now, we'd need recipient's secret key to decrypt
      // In production, this would be retrieved from secure storage
      if (!recipientSecretKey) {
        throw new Error('Recipient secret key required for decryption');
      }

      const recipientSecretBytes = this._hexToBytes(recipientSecretKey);

      // Decrypt
      const plaintext = nacl.box.open(encryptedContent, nonce, senderBytes, recipientSecretBytes);

      if (!plaintext) {
        throw new Error('Decryption failed - message may be corrupted or keys invalid');
      }

      // Convert back to UTF-8
      return new TextDecoder().decode(plaintext);
    } catch (error) {
      throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
   * Hash a string (for validation/checksums)
   */
  hash(data: string): string {
    const hash = nacl.hash(decodeUTF8(data));
    return this._bytesToHex(hash);
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
}

export const encryptionManager = new EncryptionManager();
