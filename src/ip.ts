import { isIP } from "node:net";

/**
 * Return one stable representation for an IP literal.
 *
 * IPv6 has many equivalent textual forms. URL's IPv6 parser gives us a
 * standards-based compressed form, and IPv4-mapped IPv6 addresses are folded
 * to IPv4 so `::ffff:192.0.2.1` compares equal to `192.0.2.1`.
 */
export function canonicalIp(raw: string): string | null {
  const trimmed = raw.trim();
  const value = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  const version = isIP(value);
  if (version === 0) return null;
  if (version === 4) return value.split(".").map((part) => String(Number(part))).join(".");

  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    const normalized = hostname.slice(1, -1).toLowerCase();
    const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (!mapped) return normalized;
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  } catch {
    return null;
  }
}

/** Compare two validated address literals by address value, not spelling. */
export function sameIp(left: string, right: string): boolean {
  const a = canonicalIp(left);
  const b = canonicalIp(right);
  return a !== null && b !== null && a === b;
}

/** True when `raw` is a literal loopback, unspecified, private, link-local, carrier-grade NAT, or multicast address. */
export function isNonPublicIp(raw: string): boolean {
  const ip = canonicalIp(raw);
  if (!ip) return false;
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 // 0.0.0.0/8 ("this host")
      || a === 10 // 10.0.0.0/8 (RFC 1918)
      || (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 (CGNAT)
      || a === 127 // 127.0.0.0/8 (loopback)
      || (a === 169 && b === 254) // 169.254.0.0/16 (link-local / cloud metadata)
      || (a === 172 && b >= 16 && b <= 31) // 172.16.0.0/12 (RFC 1918)
      || (a === 192 && b === 168) // 192.168.0.0/16 (RFC 1918)
      || (a === 198 && (b === 18 || b === 19)) // 198.18.0.0/15 (benchmark)
      || a >= 224; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  }
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (/^f[cd][0-9a-f]{2}(:|$)/.test(lower)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f](:|$)/.test(lower)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}(:|$)/.test(lower)) return true; // ff00::/8 multicast
  return false;
}
