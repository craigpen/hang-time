# Invite/Accept/Notification Alignment Audit

**Commit**: 2255926  
**Date**: 2026-08-04

## API Verification (nostr-tools 2.24.1)

✅ **encrypt()**: `(plaintext: string, conversationKey: Uint8Array) => string`
✅ **decrypt()**: `(payload: string, conversationKey: Uint8Array) => string`
✅ **getConversationKey()**: `(privkeyA: Uint8Array, pubkeyB: string) => Uint8Array`

---

## FRIEND REQUEST FLOW

### Send (background.ts:1287 → messaging.ts:134)
- ✅ Creates ActivityMessage type: 'friend_request'
- ✅ Encrypts: `nip44.encrypt(plaintext, conversationKey)` (messaging.ts:159)
- ✅ Tags: `['p', recipientPubkey]`, `['message_type', 'friend_request']` (messaging.ts:162-165)
- ✅ Queues via publishQueue.enqueueUserAction()

### Receive (background.ts:1723 DM subscription)
- ✅ RelayConnection routes kind-1059 events via dm_* subscriptions
- ✅ _handleMessage() extracts event (background.ts line ~1745)
- ✅ Decrypts: `nip44.decrypt(event.content, conversationKey)` (background.ts:1808)
- ✅ Parses to ActivityMessage
- ✅ Routes based on sender state:
  - If sender is known friend → _handleMessageEvent() (line 1763)
  - If sender is unknown → _handleFriendRequestFromUnknownSender() (line 1769)

### Accept (background.ts:1340)
- ✅ Calls messagingManager.sendJoinAccepted() (line 1380)
- ✅ sendJoinAccepted creates ActivityMessage type: 'join_accepted'
- ✅ Encrypts and sends via _sendActivityMessage()
- ✅ Calls _subscribeToFriend() BEFORE sending (line 1365)

### Accept Receive
- ✅ Event received and routed to _handleMessageEvent()
- ✅ Checks message.type === 'join_accepted' (line 2348)
- ✅ Routes to _handleFriendRequestResponse() (line 2350)
- ✅ Sends notification: "accepted your friend request" (line 2414-2417)
- ⚠️ **NOTE**: Early return at line 2351, doesn't reach generic notification block (2354-2364)

---

## ACTIVITY INVITE FLOW

### Send (popup.ts → background.ts → messaging.ts:67)
- ✅ Creates ActivityMessage type: 'invite'
- ✅ Encrypts: `nip44.encrypt(plaintext, conversationKey)` (messaging.ts:211)
- ✅ Tags: `['p', recipientPubkey]`, `['message_type', 'invite']` (messaging.ts:214, 221-222)
- ✅ Queues via publishQueue.enqueueUserAction()

### Receive (background.ts:1723 DM subscription)
- ✅ RelayConnection routes kind-1059 events via dm_* subscriptions
- ✅ _handleMessage() extracts event
- ✅ Decrypts: `nip44.decrypt(event.content, conversationKey)` (messaging.ts:291)
- ✅ Parses to ActivityMessage
- ✅ Routes: `if (message?.type === 'invite')` (line 2358)
- ✅ Sends notification: "invited you to join" (line 2359)
- ✅ Stores in activity messages via storageManager.addActivityMessage()

### Accept (background.ts - join action)
- ✅ Calls messagingManager.sendJoinAccepted() 
- ✅ Same flow as friend request accept
- ✅ But ALSO sends notification via notificationManager.notify()

---

## ALIGNMENT ISSUES FOUND

### ✅ Issue 1: Encryption Consistency
- **Status**: PASS
- Friend request and invite both use `nip44.encrypt(plaintext, conversationKey)`
- Both use `nip44.decrypt(payload, conversationKey)`
- Both convert secret key to bytes, keep pubkey as string

### ✅ Issue 2: Message Type Tags  
- **Status**: PASS
- Friend request tagged as 'friend_request'
- Invites tagged as 'invite'
- join_accepted tagged as 'friend_request' (by design, per earlier analysis)

### ✅ Issue 3: Notification Routing
- **Status**: PASS (with caveat)
- Friend accept: Gets notification via _handleFriendRequestResponse() (line 2414)
- Invite receive: Gets notification via generic block (line 2359)
- Activity accept: Gets notification via both paths

### ⚠️ Issue 4: join_accepted Message Type Tag
- **Location**: messaging.ts:217-218
- **Current**: Sets message_type tag to 'friend_request'
- **Implication**: This routes the message correctly (per line 2348 check for message.type, not tag)
- **Status**: ACCEPTABLE but confusing (tag doesn't match message type)

### ✅ Issue 5: Subscribe Before Send
- **Status**: PASS
- Friend request: _subscribeToFriend() called BEFORE send (line 1365)
- Activity invite: Recipient assumed to be in friends list already

### ✅ Issue 6: Storage and Deduplication
- **Status**: PASS
- markMessageProcessed() prevents duplicate handling (line 1749)
- shouldNotifyForInvite() prevents duplicate notifications (line 1410, 2410)

---

## SPEC COMPLIANCE

| Check | Status | Notes |
|-------|--------|-------|
| NIP-44 encryption | ✅ | Correct API usage |
| NIP-44 key derivation | ✅ | privkey as Uint8Array, pubkey as string |
| NIP-17 dm routing | ✅ | kind-1059 with #p tag filter |
| Message types | ✅ | Consistent between send/receive |
| Notifications | ✅ | Both paths send notifications |
| Error handling | ✅ | Decryption failures logged and caught |
| Deduplication | ✅ | Event ID based deduplication |

---

## CONCLUSION

No critical alignment issues found. Code appears consistent between friend request and invite flows. Both are using correct NIP-44 API and spec-compliant routing.

**Ready to test invites at commit 2255926.**
