// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODE_SCRIPT, MODE_STORAGE_KEY, currentColorMode, setColorMode } from "./color-mode";

let deviceDark = false;
let store = new Map<string, string>();
let blocked = false;
// Node's own experimental localStorage shadows happy-dom's: a plain one per test
const storage = {
  getItem: (k: string) => {
    if (blocked) throw new Error("blocked");
    return store.get(k) ?? null;
  },
  setItem: (k: string, v: string): void => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
const listeners: (() => void)[] = [];
// One page runs the script once: disconnect the observers of earlier tests' runs
const observers: MutationObserver[] = [];
const RealObserver = window.MutationObserver;
class TrackedObserver extends RealObserver {
  constructor(cb: MutationCallback) {
    super(cb);
    observers.push(this);
  }
}

function runScript() {
  new Function(MODE_SCRIPT)();
}

beforeEach(() => {
  observers.splice(0).forEach((o) => o.disconnect());
  vi.stubGlobal("MutationObserver", TrackedObserver);
  deviceDark = false;
  listeners.length = 0;
  store = new Map();
  blocked = false;
  storage.setItem = (k: string, v: string) => void store.set(k, String(v));
  vi.stubGlobal("localStorage", storage);
  delete (window as { __aunSetMode?: unknown }).__aunSetMode;
  document.documentElement.className = "";
  vi.stubGlobal("matchMedia", (q: string) => ({
    get matches() {
      return q.includes("dark") && deviceDark;
    },
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("light / dark mode script", () => {
  it("first visit: follows the device, live", () => {
    deviceDark = true;
    runScript();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(currentColorMode()).toBe("dark");
    deviceDark = false;
    listeners.forEach((fn) => fn());
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("a saved choice wins over the device and survives a reload", () => {
    deviceDark = true;
    runScript();
    setColorMode("light");
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe("light");
    expect(currentColorMode()).toBe("light");
    // reload
    document.documentElement.className = "";
    runScript();
    expect(currentColorMode()).toBe("light");
    listeners.forEach((fn) => fn());
    expect(currentColorMode()).toBe("light");
  });

  it("resolves an old 'system' value once to the device's mode", () => {
    deviceDark = true;
    localStorage.setItem(MODE_STORAGE_KEY, "system");
    runScript();
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe("dark");
    expect(currentColorMode()).toBe("dark");
  });

  it("puts the mode back when something rewrites the class (React recovering from a hydration mismatch)", async () => {
    runScript();
    setColorMode("dark");
    document.documentElement.className = "fanous-street";
    await new Promise((r) => setTimeout(r, 0));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("fanous-street")).toBe(true);
  });

  it("keeps a choice for the page when storage is blocked", async () => {
    runScript();
    blocked = true;
    storage.setItem = () => {
      throw new Error("blocked");
    };
    setColorMode("dark");
    expect(currentColorMode()).toBe("dark");
    document.documentElement.className = "";
    await new Promise((r) => setTimeout(r, 0));
    expect(currentColorMode()).toBe("dark");
  });

  it("ignores anything else saved, and never throws when storage is blocked", () => {
    localStorage.setItem(MODE_STORAGE_KEY, "sepia");
    runScript();
    expect(currentColorMode()).toBe("light");
    blocked = true;
    expect(() => runScript()).not.toThrow();
  });
});
