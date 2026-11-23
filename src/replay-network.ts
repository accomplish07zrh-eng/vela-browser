/** Passive, metadata-only CDP collection for one selected tab and its related targets. */
export type ReplayRequestEvent = { key: string; time?: number } & (
  | { kind: "start"; url: string; method: string; origin: ReplayRequestOrigin; redirectStatus?: number }
  | { kind: "response"; status: number; fromServiceWorker: boolean }
  | { kind: "finish"; failure?: string }
);

interface ReplayRequestOrigin {
  target: "page" | "iframe" | "worker";
  frameId?: string;
  documentUrl?: string;
  targetUrl?: string;
  initiator?: string;
  location?: { url?: string; line?: number; column?: number };
}

export function diagnosticUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return (url.origin + url.pathname).slice(0, 512);
}

function locationFor(initiator: any) {
  let stack = initiator?.stack;
  for (let depth = 0; stack && depth < 4; depth++, stack = stack.parent) {
    const frame = stack.callFrames?.find((item: any) => diagnosticUrl(item.url));
    if (frame) return locationFields(frame);
  }
  return locationFields(initiator);
}

function locationFields(value: any) {
  const url = diagnosticUrl(value?.url);
  const line = Number.isSafeInteger(value?.lineNumber) && value.lineNumber >= 0 ? value.lineNumber + 1 : undefined;
  const column = Number.isSafeInteger(value?.columnNumber) && value.columnNumber >= 0 ? value.columnNumber + 1 : undefined;
  return url || line ? { url, line, column } : undefined;
}

const FILTER = [{ type: "iframe" }, { type: "worker" }, { exclude: true }];
const MAX_TARGETS = 16;
const INITIATORS = new Set(["parser", "script", "preload", "SignedExchange", "preflight", "other"]);

export class ReplayNetworkObserver {
  private readonly targets = new Map<string, { type: ReplayRequestOrigin["target"]; parent?: string; id?: string; url?: string }>();
  private stopped = false;

  constructor(
    private readonly root: string,
    private readonly send: (method: string, params: object, sessionId: string) => Promise<unknown>,
    private readonly emit: (event: ReplayRequestEvent) => void,
  ) { this.targets.set(root, { type: "page" }); }

  async start(): Promise<void> { await this.enable(this.root); }

  private async enable(sessionId: string): Promise<void> {
    await this.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }, sessionId);
    if (this.stopped || !this.targets.has(sessionId)) return;
    // Observe related frames and workers without pausing any target or attaching to other tabs.
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: FILTER }, sessionId).catch(() => {});
  }

  receive(message: any): void {
    const { sessionId, method, params } = message;
    const scope = this.targets.get(sessionId);
    if (!scope || this.stopped || !params) return;
    if (method === "Target.attachedToTarget") {
      const child = params.sessionId, type = params.targetInfo?.type;
      if (typeof child !== "string" || this.targets.has(child)) return;
      if (this.targets.size >= MAX_TARGETS || (type !== "iframe" && type !== "worker")) {
        void this.send("Target.detachFromTarget", { sessionId: child }, sessionId).catch(() => {});
        return;
      }
      this.targets.set(child, { type, parent: sessionId, id: params.targetInfo.targetId, url: diagnosticUrl(params.targetInfo.url) });
      void this.enable(child).catch(() => {});
      return;
    }
    if (method === "Target.detachedFromTarget") {
      this.removeTarget(params.sessionId);
      return;
    }
    if (method === "Target.targetInfoChanged") {
      for (const target of this.targets.values()) {
        if (target.id && target.id === params.targetInfo?.targetId) target.url = diagnosticUrl(params.targetInfo.url);
      }
      return;
    }
    if (method !== "Network.requestWillBeSent" && method !== "Network.responseReceived"
      && method !== "Network.loadingFinished" && method !== "Network.loadingFailed") return;
    if (typeof params.requestId !== "string") return;
    const key = JSON.stringify([sessionId, params.requestId]);
    const time = typeof params.timestamp === "number" && Number.isFinite(params.timestamp) ? params.timestamp * 1000 : undefined;
    if (method === "Network.requestWillBeSent") {
      const url = diagnosticUrl(params.request?.url);
      if (!url) return;
      const origin: ReplayRequestOrigin = { target: scope.type,
        frameId: typeof params.frameId === "string" ? params.frameId.slice(0, 80) : undefined,
        documentUrl: diagnosticUrl(params.documentURL),
        targetUrl: scope.url,
        initiator: INITIATORS.has(params.initiator?.type) ? params.initiator.type : undefined,
        location: locationFor(params.initiator) };
      this.emit({ kind: "start", key, time, url, method: String(params.request.method).slice(0, 16), origin,
        redirectStatus: params.redirectResponse?.status });
    } else if (method === "Network.responseReceived" && Number.isInteger(params.response?.status)) {
      this.emit({ kind: "response", key, time, status: params.response.status, fromServiceWorker: params.response.fromServiceWorker === true });
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      const failure = method === "Network.loadingFailed" ?
        (typeof params.errorText === "string" && /^net::ERR_[A-Z0-9_]{1,100}$/.test(params.errorText) ? params.errorText : "Request failed") : undefined;
      this.emit({ kind: "finish", key, time, failure });
    }
  }

  private removeTarget(sessionId: string): void {
    this.targets.delete(sessionId);
    for (const [child, item] of this.targets) if (item.parent === sessionId) this.removeTarget(child);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.targets.clear();
    await Promise.allSettled([
      this.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, this.root),
      this.send("Network.disable", {}, this.root),
    ]);
  }
}
