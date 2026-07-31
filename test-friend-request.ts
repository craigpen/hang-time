/**
 * Test friend request encryption/decryption end-to-end
 */

import { deriveKeypairFromIdentifier } from './src/modules/security-utils';
import { EncryptionManager } from './src/modules/encryption';

const encryptionManager = new EncryptionManager();

async function testFriendRequest() {
  console.log('=== Friend Request Encryption Test ===\n');

  // Sender setup
  const senderUUID = 'hidden-coast-manatee-mirror';
  const senderKeypair = deriveKeypairFromIdentifier(senderUUID);
  console.log(`Sender UUID: ${senderUUID}`);
  console.log(`Sender pubkey: ${senderKeypair.pubkey.substring(0, 16)}...`);
  console.log(`Sender secretKey: ${senderKeypair.secretKey.substring(0, 16)}...\n`);

  // Recipient setup
  const recipientUUID = 'tall-plant-elephant-doctor';
  const recipientKeypair = deriveKeypairFromIdentifier(recipientUUID);
  console.log(`Recipient UUID: ${recipientUUID}`);
  console.log(`Recipient pubkey: ${recipientKeypair.pubkey.substring(0, 16)}...`);
  console.log(`Recipient secretKey: ${recipientKeypair.secretKey.substring(0, 16)}...\n`);

  // Message to encrypt
  const message = JSON.stringify({
    type: 'friend_request',
    sender_identifier: 'hidden-coast-manatee-mirror',
    content: 'Want to be friends?'
  });
  console.log(`Message: ${message}\n`);

  // Sender encrypts to recipient
  console.log('--- SENDER ENCRYPTING ---');
  console.log(`Using recipient pubkey: ${recipientKeypair.pubkey.substring(0, 16)}...`);
  console.log(`Using sender secretKey: ${senderKeypair.secretKey.substring(0, 16)}...\n`);

  let encryptedPayload: string;
  try {
    encryptedPayload = await encryptionManager.encrypt(
      message,
      recipientKeypair.pubkey,  // Encrypt TO recipient
      senderKeypair.secretKey   // Sign FROM sender
    );
    console.log(`✅ Encryption successful`);
    console.log(`Encrypted payload length: ${encryptedPayload.length}`);
    console.log(`Encrypted payload (first 50 chars): ${encryptedPayload.substring(0, 50)}...\n`);
  } catch (error) {
    console.error(`❌ Encryption failed: ${error}\n`);
    return;
  }

  // Recipient decrypts
  console.log('--- RECIPIENT DECRYPTING ---');
  console.log(`Using sender pubkey: ${senderKeypair.pubkey.substring(0, 16)}...`);
  console.log(`Using recipient secretKey: ${recipientKeypair.secretKey.substring(0, 16)}...\n`);

  try {
    const decrypted = await encryptionManager.decrypt(
      encryptedPayload,
      senderKeypair.pubkey,      // Decrypt FROM sender
      recipientKeypair.secretKey // Sign FROM recipient
    );
    console.log(`✅ Decryption successful`);
    console.log(`Decrypted message: ${decrypted}\n`);

    // Verify
    if (decrypted === message) {
      console.log('✅ ROUND-TRIP SUCCESS: Encrypted and decrypted message matches!\n');
    } else {
      console.log('❌ ROUND-TRIP FAILED: Messages do not match!');
      console.log(`Original:  ${message}`);
      console.log(`Decrypted: ${decrypted}\n`);
    }
  } catch (error) {
    console.error(`❌ Decryption failed: ${error}\n`);
  }
}

testFriendRequest().catch(console.error);
