import { AnnotatorCanvas } from "@visionset/annotator";
import type { JSX } from "react";

export function App(): JSX.Element {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 720 }}>
      <h1>Robomous VisionSet — development build</h1>
      <AnnotatorCanvas />
    </main>
  );
}
