/**
 * The showcase: a host for `<AnnotatorCanvas>`, and the proof that the embeddable
 * contract is real.
 *
 * Every piece of chrome here — the tool strip, the class palette, the undo
 * buttons, the tag panel, the zoom readout, the shortcut sheet — is **outside**
 * the annotator package. That is the point rather than an accident of layout: the
 * canvas takes a store, a picture and an active class, and gives back callbacks.
 * It fetches nothing, it routes nothing, and it owns no UI a product would want to
 * restyle.
 *
 * The store lives here, which is what lets these controls read exactly what the
 * canvas draws. `useAnnotatorStore` builds it from a wire payload — the same
 * shape `GET /jobs/{id}/assets/{asset_id}/annotations` returns — so the demo goes
 * through `documentFromWire` and the wire mirror is exercised on the way in.
 *
 * ## What the showcase adds, and what it deliberately does not
 *
 * The page was a debug surface in dark inline styles that predated the design
 * alignment. It now follows the repo-root `DESIGN.md` — light GitHub-style
 * surfaces, a near-black action colour and no brand at all, one type scale — with the tool
 * strip and the zoom readout borrowed from the product's annotation page, so
 * the showcase and the product read as one thing. `theme.ts` holds the tokens and
 * records the single deliberate exception (the canvas well stays dark).
 *
 * What did not change is the *shape*: every `data-testid` below is load-bearing —
 * forty-odd Playwright scenarios steer this page — and the right-hand column is
 * still frankly a debug surface. `wire` prints what would be POSTed and `counts`
 * is the settled-state barrier every spec waits on. A showcase that hid them would
 * be prettier and would prove less.
 *
 * The strip reports the tool and does not own one; `ToolStrip.tsx` argues that.
 * The zoom is reported and not driven: `−`/`+` need an imperative handle the
 * adapter does not publish yet, and that lands with the top bar that has somewhere
 * to put them.
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
  toolFor,
  useAnnotatorSnapshot,
  useAnnotatorStore,
} from "@visionset/annotator";
import type { LabelClass, Viewport } from "@visionset/annotator";
import { useCallback, useState } from "react";
import type { CSSProperties, JSX, MouseEvent, ReactNode } from "react";

import { AnnotatorPanel } from "@visionset/ui-core";

import { SAMPLE_ASSET, SAMPLE_IMAGE_SRC } from "./sampleAsset";
import { SAMPLE_SCHEMA } from "./sampleSchema";
import { ToolStrip, ZoomBadge } from "./ToolStrip";
import { COLOR, FONT_STACK, RADIUS, SHADOW, SPACE, TEXT } from "./theme";

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
  const [view, setView] = useState<Viewport | null>(null);
  // Held here, and handed to both: the panel writes it and the canvas reads it.
  // A `useState` rather than a fresh `Set` per render, because an unstable set
  // defeats `AnnotationLayer`'s `memo` — the same trap `skipId` avoids.
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());

  const schema = snapshot.document.schema;
  const tool = toolFor(snapshot.document, activeClass);
  const tagged = taggedClassNames(snapshot.document);
  const selected = selectedAnnotations(snapshot.document, snapshot.selection);
  const drawn = annotationsInDrawOrder(snapshot.document);

  function toggleTag(labelClass: string): void {
    const command = toggleTagCommand(snapshot.document, labelClass, randomUuid);
    if (command !== null) store.execute(command);
  }

  const toggleHelp = useCallback(() => setShowHelp((open) => !open), []);

  /** The one capability the canvas hands out rather than owning. */
  function hostAction(name: string): boolean {
    if (name !== TOGGLE_HELP) return false;
    toggleHelp();
    return true;
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 320px",
        gap: SPACE.md,
        height: "100%",
        minHeight: 0,
        color: COLOR.foreground,
        fontFamily: FONT_STACK,
        ...TEXT.body,
      }}
    >
      <div
        style={{
          position: "relative",
          minWidth: 0,
          background: COLOR.well,
          border: `1px solid ${COLOR.wellBorder}`,
          borderRadius: RADIUS.lg,
          overflow: "hidden",
        }}
      >
        <AnnotatorCanvas
          store={store}
          imageSrc={SAMPLE_IMAGE_SRC}
          activeClass={activeClass}
          onActivateClass={setActiveClass}
          onViewChange={setView}
          hiddenIds={hiddenIds}
          onHostAction={hostAction}
        />
        <ToolStrip
          schema={schema}
          tool={tool}
          onActivateClass={setActiveClass}
          onToggleHelp={toggleHelp}
          onMouseDown={keepFocus}
        />
        {view !== null && <ZoomBadge zoom={view.zoom} />}
        {showHelp && <Shortcuts onClose={() => setShowHelp(false)} />}
      </div>

      <aside
        style={{
          display: "flex",
          flexDirection: "column",
          gap: SPACE.md,
          overflowY: "auto",
          minHeight: 0,
        }}
      >
        {/* The objects panel, composed here so the showcase is where its browser
            scenarios run. It is `ui-core`'s and styled with the design tokens; the
            debug panels below it stay inline-styled, which `theme.ts` argues.

            `flexShrink: 0`, and it is load-bearing rather than tidy.
            The panel is two regions now and carries `min-h-0` so its lower half
            can scroll inside a container of definite height — which is what it
            gets in the app, where it is a stretched item of a row. This aside is
            a **scrolling column**, so `min-h-0` also licenses the browser to
            shrink the panel below its content, and the overflow then lands on top
            of the debug panels underneath: every scenario in `e2e/panel.spec.ts`
            failed with `<aside> intercepts pointer events`. Pinning the basis is
            what tells the column that this child is not the one that gives way. */}
        <div style={{ flexShrink: 0, display: "flex" }}>
          <AnnotatorPanel
            store={store}
            hiddenIds={hiddenIds}
            onHiddenChange={setHiddenIds}
            activeClass={activeClass}
            onActivateClass={setActiveClass}
          />
        </div>

        <Panel title="Classes" testId="palette">
          <PaletteRow
            testId="class-select"
            hotkey="V"
            name="select"
            active={activeClass === null}
            onClick={() => setActiveClass(null)}
          />
          {schema.classes.map((declared: LabelClass) => (
            <PaletteRow
              key={declared.name}
              testId={`class-${declared.name}`}
              hotkey={hotkeyForClass(schema, declared.name) ?? "—"}
              name={declared.name}
              note={declared.geometry}
              swatch={classColor(declared, declared.name)}
              active={activeClass === declared.name}
              onClick={() =>
                isTaggableClass(declared)
                  ? toggleTag(declared.name)
                  : setActiveClass(declared.name)
              }
            />
          ))}
        </Panel>

        <Panel title="History" testId="history">
          <Button testId="undo" disabled={!snapshot.canUndo} onClick={() => store.undo()}>
            Undo {snapshot.undoLabel ?? ""}
          </Button>
          <Button testId="redo" disabled={!snapshot.canRedo} onClick={() => store.redo()}>
            Redo {snapshot.redoLabel ?? ""}
          </Button>
        </Panel>

        <Panel title="Tags" testId="tags">
          {schema.classes.filter(isTaggableClass).map((declared: LabelClass) => (
            <label
              key={declared.name}
              style={{ display: "flex", gap: SPACE.sm, alignItems: "center", ...TEXT.label }}
            >
              <input
                type="checkbox"
                data-testid={`tag-${declared.name}`}
                checked={tagged.has(declared.name)}
                onMouseDown={keepFocus}
                onChange={() => toggleTag(declared.name)}
                style={{ accentColor: COLOR.primary, margin: 0 }}
              />
              {declared.name}
            </label>
          ))}
        </Panel>

        <Panel title="State">
          <div data-testid="counts" style={TEXT.body}>
            {drawn.length} annotation(s), {selected.length} selected
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: SPACE.xs }}>
            <span style={{ color: COLOR.mutedForeground, ...TEXT.meta }}>
              Notes — typing here must not draw anything
            </span>
            <input
              type="text"
              data-testid="notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              style={{
                font: "inherit",
                padding: `${SPACE.xs}px ${SPACE.sm}px`,
                borderRadius: RADIUS.md,
                border: `1px solid ${COLOR.border}`,
                background: COLOR.background,
                color: COLOR.foreground,
              }}
            />
          </label>
        </Panel>

        <Panel title="What would be saved">
          <pre
            data-testid="wire"
            style={{
              margin: 0,
              maxHeight: 220,
              overflow: "auto",
              padding: SPACE.sm,
              borderRadius: RADIUS.md,
              background: COLOR.muted,
              color: COLOR.mutedForeground,
              fontSize: 11,
              lineHeight: 1.5,
            }}
          >
            {JSON.stringify(drawn.map(toAnnotationCreate), null, 2)}
          </pre>
        </Panel>
      </aside>
    </div>
  );
}

