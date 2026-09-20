/**
 * The allowlist must let in exactly who it was told to and nobody else.
 *
 * This is the only thing standing in front of an app with no login, so the
 * cases that matter are the ones where a near-miss could be read as a match:
 * an address one octet outside a CIDR block, an IPv4 rule and an IPv6 caller,
 * a rule that failed to parse. A false positive here is an open dashboard.
 *
 * Run: npm run test:ip
 */

import assert from 'node:assert/strict';
import { isIpAllowed, isLoopback, parseIpAllowlist } from '../lib/security/ipAllowlist';

let passed = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`  FAIL  ${label}`);
    throw error;
  }
}

/** Parse a list and assert it was fully understood, then test membership. */
function allows(raw: string, ip: string): boolean {
  const { rules, invalid } = parseIpAllowlist(raw);
  assert.deepEqual(invalid, [], `unexpected unparseable entries in "${raw}"`);
  return isIpAllowed(ip, rules);
}

function main(): void {
  console.log('ip allowlist');

  check('a bare IPv4 address matches itself and nothing adjacent', () => {
    assert.equal(allows('203.0.113.7', '203.0.113.7'), true);
    assert.equal(allows('203.0.113.7', '203.0.113.8'), false);
    assert.equal(allows('203.0.113.7', '203.0.113.70'), false);
    assert.equal(allows('203.0.113.7', '103.0.113.7'), false);
  });

  check('a CIDR block covers its range and stops at the edges', () => {
    assert.equal(allows('198.51.100.0/24', '198.51.100.0'), true);
    assert.equal(allows('198.51.100.0/24', '198.51.100.255'), true);
    assert.equal(allows('198.51.100.0/24', '198.51.101.0'), false);
    assert.equal(allows('198.51.100.0/24', '198.51.99.255'), false);

    // A /28 is 16 addresses: .16 through .31.
    assert.equal(allows('198.51.100.16/28', '198.51.100.31'), true);
    assert.equal(allows('198.51.100.16/28', '198.51.100.32'), false);
    assert.equal(allows('198.51.100.16/28', '198.51.100.15'), false);
  });

  check('a host address written with a prefix is read as its network', () => {
    // "my IP is .7, give me the /24" is a common way to write it.
    assert.equal(allows('203.0.113.7/24', '203.0.113.200'), true);
    assert.equal(allows('203.0.113.7/24', '203.0.114.200'), false);
  });

  check('separators and comments are all accepted', () => {
    const raw = '203.0.113.7, 198.51.100.0/24 # office\n2001:db8::1';
    assert.equal(allows(raw, '203.0.113.7'), true);
    assert.equal(allows(raw, '198.51.100.99'), true);
    assert.equal(allows(raw, '2001:db8::1'), true);
    assert.equal(allows(raw, '203.0.113.8'), false);
  });

  check('IPv6 matches across equivalent spellings', () => {
    assert.equal(allows('2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001'), true);
    assert.equal(allows('2001:0DB8::1', '2001:db8::1'), true);
    assert.equal(allows('2001:db8::/32', '2001:db8:dead:beef::5'), true);
    assert.equal(allows('2001:db8::/32', '2001:db9::5'), false);
  });

  check('an IPv4-mapped IPv6 caller matches the IPv4 rule', () => {
    // What a proxy in front of a dual-stack listener tends to hand over.
    assert.equal(allows('203.0.113.7', '::ffff:203.0.113.7'), true);
    assert.equal(allows('203.0.113.7', '[::ffff:203.0.113.7]'), true);
    assert.equal(allows('203.0.113.7', '::ffff:203.0.113.8'), false);
  });

  check('the families never match each other', () => {
    assert.equal(allows('2001:db8::/32', '203.0.113.7'), false);
    assert.equal(allows('203.0.113.0/24', '2001:db8::1'), false);
  });

  check('garbage never matches', () => {
    const { rules } = parseIpAllowlist('203.0.113.7');
    for (const junk of ['', '   ', 'not-an-ip', '203.0.113', '203.0.113.256', '1.2.3.4.5']) {
      assert.equal(isIpAllowed(junk, rules), false, `"${junk}" should not match`);
    }
  });

  check('unparseable entries are dropped, not thrown on', () => {
    const { rules, invalid } = parseIpAllowlist('203.0.113.7, nonsense, 198.51.100.0/99');
    assert.deepEqual(invalid, ['nonsense', '198.51.100.0/99']);
    assert.equal(rules.length, 1);
    assert.equal(isIpAllowed('203.0.113.7', rules), true);
  });

  check('an empty allowlist yields no rules, which the gate reads as "off"', () => {
    for (const raw of ['', '   ', '# nothing here', undefined]) {
      assert.deepEqual(parseIpAllowlist(raw).rules, [], `"${String(raw)}" should be empty`);
    }
  });

  check('loopback is recognised so local dev is never blocked', () => {
    assert.equal(isLoopback('127.0.0.1'), true);
    assert.equal(isLoopback('127.1.2.3'), true);
    assert.equal(isLoopback('::1'), true);
    assert.equal(isLoopback('203.0.113.7'), false);
    assert.equal(isLoopback('128.0.0.1'), false);
  });

  console.log(`\n${passed} checks passed`);
}

main();
