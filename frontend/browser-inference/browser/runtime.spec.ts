/**
 * The built runtime, in a real Chromium, against a real ONNX graph.
 *
 * Everything here runs against `dist/` — the worker the build emitted, the ONNX Runtime
 * JavaScript compiled into it, and the WebAssembly artifacts the build step copied
 * beside it. The vitest suite under `src/` already proves the correlation table against
 * a controllable channel and can say nothing about any of that.
 */
import { expect, test } from "@playwright/test";

import { modelArgument, openHarness, workersStarted } from "./_support.ts";
import { SAMPLE_INPUT, SAMPLE_OUTPUT, tinyAddGraph } from "./tinyGraph.ts";

const MODEL = modelArgument(tinyAddGraph());

/** What the page needs to know to build a runtime: the module URL and the model bytes. */
interface Fixture {
  readonly model: number[];
  readonly input: readonly number[];
  /** Passed rather than closed over: Playwright serialises the callback, not its scope. */
  readonly adapterUrl: string;
  readonly coreUrl: string;
}


/**
 * The two built entry points, as the page asks for them.
 *
 * Typed as the *source* modules they are emitted from, which is what lets `tsc` check
 * these specs at all: `import("/dist/browser/index.js")` is an absolute URL with no
 * declaration behind it, so the specifier goes through a variable — which TypeScript
 * types as `any` rather than failing to resolve — and the cast supplies the real shape.
 * If the public surface changes, these casts stop matching and the suite fails to
 * compile, which is the point of naming the source rather than writing a `.d.ts` shim.
 */
const ADAPTER = "/dist/browser/index.js";
const CORE = "/dist/index.js";
type Adapter = typeof import("../src/browser/index.ts");
type Core = typeof import("../src/index.ts");

const fixture: Fixture = { model: MODEL, input: SAMPLE_INPUT, adapterUrl: ADAPTER, coreUrl: CORE };

test("runs a graph on the WASM path and returns the exact answer", async ({ page }) => {
  await openHarness(page);

  const answer = await page.evaluate(async ({ model, input, adapterUrl }: Fixture) => {
    const { createInferenceRuntime } = (await import(adapterUrl)) as Adapter;
    const runtime = createInferenceRuntime({ policy: "wasm-only" });
    const providers = await runtime.ready();
    const graph = await runtime.loadGraph(Uint8Array.from(model));
    const outputs = await runtime.run(graph, {
      x: { data: Float32Array.from(input), dims: [1, 4] },
    });
    runtime.dispose();
    return { providers, y: Array.from(outputs["y"]!.data) };
  }, fixture);

  expect(answer.providers).toEqual(["wasm"]);
  expect(answer.y).toEqual([...SAMPLE_OUTPUT]);
});

test("keeps one worker and one loaded graph across sequential runs", async ({ page }) => {
  await openHarness(page);

  const answers = await page.evaluate(async ({ model, input, adapterUrl }: Fixture) => {
    const { createInferenceRuntime } = (await import(adapterUrl)) as Adapter;
    const runtime = createInferenceRuntime({ policy: "wasm-only" });
    await runtime.ready();
    // Loaded once. A second worker would have an empty session map, so the second run
    // below could only succeed if the same worker answered it.
    const graph = await runtime.loadGraph(Uint8Array.from(model));

    const first = await runtime.run(graph, { x: { data: Float32Array.from(input), dims: [1, 4] } });
    const second = await runtime.run(graph, {
      x: { data: Float32Array.from(input.map((value) => value * 2)), dims: [1, 4] },
    });
    runtime.dispose();
    return { first: Array.from(first["y"]!.data), second: Array.from(second["y"]!.data) };
  }, fixture);

  expect(answers.first).toEqual([...SAMPLE_OUTPUT]);
  expect(answers.second).toEqual(SAMPLE_INPUT.map((value, at) => value * 2 + (at + 1)));
  expect(await workersStarted(page)).toBe(1);
});