/** `DESIGN.md`'s card: white surface, one border, a section title, no shadow. */
function Panel({
  title,
  testId,
  children,
}: {
  readonly title: string;
  readonly testId?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section
      data-testid={testId}
      style={{
        background: COLOR.card,
        border: `1px solid ${COLOR.border}`,
        borderRadius: RADIUS.xl,
        padding: SPACE.md,
        display: "flex",
        flexDirection: "column",
        gap: SPACE.sm,
        boxShadow: SHADOW.card,
      }}
    >
      <h2 style={{ margin: 0, ...TEXT.sectionTitle }}>{title}</h2>
      {children}
    </section>
  );
}

const BUTTON: CSSProperties = {
  font: "inherit",
  ...TEXT.label,
  padding: `${SPACE.xs + 2}px ${SPACE.sm + 2}px`,
  borderRadius: RADIUS.md,
  border: `1px solid ${COLOR.border}`,
  background: COLOR.background,
  color: COLOR.foreground,
  cursor: "pointer",
  textAlign: "left",
};

function Button({
  testId,
  disabled,
  onClick,
  children,
}: {
  readonly testId: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onClick}
      style={{
        ...BUTTON,
        color: disabled === true ? COLOR.mutedForeground : COLOR.foreground,
        background: disabled === true ? COLOR.muted : COLOR.background,
        cursor: disabled === true ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

/**
 * One palette row: the hotkey, the class colour, the name and its geometry.
 *
 * Selected is `border-primary` plus the accent at 10%, `DESIGN.md`'s rule for a
 * selected row — the outline this used to draw was a fourth colour nothing else on
 * the page used.
 */
function PaletteRow({
  testId,
  hotkey,
  name,
  note,
  swatch,
  active,
  onClick,
}: {
  readonly testId: string;
  readonly hotkey: string;
  readonly name: string;
  readonly note?: string;
  readonly swatch?: string;
  readonly active: boolean;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active ? "true" : "false"}
      onMouseDown={keepFocus}
      onClick={onClick}
      style={{
        ...BUTTON,
        display: "flex",
        alignItems: "center",
        gap: SPACE.sm,
        border: `1px solid ${active ? COLOR.primary : COLOR.border}`,
        background: active ? COLOR.primarySoft : COLOR.background,
      }}
    >
      <kbd style={KBD}>{hotkey}</kbd>
      {swatch !== undefined && (
        <span
          aria-hidden="true"
          style={{ width: 10, height: 10, borderRadius: RADIUS.sm, background: swatch, flex: "none" }}
        />
      )}
      <span style={{ flex: 1 }}>{name}</span>
      {note !== undefined && (
        <span style={{ color: COLOR.mutedForeground, ...TEXT.meta }}>{note}</span>
      )}
    </button>
  );
}

const KBD: CSSProperties = {
  display: "inline-grid",
  placeItems: "center",
  minWidth: 20,
  height: 20,
  padding: "0 4px",
  borderRadius: RADIUS.sm,
  border: `1px solid ${COLOR.border}`,
  background: COLOR.muted,
  color: COLOR.mutedForeground,
  fontFamily: "inherit",
  ...TEXT.meta,
};

/** The default table, rendered. It is data, so the sheet cannot go out of date. */
function Shortcuts({ onClose }: { readonly onClose: () => void }): JSX.Element {
  return (
    <div
      data-testid="shortcuts"
      style={{
        position: "absolute",
        inset: SPACE.lg,
        background: COLOR.card,
        border: `1px solid ${COLOR.border}`,
        borderRadius: RADIUS.lg,
        padding: SPACE.lg,
        overflow: "auto",
        boxShadow: SHADOW.overlay,
        color: COLOR.foreground,
      }}
    >
      <button
        type="button"
        data-testid="shortcuts-close"
        style={{ ...BUTTON, float: "right" }}
        onMouseDown={keepFocus}
        onClick={onClose}
      >
        Close
      </button>
      <h2 style={{ margin: 0, ...TEXT.sectionTitle }}>Shortcuts</h2>
      <table style={{ marginTop: SPACE.md, borderSpacing: `${SPACE.md}px ${SPACE.xs}px` }}>
        <tbody>
          {DEFAULT_BINDINGS.map((binding) => (
            <tr key={binding.chord}>
              <td>
                <kbd style={KBD}>{binding.chord}</kbd>
              </td>
              <td style={{ color: COLOR.mutedForeground }}>{binding.action?.kind ?? "unbound"}</td>
            </tr>
          ))}
          <tr>
            <td>
              <kbd style={KBD}>1</kbd>–<kbd style={KBD}>9</kbd>
            </td>
            <td style={{ color: COLOR.mutedForeground }}>
              the schema&rsquo;s classes, in authored order
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
