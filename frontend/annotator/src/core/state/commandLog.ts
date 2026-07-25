/**
 * Command-log store scaffold: the engine's state is the result of an ordered
 * log of commands, which makes undo/redo native rather than bolted on.
 *
 * Interaction commands (drags commit on release, never per-move) land in a
 * later session; the log semantics are fixed now.
 */

export interface Command {
  /** Human-readable label, e.g. "move bbox 3f2a…". */
  readonly label: string;
  execute(): void;
  undo(): void;
}

export class CommandLog {
  private past: Command[] = [];
  private future: Command[] = [];

  /** Run a command and append it to the log. Clears the redo stack. */
  execute(command: Command): void {
    command.execute();
    this.past.push(command);
    this.future = [];
  }

  /** Undo the most recent command. Returns false if there is nothing to undo. */
  undo(): boolean {
    const command = this.past.pop();
    if (command === undefined) return false;
    command.undo();
    this.future.push(command);
    return true;
  }

  /** Re-apply the most recently undone command. Returns false if none. */
  redo(): boolean {
    const command = this.future.pop();
    if (command === undefined) return false;
    command.execute();
    this.past.push(command);
    return true;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
