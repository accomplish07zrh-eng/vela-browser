import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const trusted of [false, true]) test(`HTTPS relay validates TLS trust before sending proxy credentials (trusted=${trusted})`, async () => {
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS; delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (trusted) env.NODE_EXTRA_CA_CERTS = fileURLToPath(new URL("./test-fixtures/proxy-relay/certificate.pem", import.meta.url));
  const child = Bun.spawn([process.execPath, "scripts/proxy-relay-tls-fixture.mjs", ...(trusted ? ["--trusted"] : [])], { cwd: import.meta.dir, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ trusted, passed: true, forwarded: trusted ? 2 : 0 });
}, 15_000);
