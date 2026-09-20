/**
 * IP allowlist parsing and matching.
 *
 * The dashboard has no login: anyone with the Vercel URL can queue jobs, read
 * seller pricing and export it. The allowlist is what stands in front of that —
 * `IP_ALLOWLIST` names the addresses allowed to reach the app at all, and
 * middleware.ts turns everything else away before a route ever runs.
 *
 * Entries are IPv4 or IPv6, bare or in CIDR form, separated by commas,
 * whitespace or newlines, with `#` comments allowed:
 *
 *   IP_ALLOWLIST="203.0.113.7, 198.51.100.0/24 # office, 2001:db8::/32"
 *
 * Addresses are compared numerically rather than as text, so `::ffff:203.0.113.7`
 * matches a `203.0.113.7` rule and `2001:db8:0:0::1` matches `2001:db8::1`.
 * A bare address is an exact match — it is simply a /32 or /128.
 */

/** A single parsed allowlist entry, held as a network address plus its mask. */
export interface AllowRule {
  /** The network address, already masked. */
  network: bigint;
  /** The prefix mask; an address matches when `addr & mask === network`. */
  mask: bigint;
  /** 32 for IPv4, 128 for IPv6. Rules only match addresses of the same family. */
  bits: 32 | 128;
}

/** A normalised address: its numeric value and which family it belongs to. */
interface NormalisedIp {
  value: bigint;
  bits: 32 | 128;
}

/**
 * Loopback, always allowed. These cannot be spoofed by a remote client — on
 * Vercel the client address comes from the TCP connection, not a header the
 * caller controls — and allowing them is what keeps `npm run dev` usable.
 */
const LOOPBACK: AllowRule[] = [
  // 127.0.0.0/8
  { network: 0x7f000000n, mask: 0xff000000n, bits: 32 },
  // ::1/128
  { network: 1n, mask: (1n << 128n) - 1n, bits: 128 },
];

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let out = 0n;
  for (const part of parts) {
    // Leading zeros are rejected outright: "010" is 8 to some parsers and 10 to
    // others, and an allowlist is no place for that argument.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    out = (out << 8n) | BigInt(octet);
  }
  return out;
}

function ipv6ToBigInt(ip: string): bigint | null {
  // A zone id ("%eth0") is a local routing detail, never part of the identity.
  let text = ip.split('%')[0] ?? '';

  // A trailing dotted quad ("::ffff:203.0.113.7") is two hextets in disguise.
  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    const embedded = ipv4ToBigInt(text.slice(lastColon + 1));
    if (embedded === null) return null;
    const high = (embedded >> 16n) & 0xffffn;
    const low = embedded & 0xffffn;
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const split = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = split(halves[0] ?? '');

  let groups: string[];
  if (halves.length === 2) {
    const tail = split(halves[1] ?? '');
    const elided = 8 - head.length - tail.length;
    // "::" has to stand for at least one group of zeros, or it is just noise.
    if (elided < 1) return null;
    groups = [...head, ...Array<string>(elided).fill('0'), ...tail];
  } else {
    groups = head;
  }

  if (groups.length !== 8) return null;

  let out = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    out = (out << 16n) | BigInt(parseInt(group, 16));
  }
  return out;
}

/**
 * Parse one address into a number plus a family, or null if it is not an
 * address at all. IPv4-mapped IPv6 collapses to plain IPv4 so that a proxy
 * handing us `::ffff:203.0.113.7` still matches a `203.0.113.7` rule.
 */
function normaliseIp(ip: string): NormalisedIp | null {
  // Bracketed literals arrive from URL-shaped headers: "[2001:db8::1]:443".
  const text = ip.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (text === '') return null;

  if (!text.includes(':')) {
    const value = ipv4ToBigInt(text);
    return value === null ? null : { value, bits: 32 };
  }

  const value = ipv6ToBigInt(text);
  if (value === null) return null;

  // ::ffff:0:0/96 — an IPv4 address wearing an IPv6 coat.
  if (value >> 32n === 0xffffn) return { value: value & 0xffffffffn, bits: 32 };

  return { value, bits: 128 };
}

/** Parse a single `address` or `address/prefix` entry. */
function parseEntry(entry: string): AllowRule | null {
  const slash = entry.lastIndexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const prefixText = slash === -1 ? null : entry.slice(slash + 1).trim();

  const normalised = normaliseIp(address);
  if (!normalised) return null;

  let prefix: number = normalised.bits;
  if (prefixText !== null) {
    if (!/^\d{1,3}$/.test(prefixText)) return null;
    prefix = Number(prefixText);
    if (prefix > normalised.bits) return null;
  }

  const hostBits = BigInt(normalised.bits - prefix);
  const mask = (((1n << BigInt(prefix)) - 1n) << hostBits);

  // Mask the network too, so a sloppy "203.0.113.7/24" still means 203.0.113.0/24.
  return { network: normalised.value & mask, mask, bits: normalised.bits };
}

/**
 * Parse the `IP_ALLOWLIST` value into rules, dropping anything unparseable.
 *
 * Malformed entries are skipped rather than thrown on: one typo in a Vercel
 * env var should cost you that entry, not take the whole site down with a
 * middleware crash. `invalid` is returned so the caller can say so out loud.
 */
export function parseIpAllowlist(raw: string | undefined | null): {
  rules: AllowRule[];
  invalid: string[];
} {
  if (!raw) return { rules: [], invalid: [] };

  const entries = raw
    .replace(/#[^\n,]*/g, '') // strip comments
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  const rules: AllowRule[] = [];
  const invalid: string[] = [];

  for (const entry of entries) {
    const rule = parseEntry(entry);
    if (rule) rules.push(rule);
    else invalid.push(entry);
  }

  return { rules, invalid };
}

/** True when `ip` falls inside any of `rules`. An unparseable IP matches nothing. */
export function isIpAllowed(ip: string, rules: readonly AllowRule[]): boolean {
  const normalised = normaliseIp(ip);
  if (!normalised) return false;

  return rules.some(
    (rule) =>
      rule.bits === normalised.bits && (normalised.value & rule.mask) === rule.network,
  );
}

/** True for 127.0.0.0/8 and ::1 — the machine talking to itself. */
export function isLoopback(ip: string): boolean {
  return isIpAllowed(ip, LOOPBACK);
}
