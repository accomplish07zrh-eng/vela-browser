/**
 * Taskbar-hidden mode (Windows).
 *
 * Environment windows are watched and driven from the workbench, so a taskbar button per browser
 * is clutter, and its title shows which sites are open to anyone looking at the screen.
 *
 * The mode changes one thing only: whether the taskbar lists the window. It asks the taskbar
 * itself to drop the button (ITaskbarList::DeleteTab). The window is never hidden, minimized,
 * moved, restyled or reordered, and the browser runs with exactly the same flags, so neither the
 * page nor the browser can observe the mode: visibility, focus, timers, painting, screen position
 * and the window stack are all as they would be without it. Alt+Tab still lists the window,
 * because removing it from there requires a style change that the page would see.
 */
import type { ProfileStore } from "./store.ts";

const GW_OWNER = 4;
/** Top-level browser frames: Chromium and Firefox. Helper and message windows are left alone. */
const BROWSER_CLASSES = new Set(["Chrome_WidgetWin_1", "MozillaWindowClass"]);

interface Taskbar {
  /** The processes and every process they started (a browser may hand its window to a child). */
  family(pids: Set<number>): Set<number>;
  windowsOf(pids: Set<number>): number[];
  remove(hwnd: number): boolean;
  restore(hwnd: number): boolean;
}

let native: Taskbar | null | undefined;

function guid(text: string): Uint8Array {
  const hex = text.replace(/[{}-]/g, "");
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, parseInt(hex.slice(0, 8), 16), true);
  view.setUint16(4, parseInt(hex.slice(8, 12), 16), true);
  view.setUint16(6, parseInt(hex.slice(12, 16), 16), true);
  for (let index = 0; index < 8; index++) bytes[8 + index] = parseInt(hex.slice(16 + index * 2, 18 + index * 2), 16);
  return bytes;
}