test("settles concurrent runs with their own answers", async ({ page }) => {
  await openHarness(page);

  const answers = await page.evaluate(async ({ model, input, adapterUrl }: Fixture) => {
    const { createInferenceRuntime } = (await import(adapterUrl)) as Adapter;
    const runtime = createInferenceRuntime({ policy: "wasm-only" });
    await runtime.ready();
    const graph = await runtime.loadGraph(Uint8Array.from(model));

    const run = (scale: number): Promise<number[]> =>
      runtime
        .run(graph, { x: { data: Float32Array.from(input.map((v) => v * scale)), dims: [1, 4] } })
        .then((outputs) => Array.from(outputs["y"]!.data));

    // In flight together, so a client that settled by arrival order rather than by id
    // would hand at least one of these the other's answer.
    const [one, two, three] = await Promise.all([run(1), run(2), run(3)]);
    runtime.dispose();
    return { one, two, three };
  }, fixture);

  const expected = (scale: number): number[] => SAMPLE_INPUT.map((v, at) => v * scale + (at + 1));
  expect(answers.one).toEqual(expected(1));
  expect(answers.two).toEqual(expected(2));
  expect(answers.three).toEqual(expected(3));
  expect(await workersStarted(page)).toBe(1);
});

test("cancels a run without poisoning the runtime", async ({ page }) => {
  await openHarness(page);

  const outcome = await page.evaluate(async ({ model, input, adapterUrl, coreUrl }: Fixture) => {
    const { createInferenceRuntime } = (await import(adapterUrl)) as Adapter;
    // The error contract is core's, not the adapter's: `./browser` exports only the
    // three things that need a browser, so a caller reads codes from the root entry.
    const { isInferenceRuntimeError } = (await import(coreUrl)) as Core;
    const runtime = createInferenceRuntime({ policy: "wasm-only" });
    await runtime.ready();
    const graph = await runtime.loadGraph(Uint8Array.from(model));

    const controller = new AbortController();
    const cancelled = runtime.run(
      graph,
      { x: { data: Float32Array.from(input), dims: [1, 4] } },
      { signal: controller.signal },
    );
    controller.abort();

    let code = "did not reject";
    try {
      await cancelled;
    } catch (error) {
      code = isInferenceRuntimeError(error) ? error.code : `not a runtime error: ${String(error)}`;
    }

    // The worker's own answer for the cancelled operation arrives after this point and
    // must change nothing — including for the run that follows it.
    const afterwards = await runtime.run(graph, {
      x: { data: Float32Array.from(input), dims: [1, 4] },
    });
    runtime.dispose();
    return { code, afterwards: Array.from(afterwards["y"]!.data) };
  }, fixture);

  expect(outcome.code).toBe("cancelled");
  expect(outcome.afterwards).toEqual([...SAMPLE_OUTPUT]);
});

test("refuses every operation after disposal", async ({ page }) => {
  await openHarness(page);

  const codes = await page.evaluate(async ({ model, input, adapterUrl, coreUrl }: Fixture) => {
    const { createInferenceRuntime } = (await import(adapterUrl)) as Adapter;
    // The error contract is core's, not the adapter's: `./browser` exports only the
    // three things that need a browser, so a caller reads codes from the root entry.
    const { isInferenceRuntimeError } = (await import(coreUrl)) as Core;
    const runtime = createInferenceRuntime({ policy: "wasm-only" });
    await runtime.ready();
    const graph = await runtime.loadGraph(Uint8Array.from(model));

    // Outstanding at the moment of disposal, so it must be settled rather than left
    // pending on a worker that is about to stop existing.
    const outstanding = runtime.run(graph, {
      x: { data: Float32Array.from(input), dims: [1, 4] },
    });
    runtime.dispose();

    const codeOf = async (work: Promise<unknown>): Promise<string> => {
      try {
        await work;
        return "did not reject";
      } catch (error) {
        return isInferenceRuntimeError(error) ? error.code : `not a runtime error: ${String(error)}`;
      }
    };

    return {
      outstanding: await codeOf(outstanding),
      afterwards: await codeOf(
        runtime.run(graph, { x: { data: Float32Array.from(input), dims: [1, 4] } }),
      ),
    };
  }, fixture);

  expect(codes.outstanding).toBe("disposed");
  expect(codes.afterwards).toBe("disposed");
});

