/**
 * Empty this suite's workspace, through the routes the product publishes.
 *
 * The workspace is built once per *server* start — `scripts/cycle_server.sh`
 * `rm -rf`s it and runs `visionset init`, and `playwright.cycle.config.ts` starts
 * that script once as its `webServer`. So every attempt after the first inherits
 * the one before it, and the walk's third step asserts Home's first-run
 * invitation, which is gated on the workspace holding no projects at all.
 * Without this, a retry could never reach whatever failed: it died on that
 * assertion, three steps in, naming a screen that had nothing to do with the
 * failure — and the trace, screenshot and video a person opens are the retry's.
 *
 * Deleting through the API rather than the filesystem is what makes it possible
 * at all. The server owns the workspace for as long as it runs, and `webServer`
 * is Playwright's to start and stop.
 *
 * A project delete takes its dataset, batches, jobs, sources and releases with
 * it; connections are the only other workspace-level row this walk creates.
 * Content blobs survive both, deliberately — they are shared and the delete
 * route never removes them — so a repeated walk re-ingests the same three
 * fixture images into a new dataset rather than into a new store.
 */
import { expect, type APIRequestContext } from "@playwright/test";

/** The shape both listings answer with. Neither takes a paging parameter. */
interface Listing {
  items: { id: string; name: string }[];
  total: number;
}

async function listing(
  request: APIRequestContext,
  path: string,
  headers: Record<string, string>,
): Promise<Listing> {
  const response = await request.get(path, { headers });
  expect(response.ok(), `GET ${path} answered ${response.status()}`).toBe(true);
  const page = (await response.json()) as Listing;
  /*
   * One read is the whole collection, and that is asserted rather than assumed.
   * A reset that quietly cleared only the first page would put this suite back
   * exactly where it started — the next attempt failing on a stale screen three
   * steps later, which is the failure this file exists to remove and is harder
   * to see the second time.
   */
  expect(page.items.length, `GET ${path} returned a partial page`).toBe(page.total);
  return page;
}

/**
 * Delete every project and every inference connection, and assert each answer.
 *
 * Loud on purpose: a reset that half-succeeds must fail at the reset, where the
 * cause is on screen, rather than leaving the walk to fail somewhere that cannot
 * name it.
 */
export async function emptyWorkspace(request: APIRequestContext, bearer: string): Promise<void> {
  const headers = { Authorization: `Bearer ${bearer}` };

  for (const project of (await listing(request, "/projects", headers)).items) {
    // The kernel refuses to destroy data without `confirm`, and answers 409.
    const response = await request.delete(`/projects/${project.id}`, {
      headers,
      params: { confirm: true },
    });
    expect(response.status(), `DELETE project ${project.name}`).toBe(204);
  }

  for (const connection of (await listing(request, "/inference/connections", headers)).items) {
    // No confirmation gate here, unlike a project: nothing holds a key to a
    // connection, because an annotation copies its model's identity at write
    // time. What is destroyed is a configuration.
    const response = await request.delete(`/inference/connections/${connection.id}`, { headers });
    expect(response.status(), `DELETE connection ${connection.name}`).toBe(204);
  }
}
