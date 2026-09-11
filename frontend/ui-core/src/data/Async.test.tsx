/**
 * `Async`, the one component every screen's query result passes through.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Async } from "./Async";
import { ApiError } from "./errors";

describe("Async", () => {
  it("renders the empty state for the API's own list envelope", () => {
    render(
      <Async query={{ data: { items: [], total: 0 }, isPending: false, isError: false, error: null }} empty={{ title: "No projects yet" }}>
        {() => <span data-testid="rows" />}
      </Async>,
    );
    expect(screen.getByText("No projects yet")).not.toBeNull();
    expect(screen.queryByTestId("rows")).toBeNull();
  });

  it("does not guess emptiness when a screen did not ask for it", () => {
    // `dataset_stats` answers zeroes about a real dataset. Guessing would hide it.
    render(
      <Async query={{ data: { total: 0 }, isPending: false, isError: false, error: null }}>
        {() => <span data-testid="stats" />}
      </Async>,
    );
    expect(screen.queryByTestId("stats")).not.toBeNull();
  });

  it("shows skeletons while a query is pending, never children with no data", () => {
    render(
      <Async query={{ data: undefined, isPending: true, isError: false, error: null }}>
        {(data) => <span data-testid="boom">{JSON.stringify(data)}</span>}
      </Async>,
    );
    expect(screen.queryByTestId("boom")).toBeNull();
    expect(screen.getByText("Loading")).not.toBeNull();
  });

  /**
   * A kernel identifier is not a title.
   *
   * The error branch used to head itself with the `code`, so a person met
   * "SCHEMA_NOT_FOUND" where the sentence should be. The code is still on screen
   * and still selectable — it is what a bug report quotes — but on the meta line
   * under the sentence rather than instead of it.
   */
  const failing = (error: unknown) => ({
    data: undefined,
    isPending: false,
    isError: true,
    error,
  });

  it("leads with the sentence and keeps the code where a report can quote it", () => {
    render(
      <Async query={failing(new ApiError({ code: "SCHEMA_NOT_FOUND", message: "no schema" }, { status: 404 }))}>
        {() => <span data-testid="rows" />}
      </Async>,
    );
    expect(screen.getByText("This project has no labels yet — define them first.")).not.toBeNull();
    // Once, and on the meta line: anywhere else it would be the heading again.
    expect(screen.getAllByText("SCHEMA_NOT_FOUND")).toHaveLength(1);
    expect(screen.getByTestId("error-code").textContent).toBe("SCHEMA_NOT_FOUND");
  });

  it("keeps the server's own message for a code the vocabulary does not restate", () => {
    render(
      <Async
        query={failing(new ApiError({ code: "TEAPOT", message: "This server is a teapot." }, { status: 418 }))}
      >
        {() => <span data-testid="rows" />}
      </Async>,
    );
    expect(screen.getByText("This server is a teapot.")).not.toBeNull();
    expect(screen.getByTestId("error-code").textContent).toBe("TEAPOT");
  });

  it("says the code once when the last-resort sentence already carries it", () => {
    // No entry and no server message: `refusalProse` writes the code into the
    // sentence itself, and repeating it below would be the only thing on the line.
    render(
      <Async query={failing(new ApiError({ code: "TEAPOT", message: "" }, { status: 418 }))}>
        {() => <span data-testid="rows" />}
      </Async>,
    );
    expect(screen.getByText("The server refused this (TEAPOT).")).not.toBeNull();
    expect(screen.queryByTestId("error-code")).toBeNull();
  });

  it("puts the incident id beside the code, because a 5xx is reported by both", () => {
    render(
      <Async
        query={failing(
          new ApiError(
            { code: "WORKSPACE_BUSY", message: "", detail: { incident_id: "inc-42" } },
            { status: 503 },
          ),
        )}
      >
        {() => <span data-testid="rows" />}
      </Async>,
    );
    expect(screen.getByTestId("error-code").textContent).toBe("WORKSPACE_BUSY · Incident inc-42");
  });
});
