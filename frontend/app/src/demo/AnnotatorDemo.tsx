/**
 * The demo: a host for `<AnnotatorCanvas>`, and the proof that the embeddable
 * contract is real.
 *
 * Every piece of chrome here — the class palette, the undo buttons, the tag
 * panel, the shortcut sheet — is **outside** the annotator package. That is the
 * point rather than an accident of layout: the canvas takes a store, a picture and
 * an active class, and gives back callbacks. It fetches nothing, it routes
 * nothing, and it owns no UI a product would want to restyle.
 *
 * The store lives here, which is what lets these controls read exactly what the
 * canvas draws. `useAnnotatorStore` builds it from a wire payload — the same
 * shape `GET /jobs/{id}/assets/{asset_id}/annotations` returns — so the demo goes
 * through `documentFromWire` and the wire mirror is exercised on the way in.
 *
 * #48 ports v1's Playwright specs against this page and #50 polishes it into the
 * public showcase, so the `data-testid` hooks below are load-bearing and the
 * styling deliberately is not.
 */

import {
  AnnotatorCanvas,
  DEFAULT_BINDINGS,
  TOGGLE_HELP,
  annotationsInDrawOrder,
  classColor,
  hotkeyForClass,
  isTaggableClass,
  randomUuid,
  selectedAnnotations,
  taggedClassNames,
  toAnnotationCreate,
  toggleTagCommand,
  useAnnotatorSnapshot,
  useAnnotatorStore,
} from "@visionset/annotator";
import type { LabelClass } from "@visionset/annotator";
import { useState } from "react";
import type { CSSProperties, JSX, MouseEvent } from "react";

import { SAMPLE_ASSET, SAMPLE_IMAGE_SRC } from "./sampleAsset";
import { SAMPLE_SCHEMA } from "./sampleSchema";

/**
 * Keep the canvas focused when a control is clicked.
 *
 * A button that steals focus is a keyboard that stops working after the first
 * palette click, which is the single most annoying thing an editor can do. It
 * also keeps the canvas's `onBlur` — which cancels a drag in flight — for the
 * cases it is actually for: a window blur, or focus moving to the notes field.
 */
function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}

