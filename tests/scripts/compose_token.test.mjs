// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// The dev stack has to hand the hub credential to the container that fetches weights,
// because some published models are served only to accounts that have been granted
// them. Without it the failure is the bad kind rather than a loud one: the refusal
// names `HF_TOKEN`, the reader exports it on the host, the container never sees it,
// and the identical refusal comes back with nothing about it changed. A refusal
// naming a remedy nobody in that position can take is the mistake `NotAWorkspace` is
// the standing example of.
//
// Asserted by reading the files rather than by rendering them, deliberately: `docker
// compose config` needs a Docker daemon, and CI's `frontend` job has none. What that
// costs is the *rendering*, which is why the second test below pins the one property
// a text read could otherwise miss — that neither overlay replaces the block the
// variable lives in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (name) => readFileSync(join(ROOT, "docker", name), "utf8");

const BASE = "compose.yaml";
/** The two ways to get a runtime that downloads weights at all. */
const OVERLAYS = ["compose.cpu-inference.yaml", "compose.gpu.yaml"];

test("the api service forwards the hub credential from whoever ran compose", () => {
  // `${HF_TOKEN:-}` rather than a bare value: it is the host's to supply, and the
  // empty default is what keeps a machine with no token running every ungated model
  // exactly as before instead of failing to start.
  assert.match(
    read(BASE),
    /^\s*HF_TOKEN:\s*\$\{HF_TOKEN:-\}\s*$/m,
    "docker/compose.yaml must forward HF_TOKEN to the api service",
  );
});

test("neither inference overlay replaces the block that carries it", () => {
  // This is the half a grep for the variable cannot see. Both overlays amend the same
  // `api` service the base defines, and Compose merges mappings key by key — so an
  // overlay is free to add to `environment` and would be overwriting nothing. What
  // would silently drop the credential from one stack and not the other is an overlay
  // that grew its own `environment:` and a reader assuming it merged.
  for (const overlay of OVERLAYS) {
    const text = read(overlay);
    assert.ok(
      !/^\s*environment:/m.test(text),
      `docker/${overlay} declares its own environment: — re-check that HF_TOKEN survives ` +
        "the merge, and say so here, because the base is no longer the only place it lives",
    );
  }
});

test("every stack that can fetch weights is built on the base that carries the token", () => {
  // The overlays are `-f` amendments rather than standalone stacks, which is the only
  // reason the base's environment reaches them at all. An overlay that stopped naming
  // the same service would start a second one beside `api` instead of amending it.
  for (const overlay of OVERLAYS) {
    assert.match(
      read(overlay),
      /^services:\s*$\n^\s+api:\s*$/m,
      `docker/${overlay} must amend the base's own api service`,
    );
  }
});
