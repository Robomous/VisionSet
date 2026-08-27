import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toast } from "sonner";
import { Toaster } from "./sonner";

afterEach(() => document.documentElement.classList.remove("dark"));

// sonner only mounts `[data-sonner-toaster]` once a toast exists (it maps
// over `filteredToasts` and returns `null` for every position while that
// list is empty), and the theme it stamps on that element lands in
// `data-sonner-theme`, not `data-theme`. A toast is fired here to bring the
// element into being; `waitFor` covers the render sonner does outside this
// call stack when it flushes the toast through its module-global store.
describe("toaster theme", () => {
  it("is light when <html> carries no class", async () => {
    const { container } = render(<Toaster />);
    toast("hi");
    await waitFor(() => {
      expect(container.querySelector("[data-sonner-toaster]")?.getAttribute("data-sonner-theme")).toBe("light");
    });
  });
  it("is dark when <html> carries .dark", async () => {
    document.documentElement.classList.add("dark");
    const { container } = render(<Toaster />);
    toast("hi");
    await waitFor(() => {
      expect(container.querySelector("[data-sonner-toaster]")?.getAttribute("data-sonner-theme")).toBe("dark");
    });
  });
  it("follows <html> from light to dark after mount, via the MutationObserver", async () => {
    const { container } = render(<Toaster />);
    toast("hi");
    await waitFor(() => {
      expect(container.querySelector("[data-sonner-toaster]")?.getAttribute("data-sonner-theme")).toBe("light");
    });
    document.documentElement.classList.add("dark");
    await waitFor(() => {
      expect(container.querySelector("[data-sonner-toaster]")?.getAttribute("data-sonner-theme")).toBe("dark");
    });
  });
});
