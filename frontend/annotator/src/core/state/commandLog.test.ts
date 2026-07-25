import { describe, expect, it } from "vitest";

import { CommandLog, type Command } from "./commandLog";

function noOp(label = "no-op"): Command {
  return { label, execute: () => undefined, undo: () => undefined };
}

describe("CommandLog", () => {
  it("undoes a no-op command", () => {
    const log = new CommandLog();
    log.execute(noOp());
    expect(log.canUndo).toBe(true);
    expect(log.undo()).toBe(true);
    expect(log.canUndo).toBe(false);
    expect(log.canRedo).toBe(true);
  });

  it("returns false when there is nothing to undo or redo", () => {
    const log = new CommandLog();
    expect(log.undo()).toBe(false);
    expect(log.redo()).toBe(false);
  });

  it("clears the redo stack when a new command is executed", () => {
    const log = new CommandLog();
    log.execute(noOp("a"));
    log.undo();
    log.execute(noOp("b"));
    expect(log.canRedo).toBe(false);
  });

  it("replays state through execute/undo/redo", () => {
    const values: number[] = [];
    const push: Command = {
      label: "push 1",
      execute: () => values.push(1),
      undo: () => values.pop(),
    };
    const log = new CommandLog();
    log.execute(push);
    log.undo();
    log.redo();
    expect(values).toEqual([1]);
  });
});
