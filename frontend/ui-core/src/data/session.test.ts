/**
 * Where the token lives.
 *
 * The last test is the one worth having. `sessionStorage` **throws** rather than
 * returning null when a browser refuses it — Safari in private browsing
 * historically, and any embedding with storage partitioned — and the access
 * happens during the first render, before an error boundary exists. An unguarded
 * read there is a blank page with a console message, which is the worst failure
 * shape there is. The fallback degrades the session to "until you reload" instead.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { clearToken, readToken, writeToken } from "./session";

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
  clearToken();
});

describe("the session token", () => {
  it("round-trips through sessionStorage", () => {
    expect(readToken()).toBeNull();
    writeToken("secret");
    expect(readToken()).toBe("secret");
    // Namespaced, so a page sharing the origin cannot collide with us.
    expect(globalThis.sessionStorage.getItem("visionset.token")).toBe("secret");
  });

  it("is forgotten on clear", () => {
    writeToken("secret");
    clearToken();
    expect(readToken()).toBeNull();
    expect(globalThis.sessionStorage.getItem("visionset.token")).toBeNull();
  });

  it("leaves nothing behind after the probe it uses to test availability", () => {
    writeToken("secret");
    expect(globalThis.sessionStorage.getItem("visionset.token.probe")).toBeNull();
  });

  it("degrades to memory rather than throwing when the browser refuses storage", () => {
    // Presence is not availability: the property exists and the *access* throws.
    const refusing = {
      getItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    };
    vi.stubGlobal("sessionStorage", refusing);

    expect(() => writeToken("secret")).not.toThrow();
    expect(readToken()).toBe("secret");
    expect(() => clearToken()).not.toThrow();
    expect(readToken()).toBeNull();
  });
});