const PANEL: CSSProperties = {
  border: "1px solid #2b3648",
  borderRadius: 8,
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const BUTTON: CSSProperties = {
  font: "inherit",
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid #3d4c66",
  background: "#182130",
  color: "#dbe4f0",
  cursor: "pointer",
  textAlign: "left",
};

export function AnnotatorDemo(): JSX.Element {
  const store = useAnnotatorStore({
    asset: SAMPLE_ASSET,
    schema: SAMPLE_SCHEMA,
    annotations: [],
  });
  const snapshot = useAnnotatorSnapshot(store);
  const [activeClass, setActiveClass] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [notes, setNotes] = useState("");

  const schema = snapshot.document.schema;
  const tagged = taggedClassNames(snapshot.document);
  const selected = selectedAnnotations(snapshot.document, snapshot.selection);
  const drawn = annotationsInDrawOrder(snapshot.document);

  function toggleTag(labelClass: string): void {
    const command = toggleTagCommand(snapshot.document, labelClass, randomUuid);
    if (command !== null) store.execute(command);
  }

  /** The one capability the canvas hands out rather than owning. */
  function hostAction(name: string): boolean {
    if (name !== TOGGLE_HELP) return false;
    setShowHelp((open) => !open);
    return true;
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 300px",
        gap: 16,
        height: "100%",
        color: "#dbe4f0",
        font: "14px/1.45 system-ui, sans-serif",
      }}
    >
      <div style={{ position: "relative", border: "1px solid #2b3648", borderRadius: 8 }}>
        <AnnotatorCanvas
          store={store}
          imageSrc={SAMPLE_IMAGE_SRC}
          activeClass={activeClass}
          onActivateClass={setActiveClass}
          onHostAction={hostAction}
        />
        {showHelp && <Shortcuts onClose={() => setShowHelp(false)} />}
      </div>

      <aside style={{ display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
        <section style={PANEL} data-testid="palette">
          <strong>Classes</strong>
          <button
            type="button"
            style={{ ...BUTTON, outline: activeClass === null ? "2px solid #8fd3f4" : "none" }}
            data-testid="class-select"
            onMouseDown={keepFocus}
            onClick={() => setActiveClass(null)}
          >
            <kbd>V</kbd> select
          </button>
          {schema.classes.map((declared: LabelClass) => (
            <button
              key={declared.name}
              type="button"
              data-testid={`class-${declared.name}`}
              style={{
                ...BUTTON,
                outline: activeClass === declared.name ? "2px solid #8fd3f4" : "none",
                borderLeft: `6px solid ${classColor(declared, declared.name)}`,
              }}
              onMouseDown={keepFocus}
              onClick={() =>
                isTaggableClass(declared)
                  ? toggleTag(declared.name)
                  : setActiveClass(declared.name)
              }
            >
              <kbd>{hotkeyForClass(schema, declared.name) ?? "—"}</kbd> {declared.name}{" "}
              <span style={{ opacity: 0.6 }}>{declared.geometry}</span>
            </button>
          ))}
        </section>

        <section style={PANEL} data-testid="history">
          <strong>History</strong>
          <button
            type="button"
            style={BUTTON}
            data-testid="undo"
            disabled={!snapshot.canUndo}
            onMouseDown={keepFocus}
            onClick={() => store.undo()}
          >
            Undo {snapshot.undoLabel ?? ""}
          </button>
          <button
            type="button"
            style={BUTTON}
            data-testid="redo"
            disabled={!snapshot.canRedo}
            onMouseDown={keepFocus}
            onClick={() => store.redo()}
          >
            Redo {snapshot.redoLabel ?? ""}
          </button>
        </section>

        <section style={PANEL} data-testid="tags">
          <strong>Tags</strong>
          {schema.classes.filter(isTaggableClass).map((declared: LabelClass) => (
            <label key={declared.name} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                data-testid={`tag-${declared.name}`}
                checked={tagged.has(declared.name)}
                onMouseDown={keepFocus}
                onChange={() => toggleTag(declared.name)}
              />
              {declared.name}
            </label>
          ))}
        </section>

        <section style={PANEL}>
          <strong>State</strong>
          <div data-testid="counts">
            {drawn.length} annotation(s), {selected.length} selected
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ opacity: 0.7 }}>Notes — typing here must not draw anything</span>
            <input
              type="text"
              data-testid="notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              style={{ ...BUTTON, cursor: "text" }}
            />
          </label>
        </section>

        <section style={PANEL}>
          <strong>What would be saved</strong>
          <pre
            data-testid="wire"
            style={{ margin: 0, maxHeight: 220, overflow: "auto", fontSize: 11 }}
          >
            {JSON.stringify(drawn.map(toAnnotationCreate), null, 2)}
          </pre>
        </section>
      </aside>
    </div>
  );
}

/** The default table, rendered. It is data, so the sheet cannot go out of date. */
function Shortcuts({ onClose }: { readonly onClose: () => void }): JSX.Element {
  return (
    <div
      data-testid="shortcuts"
      style={{
        position: "absolute",
        inset: 24,
        background: "#0d1520f2",
        border: "1px solid #3d4c66",
        borderRadius: 8,
        padding: 20,
        overflow: "auto",
      }}
    >
      <button type="button" style={{ ...BUTTON, float: "right" }} onClick={onClose}>
        close
      </button>
      <strong>Shortcuts</strong>
      <table style={{ marginTop: 12, borderSpacing: "16px 4px" }}>
        <tbody>
          {DEFAULT_BINDINGS.map((binding) => (
            <tr key={binding.chord}>
              <td>
                <kbd>{binding.chord}</kbd>
              </td>
              <td style={{ opacity: 0.8 }}>{binding.action?.kind ?? "unbound"}</td>
            </tr>
          ))}
          <tr>
            <td>
              <kbd>1</kbd>–<kbd>9</kbd>
            </td>
            <td style={{ opacity: 0.8 }}>the schema&rsquo;s classes, in authored order</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
