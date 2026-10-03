// Webhook addresses set by merchants are fetched by this server, so they must point at the public
// internet: never at this machine, the hosting provider's private network or cloud metadata.
import dns from 'node:dns/promises';
import net from 'node:net';

const privateRanges = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
]) {
  privateRanges.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  privateRanges.addSubnet(address, prefix, 'ipv6');
}

/** Whether an IP address is on a private, loopback, link-local or otherwise non-public network. */
export function isPrivateAddress(address) {
  const type = net.isIP(address);
  if (!type) return true;
  // ::ffff:10.0.0.1 is 10.0.0.1.
  const mapped = type === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return privateRanges.check(mapped, 'ipv4');
  return privateRanges.check(address, type === 4 ? 'ipv4' : 'ipv6');
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home|lan)$/i;

/** A full https:// address on a public host name or public IP. Checked when a merchant saves it. */
export function isPublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return !isPrivateAddress(host);
  return host.includes('.') && !LOCAL_NAMES.test(host);
}

/** Resolves the URL's host and throws when any of its addresses is private. Checked before each delivery. */
export async function assertPublicDestination(value, lookup = dns.lookup) {
  const host = new URL(value).hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('The webhook address points to a private network');
  }
}
