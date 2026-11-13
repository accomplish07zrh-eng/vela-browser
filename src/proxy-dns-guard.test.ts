/**
 * Static guard for the account network path. The relay and its SOCKS client must never resolve a
 * destination on this computer, and must never open a socket to anything but the configured
 * upstream proxy. Only the upstream proxy's own host may be resolved here, as it always was. A
 * change that breaks either rule fails this test before it can reach a browser.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");
/** Source without comments, so prose about DNS does not count as code. */
function code(file: string): string {
  // Block comments, and line comments ("// " always has a space; a regex literal like /\/\// does not).
  return read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/\s.*$/gm, "$1");
}

/** Any way to resolve a name in Bun or Node. A promise's resolve() is not one. */
const RESOLVER = /\bnode:dns\b|\bfrom\s+["']dns["']|require\(\s*["']dns["']\s*\)|\bdns\s*\.|\blookup\s*[(:]|\bresolve(?:4|6|Any|Srv|Txt|Mx|Ns|Cname|Ptr|Naptr|Soa)\s*\(|\bBun\.dns\b|\bgetaddrinfo\b/;

test("the relay imports no resolver and resolves nothing", () => {
  expect(code("proxy-relay.ts")).not.toMatch(RESOLVER);
});

test("every socket the relay opens goes to the upstream proxy", () => {
  const source = code("proxy-relay.ts");
  const calls = [...source.matchAll(/\b(?:net|tls)\.(?:connect|createConnection)\s*\(/g)];
  const toUpstream = [...source.matchAll(/\b(?:net|tls)\.(?:connect|createConnection)\s*\(\s*\{\s*host:\s*up\.host,\s*port:\s*up\.port\b/g)];
  expect(calls.length).toBeGreaterThan(0);
  expect(toUpstream.length).toBe(calls.length);
  // No other way to open a socket.
  expect(source).not.toMatch(/\bnew\s+net\.Socket\b|\bBun\.connect\b|\bfetch\s*\(/);
});

test("the SOCKS client connects only to the proxy and asks it to resolve the name (ATYP 3)", () => {
  const source = code("geoip.ts");
  const start = source.indexOf("export async function openSocks5Tunnel");
  const end = source.indexOf("\nexport ", start + 1);
  const body = source.slice(start, end);
  expect(start).toBeGreaterThan(-1);
  expect(body).not.toMatch(RESOLVER);
  const connects = [...body.matchAll(/\bnetConnect\s*\(/g)];
  expect(connects.length).toBe(1);
  expect(body).toMatch(/netConnect\(\{\s*host:\s*proxy\.host,\s*port:\s*Number\(proxy\.port\)\s*\}\)/);
  expect(body).toMatch(/Buffer\.from\(\[5,\s*1,\s*0,\s*3,\s*domain\.length\]\)/);
  expect(body).not.toMatch(/Buffer\.from\(\[5,\s*1,\s*0,\s*[14],/);
});
