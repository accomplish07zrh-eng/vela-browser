import type { FingerprintSample } from "./diagnose.ts";

export interface FingerprintContextSample {
  context: "window" | "iframe" | "cross-origin-iframe" | "worker" | "shared-worker" | "service-worker";
  sample?: FingerprintSample;
  unavailable?: string;
}

/** Read-only QA probe, serialized into an isolated fixture page. Never overrides an API. */
export async function fingerprintContextProbe(source: string, origin: string): Promise<FingerprintContextSample[]> {
  const probe = (0, eval)(`(${source})`) as (options: { details: boolean }) => Promise<FingerprintSample>;
  const results: FingerprintContextSample[] = [{ context: "window", sample: await probe({ details: true }) }];
  for (const [context, base] of [["iframe", origin], ["cross-origin-iframe", origin.replace("127.0.0.1", "localhost")]] as const) {
    const frame = document.createElement("iframe");
    try {
      const sample = await new Promise<FingerprintSample>((resolve, reject) => {
        const timer = setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("iframe probe timed out")); }, 15000);
        const receive = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow || event.origin !== new URL(base).origin || event.data?.type !== "vela-fingerprint-sample") return;
          clearTimeout(timer); window.removeEventListener("message", receive);
          if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.sample);
        };
        window.addEventListener("message", receive);
        frame.src = `${base}/frame`; document.body.appendChild(frame);
      });
      results.push({ context, sample });
    } catch (error) { results.push({ context, unavailable: String(error) }); }
    finally { frame.remove(); }
  }
  for (const context of ["worker", "shared-worker"] as const) {
    const Constructor = context === "worker" ? globalThis.Worker : globalThis.SharedWorker;
    if (typeof Constructor !== "function") { results.push({ context, unavailable: "API unavailable" }); continue; }
    const program = context === "worker"
      ? `(${source})({details:true}).then(sample=>postMessage({sample}),error=>postMessage({error:String(error)}))`
      : `onconnect=async event=>{const port=event.ports[0];try{port.postMessage({sample:await (${source})({details:true})})}catch(error){port.postMessage({error:String(error)})}finally{port.close();close()}}`;
    const url = URL.createObjectURL(new Blob([program], { type: "text/javascript" }));
    let worker: Worker | SharedWorker | undefined;
    try {
      const sample = await new Promise<FingerprintSample>((resolve, reject) => {
        worker = new Constructor(url);
        const endpoint = "port" in worker ? worker.port : worker;
        const timer = setTimeout(() => reject(new Error("worker probe timed out")), 15000);
        endpoint.onmessage = (event) => { clearTimeout(timer); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.sample); };
        worker.onerror = () => { clearTimeout(timer); reject(new Error("worker probe failed")); };
        if ("start" in endpoint) endpoint.start();
      });
      results.push({ context, sample });
    } catch (error) { results.push({ context, unavailable: String(error) }); }
    finally { if (worker && "terminate" in worker) worker.terminate(); else if (worker) worker.port.close(); URL.revokeObjectURL(url); }
  }
  if (!navigator.serviceWorker) results.push({ context: "service-worker", unavailable: "API unavailable" });
  else {
    let registration: ServiceWorkerRegistration | undefined;
    try {
      registration = await navigator.serviceWorker.register(`${origin}/service-worker.js`, { scope: `/probe-${crypto.randomUUID()}/` });
      const active = await new Promise<ServiceWorker>((resolve, reject) => {
        const worker = registration!.active ?? registration!.installing ?? registration!.waiting;
        if (!worker) { reject(new Error("Service Worker missing")); return; }
        if (worker.state === "activated") { resolve(worker); return; }
        const timer = setTimeout(() => reject(new Error("Service Worker activation timed out")), 15000);
        worker.addEventListener("statechange", () => { if (worker.state === "activated") { clearTimeout(timer); resolve(worker); } });
      });
      const sample = await new Promise<FingerprintSample>((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); reject(new Error("Service Worker probe timed out")); }, 15000);
        channel.port1.onmessage = (event) => { clearTimeout(timer); channel.port1.close(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.sample); };
        active.postMessage({}, [channel.port2]);
      });
      results.push({ context: "service-worker", sample });
    } catch (error) { results.push({ context: "service-worker", unavailable: String(error) }); }
    finally { await registration?.unregister().catch(() => {}); }
  }
  return results;
}