/** Loads user32, ole32 and the shell's ITaskbarList once; null where unavailable. */
async function taskbar(): Promise<Taskbar | null> {
  if (native !== undefined) return native;
  native = null;
  if (process.platform !== "win32" || typeof Bun === "undefined") return native;
  try {
    const { dlopen, FFIType, JSCallback, CFunction, ptr, read } = await import("bun:ffi");
    const user32 = dlopen("user32.dll", {
      EnumWindows: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
      GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
      IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetWindow: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
      GetClassNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    }).symbols;
    const kernel32 = dlopen("kernel32.dll", {
      CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
      Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
    const ole32 = dlopen("ole32.dll", {
      CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      CoCreateInstance: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
    ole32.CoInitializeEx(null, 0x2); // apartment-threaded; S_FALSE when already initialized is fine
    const clsid = guid("56FDF344-FD6D-11d0-958A-006097C9A090"); // CLSID_TaskbarList
    const iid = guid("56FDF342-FD6D-11d0-958A-006097C9A090"); // IID_ITaskbarList
    const out = new BigUint64Array(1);
    if (ole32.CoCreateInstance(ptr(clsid), null, 0x1 /* CLSCTX_INPROC_SERVER */, ptr(iid), ptr(out)) < 0 || !out[0]) return native;
    const list = Number(out[0]);
    const vtable = read.ptr(list as never, 0);
    const method = (index: number, args: Array<(typeof FFIType)[keyof typeof FFIType]>) =>
      CFunction({ ptr: read.ptr(vtable as never, index * 8) as never, args: args as never, returns: FFIType.i32 });
    // ITaskbarList: QueryInterface, AddRef, Release, HrInit, AddTab, DeleteTab, ActivateTab, SetActiveAlt
    const hrInit = method(3, [FFIType.ptr]);
    const addTab = method(4, [FFIType.ptr, FFIType.ptr]);
    const deleteTab = method(5, [FFIType.ptr, FFIType.ptr]);
    if ((hrInit as unknown as (self: number) => number)(list) < 0) return native;

    const pidBuffer = new Uint32Array(1);
    const classBuffer = new Uint16Array(64);
    const className = (hwnd: number) => {
      const length = user32.GetClassNameW(hwnd as never, ptr(classBuffer), classBuffer.length);
      return String.fromCharCode(...classBuffer.subarray(0, Math.max(0, length)));
    };
    // PROCESSENTRY32W on 64-bit Windows: 568 bytes, process id at 8, parent process id at 32.
    const entry = new Uint8Array(568);
    const entryView = new DataView(entry.buffer);
    native = {
      family(pids) {
        const parents = new Map<number, number>();
        const snapshot = kernel32.CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
        if (!snapshot || Number(snapshot) === -1) return pids;
        try {
          entryView.setUint32(0, entry.length, true);
          for (let ok = kernel32.Process32FirstW(snapshot, ptr(entry)); ok; ok = kernel32.Process32NextW(snapshot, ptr(entry))) {
            parents.set(entryView.getUint32(8, true), entryView.getUint32(32, true));
          }
        } finally {
          kernel32.CloseHandle(snapshot);
        }
        const family = new Set(pids);
        for (let grew = true; grew;) {
          grew = false;
          for (const [pid, parent] of parents) if (!family.has(pid) && family.has(parent)) { family.add(pid); grew = true; }
        }
        return family;
      },
      windowsOf(pids) {
        const found: number[] = [];
        const visit = new JSCallback((hwnd: number) => {
          user32.GetWindowThreadProcessId(hwnd as never, ptr(pidBuffer));
          if (pids.has(pidBuffer[0]!) && user32.IsWindowVisible(hwnd as never) && !user32.GetWindow(hwnd as never, GW_OWNER)
            && BROWSER_CLASSES.has(className(hwnd))) found.push(hwnd);
          return 1;
        }, { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 });
        try { user32.EnumWindows(visit.ptr as never, 0); } finally { visit.close(); }
        return found;
      },
      remove: (hwnd) => (deleteTab as unknown as (self: number, hwnd: number) => number)(list, hwnd) >= 0,
      restore: (hwnd) => (addTab as unknown as (self: number, hwnd: number) => number)(list, hwnd) >= 0,
    };
  } catch {
    native = null;
  }
  return native;
}

/** True where the mode can work: Windows desktop builds. */
export function taskbarModeSupported(): boolean {
  return process.platform === "win32";
}

/** Removes (or restores) the taskbar buttons of the given browser processes' windows. */
export async function applyTaskbarMode(pids: Iterable<number>, hidden: boolean): Promise<number> {
  const api = await taskbar();
  const wanted = new Set([...pids].filter((pid) => Number.isSafeInteger(pid) && pid > 0));
  if (!api || !wanted.size) return 0;
  let changed = 0;
  for (const hwnd of api.windowsOf(api.family(wanted))) if (hidden ? api.remove(hwnd) : api.restore(hwnd)) changed++;
  return changed;
}

/**
 * Keeps every running environment in step with the setting. The taskbar can add a button back
 * (a new window, a window shown again), so each sweep removes them again; asking twice is harmless.
 */
export class TaskbarMode {
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private applied = false;

  constructor(private readonly options: { store: ProfileStore; enabled: () => boolean; intervalMs?: number; log?: (message: string) => void }) {}

  start(): void {
    if (!taskbarModeSupported() || this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, this.options.intervalMs ?? 1000);
    void this.sweep();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs now, e.g. right after the setting changed. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const enabled = this.options.enabled();
      // Turning the mode off brings the buttons back once; after that there is nothing to do.
      if (!enabled && !this.applied) return;
      const pids = this.options.store.listLaunches().map((launch) => launch.pid);
      await applyTaskbarMode(pids, enabled);
      if (this.applied !== enabled) this.options.log?.(`taskbar mode ${enabled ? "on" : "off"}`);
      this.applied = enabled;
    } catch (error) {
      this.options.log?.(`taskbar mode sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sweeping = false;
    }
  }
}
