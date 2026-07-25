import type { JSX } from "react";

/**
 * React render adapter for the headless annotation engine.
 * Placeholder: renders an empty SVG stage until the engine wiring lands.
 */
export function AnnotatorCanvas(): JSX.Element {
  return (
    <svg
      data-testid="annotator-canvas"
      role="img"
      aria-label="Annotation canvas (placeholder)"
      viewBox="0 0 640 360"
      style={{ width: "100%", maxWidth: 640, background: "#1a1a1e", borderRadius: 8 }}
    >
      <text x="50%" y="50%" textAnchor="middle" fill="#8a8a93" fontSize="14">
        @visionset/annotator — canvas placeholder
      </text>
    </svg>
  );
}
