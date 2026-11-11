import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { startProxyRelay } from "../proxy-relay.ts";

const trusted = process.argv.includes("--trusted");
const certificate = new URL("../test-fixtures/proxy-relay/certificate.pem", import.meta.url);
const key = new URL("../test-fixtures/proxy-relay/test-only-key.pem", import.meta.url);
const sockets = new Set(), headers = [];
const upstream = tls.createServer({ cert: readFileSync(certificate), key: readFileSync(key) }, (socket) => {
  sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => socket.destroy());
  let buffer = "";
  const read = (chunk) => {
    buffer += chunk.toString(); const end = buffer.indexOf("\r\n\r\n"); if (end < 0) return;
    socket.removeListener("data", read); headers.push(buffer.slice(0, end));
    if (buffer.startsWith("CONNECT ")) {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n"); socket.on("data", (bytes) => socket.write(bytes));
    } else socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi");
  };
  socket.on("data", read);
});
upstream.on("tlsClientError", () => {});
await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
const relay = await startProxyRelay({ type: "https", host: "127.0.0.1", port: upstream.address().port, user: "puser", pass: "ppass" });
async function exchange(request, tunnel = false) {
  return new Promise((done, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: relay.port });
    let output = "", echoed = false;
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("TLS fixture timed out")); });
    socket.on("error", reject); socket.once("connect", () => socket.write(request));
    socket.on("data", (bytes) => {
      output += bytes.toString();
      if (tunnel && !echoed && output.includes("200 Connection established")) { echoed = true; socket.write("tls-tunnel-echo"); }
      if (output.endsWith("tls-tunnel-echo")) socket.destroy();
    });
    socket.once("close", () => done(output));
  });
}
try {
  const http = await exchange("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: browser-value\r\n\r\n");
  const tunnel = await exchange("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n", true);
  if (trusted) {
    assert.ok(http.endsWith("hi")); assert.ok(tunnel.endsWith("tls-tunnel-echo")); assert.equal(headers.length, 2);
    assert.ok(headers.every((value) => value.includes(`Proxy-Authorization: Basic ${Buffer.from("puser:ppass").toString("base64")}`)));
    assert.ok(headers.every((value) => !value.includes("browser-value")));
  } else { assert.equal(http, ""); assert.equal(tunnel, ""); assert.equal(headers.length, 0); }
  console.log(JSON.stringify({ trusted, passed: true, forwarded: headers.length }));
} finally {
  relay.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((done) => upstream.close(done));
}
