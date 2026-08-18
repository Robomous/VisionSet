// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// The dev stack's built services run as whoever ran `docker compose`, not as root,
// because all three bind-mount part of the checkout read-write. A root process there
// writes root-owned files into somebody's working tree, and none of the failures that
// follow points back at the cause: `pnpm -r build` dies on EACCES, `check.sh docs`
// fails naming documents nobody edited, and `git worktree remove` gives up partway
// through having already dropped the registration.
//
// What is asserted here is the whole arrangement rather than the one obvious line,
// because each half is useless alone. `user:` decides who writes the host; the build
// args decide who owns the image the container then has to write *into*. A service
// carrying one and not the other starts and dies.
//
// Asserted by reading the files rather than by rendering them, for the reason
// compose_token.test.mjs gives: `docker compose config` needs a Docker daemon, and
// CI's `frontend` job has none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (name) => readFileSync(join(ROOT, "docker", name), "utf8");

const BASE = "compose.yaml";
/** The two files that amend `api` rather than adding a service beside it. */
const OVERLAYS = ["compose.cpu-inference.yaml", "compose.gpu.yaml"];
/** Every image the stack builds. A new one has to answer this gate too. */
const DOCKERFILES = [
  "api.Dockerfile",
  "api-cpu-inference.Dockerfile",
  "api-gpu.Dockerfile",
  "app.Dockerfile",
  "docs.Dockerfile",
];

/** The one spelling, so a service cannot drift to a literal that ignores the host. */
const IDENTITY = '"${VISIONSET_UID:-1000}:${VISIONSET_GID:-1000}"';

/**
 * The services block, by indentation. A parser would be the obvious tool and is the
 * wrong trade here: no YAML library is resolvable from the repository root, and adding
 * one is a lockfile change under the three-day cool-down — for a file whose indentation
 * is uniform and entirely this repository's own.
 */
function services(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^services:\s*$/.test(l));
  assert.notEqual(start, -1, "docker/compose.yaml must declare services:");

  const found = new Map();
  let name = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // a top-level key ends the block
    const header = line.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (header) {
      name = header[1];
      found.set(name, { volumes: [], body: [] });
      continue;
    }
    if (name) found.get(name).body.push(line);
  }

  for (const [, svc] of found) {
    const at = svc.body.findIndex((l) => /^ {4}volumes:\s*$/.test(l));
    if (at === -1) continue;
    for (const line of svc.body.slice(at + 1)) {
      if (/^ {4}\S/.test(line)) break; // the next key at service level
      const item = line.match(/^ {6}- (.+?)\s*$/);
      if (item) svc.volumes.push(item[1]);
    }
  }
  return found;
}

/** A host path mounted writable — the only thing that can leave a file behind. */
const writesTheHost = (v) => /^\.{1,2}\//.test(v) && !v.endsWith(":ro");

test("every service that writes the host runs as the invoking user", () => {
  const exposed = [];
  for (const [name, svc] of services(read(BASE))) {
    if (svc.volumes.some(writesTheHost)) exposed.push([name, svc]);
  }

  // The rule selects rather than lists, so a service that grows a writable mount is
  // caught by the same line. Stated as a floor as well, because a walker that stopped
  // parsing would otherwise report an empty set as compliance.
  assert.ok(
    exposed.length >= 3,
    `expected at least the three built services to mount the checkout writable, found ${exposed.length}`,
  );

  for (const [name, svc] of exposed) {
    const user = svc.body.find((l) => /^ {4}user:/.test(l));
    assert.ok(
      user,
      `docker/compose.yaml: service '${name}' bind-mounts the checkout read-write and ` +
        "must declare user:, or it writes root-owned files into somebody's tree",
    );
    assert.equal(
      user.replace(/^ {4}user:\s*/, "").trim(),
      IDENTITY,
      `docker/compose.yaml: service '${name}' must spell user: ${IDENTITY} — a literal ` +
        "passes the rule above while ignoring every host whose uid is not 1000",
    );
  }
});

test("the image each of them builds bakes the same identity", () => {
  // The half a grep for `user:` cannot see. Running as uid N against an image whose
  // /workspace belongs to root gets a container that starts and then fails on its
  // first write — so the build args are not decoration, they are the other half.
  for (const [name, svc] of services(read(BASE))) {
    if (!svc.volumes.some(writesTheHost)) continue;
    const body = svc.body.join("\n");
    for (const arg of ["VISIONSET_UID", "VISIONSET_GID"]) {
      assert.match(
        body,
        new RegExp(`^\\s+${arg}: \\$\\{${arg}:-1000\\}\\s*$`, "m"),
        `docker/compose.yaml: service '${name}' must pass ${arg} to build.args, so the ` +
          "uid baked into the image cannot disagree with the uid it runs as",
      );
    }
  }
});

test("neither inference overlay drops the identity when it merges", () => {
  // Compose merges mappings key by key, so an overlay that only replaces
  // `build.dockerfile` leaves `build.args` and `user:` intact. That is an assumption
  // about the merge rather than something visible in either file, and a second thing
  // now depends on it.
  for (const overlay of OVERLAYS) {
    const text = read(overlay);
    assert.ok(
      !/^\s*user:/m.test(text),
      `docker/${overlay} declares its own user: — the base's is what should reach the ` +
        "merged service, and two spellings can disagree",
    );
    assert.ok(
      !/^\s*args:/m.test(text),
      `docker/${overlay} declares its own build.args: — re-check that VISIONSET_UID ` +
        "survives the merge, and say so there, because the base is no longer the only " +
        "place it lives",
    );
  }
});

test("every image the stack builds accepts the identity and drops to it", () => {
  // Catches the half-done addition: a new service wired into compose against an image
  // that still ends as root.
  for (const name of DOCKERFILES) {
    const text = read(name);
    for (const arg of ["VISIONSET_UID", "VISIONSET_GID"]) {
      assert.match(
        text,
        new RegExp(`^ARG ${arg}=1000\\s*$`, "m"),
        `docker/${name} must declare ARG ${arg}=1000`,
      );
    }
    assert.match(
      text,
      /^USER \S+\s*$/m,
      `docker/${name} must end as a non-root user, or compose's user: has nothing ` +
        "writable to land on",
    );
  }
});