/**
 * WebGPU, whichever way this machine answers — and there are three answers, not two.
 *
 * `require-webgpu` is the only policy under which "WebGPU executed this" is a checkable
 * claim: under `prefer-webgpu` ONNX Runtime may place any individual operator on CPU and
 * is right to, so nothing run that way can be reported as a WebGPU execution.
 *
 * The three outcomes, each asserted rather than skipped:
 *
 * 1. `navigator.gpu` absent — the runtime must refuse with `webgpu-unavailable`, its own
 *    vocabulary, before it starts anything.
 * 2. `navigator.gpu` present **and an adapter is obtainable** — it must execute and match
 *    the WASM arithmetic exactly.
 * 3. `navigator.gpu` present and **no adapter** — ONNX Runtime must refuse at session
 *    creation, surfacing as `graph-load-failed`.
 *
 * Three is not a loophole; it is the point. Capability detection reports what the
 * environment *declares*, and the whole reason `RuntimeEnvironment.hasWebGpu` is
 * documented as "`navigator.gpu` exists, and nothing more" is that case 3 is real. This
 * repository's headless Chromium is case 3, which is why the distinction got written down
 * rather than assumed away. A skip here would let a regression in the refusal path pass
 * unnoticed on exactly the machines that run this suite.
 */
test("requires WebGPU, or refuses in its own vocabulary", async ({ page }) => {
  await openHarness(page);

  const outcome = await page.evaluate(async ({ model, input, adapterUrl, coreUrl }: Fixture) => {
    const { createInferenceRuntime } = (await import(adapterUrl)) as Adapter;
    // The error contract is core's, not the adapter's: `./browser` exports only the
    // three things that need a browser, so a caller reads codes from the root entry.
    const { isInferenceRuntimeError } = (await import(coreUrl)) as Core;
    const declared = "gpu" in navigator && navigator.gpu != null;
    // Asked directly, so the test can tell "no WebGPU here" from "WebGPU that cannot
    // give us a device" — ORT reports both as a failed session.
    let adapter = false;
    if (declared) {
      try {
        adapter = (await navigator.gpu.requestAdapter()) !== null;
      } catch {
        adapter = false;
      }
    }

    try {
      const runtime = createInferenceRuntime({ policy: "require-webgpu" });
      const providers = await runtime.ready();
      const graph = await runtime.loadGraph(Uint8Array.from(model));
      const outputs = await runtime.run(graph, {
        x: { data: Float32Array.from(input), dims: [1, 4] },
      });
      runtime.dispose();
      return {
        declared,
        adapter,
        executed: true,
        providers,
        y: Array.from(outputs["y"]!.data),
        code: null,
      };
    } catch (error) {
      return {
        declared,
        adapter,
        executed: false,
        providers: null,
        y: null,
        code: isInferenceRuntimeError(error) ? error.code : `not a runtime error: ${String(error)}`,
      };
    }
  }, fixture);

  console.log(
    `[webgpu] navigator.gpu ${outcome.declared ? "present" : "absent"}, adapter ` +
      `${outcome.adapter ? "obtained" : "unavailable"} -> require-webgpu ` +
      `${outcome.executed ? "EXECUTED ON WEBGPU" : `refused with ${String(outcome.code)}`}`,
  );

  if (!outcome.declared) {
    // Case 1: refused in the runtime's own vocabulary, before anything started.
    expect(outcome.executed).toBe(false);
    expect(outcome.code).toBe("webgpu-unavailable");
  } else if (outcome.adapter) {
    // Case 2: the only branch that licenses the claim "WebGPU ran this".
    expect(outcome.executed).toBe(true);
    expect(outcome.providers).toEqual(["webgpu"]);
    expect(outcome.y).toEqual([...SAMPLE_OUTPUT]);
  } else {
    // Case 3: declared but unusable. The runtime cannot know this in advance, so the
    // refusal is ONNX Runtime's, arriving through the error contract rather than raw.
    expect(outcome.executed).toBe(false);
    expect(outcome.code).toBe("graph-load-failed");
  }
});
