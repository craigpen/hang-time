#!/usr/bin/env node

/**
 * Quick script to check NIP-11 capabilities of our default relays
 * Run: node check-relay-capabilities.js
 */

const DEFAULT_RELAYS = [
  'wss://nostr.pub/',
  'wss://relay.damus.io/',
  'wss://nos.lol/',
  'wss://relay.current.fyi/',
];

async function fetchRelayInfo(relayUrl) {
  try {
    const domainUrl = new URL(relayUrl);
    const infoUrl = `https://${domainUrl.hostname}/.well-known/nostr.json`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(infoUrl, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return { relay: relayUrl, error: `HTTP ${response.status}` };
      }

      const info = await response.json();
      return { relay: relayUrl, info };
    } catch (error) {
      clearTimeout(timeout);
      return { relay: relayUrl, error: error.name === 'AbortError' ? 'Timeout' : error.message };
    }
  } catch (error) {
    return { relay: relayUrl, error: error.message };
  }
}

async function main() {
  console.log('Checking NIP-11 capabilities for default relays...\n');

  const results = await Promise.all(DEFAULT_RELAYS.map(fetchRelayInfo));

  for (const result of results) {
    const domain = new URL(result.relay).hostname;
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Relay: ${domain}`);
    console.log(`${'='.repeat(70)}`);

    if (result.error) {
      console.log(`❌ Error: ${result.error}`);
      continue;
    }

    const info = result.info;
    console.log(`Name: ${info.name || '(not specified)'}`);
    console.log(`Description: ${info.description || '(not specified)'}`);
    console.log(`Software: ${info.software || '(not specified)'} v${info.version || '?'}`);

    if (info.supported_nips && info.supported_nips.length > 0) {
      console.log(`\nSupported NIPs: ${info.supported_nips.join(', ')}`);
      const hasEphemeral = info.supported_nips.some(nip => nip >= 20000 && nip <= 29999);
      console.log(`  - Ephemeral kinds (20000-29999): ${hasEphemeral ? '✅ Yes' : '❌ No'}`);
      const hasNIP44 = info.supported_nips.includes(44);
      console.log(`  - NIP-44 (kind 1059): ${hasNIP44 ? '✅ Yes' : '❌ No'}`);
    } else {
      console.log(`Supported NIPs: (not specified - assume basic NIP-01 support)`);
    }

    if (info.limitation) {
      const lim = info.limitation;
      console.log(`\nLimitations:`);
      if (lim.max_message_length) console.log(`  - Max message length: ${lim.max_message_length} bytes`);
      if (lim.max_content_length) console.log(`  - Max content length: ${lim.max_content_length} bytes`);
      if (lim.max_subscriptions) console.log(`  - Max subscriptions: ${lim.max_subscriptions}`);
      if (lim.max_filters) console.log(`  - Max filters per subscription: ${lim.max_filters}`);
      if (lim.max_limit) console.log(`  - Max limit per filter: ${lim.max_limit}`);
      if (lim.max_event_tags) console.log(`  - Max event tags: ${lim.max_event_tags}`);
      if (lim.min_pow_difficulty) console.log(`  - Min PoW difficulty: ${lim.min_pow_difficulty}`);
      if (lim.auth_required) console.log(`  - Auth required: ✅ Yes (NIP-42)`);
      if (lim.payment_required) console.log(`  - Payment required: ✅ Yes`);
      if (lim.restricted_writes) console.log(`  - Restricted writes: ✅ Yes`);
    } else {
      console.log(`\nLimitations: (not specified - assume defaults)`);
    }

    if (info.retention) {
      const ret = info.retention;
      console.log(`\nRetention Policy:`);
      if (ret.max_event_tags) console.log(`  - Max event tags: ${ret.max_event_tags}`);
      if (ret.backup) console.log(`  - Backup: ${ret.backup}`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('Summary');
  console.log(`${'='.repeat(70)}`);

  const successful = results.filter(r => !r.error);
  console.log(`\n✅ Successful: ${successful.length}/${DEFAULT_RELAYS.length}`);

  const ephemeralSupport = successful.filter(r => {
    const nips = r.info.supported_nips || [];
    return nips.some(nip => nip >= 20000 && nip <= 29999);
  });
  console.log(`✅ Ephemeral kinds support: ${ephemeralSupport.length}/${successful.length}`);

  const nip44Support = successful.filter(r => {
    const nips = r.info.supported_nips || [];
    return nips.includes(44);
  });
  console.log(`✅ NIP-44 (kind 1059) support: ${nip44Support.length}/${successful.length}`);

  const authRequired = successful.filter(r => r.info.limitation?.auth_required);
  console.log(`⚠️  Auth required: ${authRequired.length}/${successful.length}`);

  const paymentRequired = successful.filter(r => r.info.limitation?.payment_required);
  console.log(`⚠️  Payment required: ${paymentRequired.length}/${successful.length}`);
}

main().catch(console.error);
