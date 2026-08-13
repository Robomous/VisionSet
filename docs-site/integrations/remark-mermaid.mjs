/**
 * Hand a ```` ```mermaid ```` fence to the browser instead of syntax-highlighting it.
 *
 * Fifteen of the forty-two documents carry a diagram, and every one of them is on
 * the architecture pages — where the diagram *is* the page's point. Rendered as a
 * code block they read as a wall of arrow syntax, which is the one place this site
 * would be worse than GitHub, which renders them natively.
 *
 * The transform is one node type and nothing else: a `code` node whose language is
 * `mermaid` becomes an `html` node holding `<pre class="mermaid">`. `src/components/
 * Head.astro` picks those up in the browser and draws them, and it imports mermaid
 * dynamically — so a page with no diagram fetches none of it.
 *
 * The source is escaped rather than interpolated. A label containing `<` or `&` is
 * ordinary in these diagrams (`callers --> services`, `A & B`), and unescaped it
 * would be parsed as markup and silently deleted before mermaid ever saw it.
 *
 * The wrapper is emitted **here, at build time**, and it is what the magnifier button
 * hangs off. Two reasons it cannot be the `<pre>` itself, and neither is cosmetic:
 * `Head.astro`'s redraw assigns `node.textContent`, which destroys every child of the
 * `<pre>` on each theme toggle; and `pre.mermaid` scrolls horizontally, so a button
 * positioned inside it would slide out of view on exactly the wide diagrams that need
 * it most. A wrapper written by the transform is outside both problems and needs no
 * DOM surgery in the browser.
 */

import { visit } from "unist-util-visit";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

function escape(source) {
  return source.replace(/[&<>]/g, (character) => ESCAPES[character]);
}

export default function remarkMermaid() {
  return (tree) => {
    visit(tree, "code", (node, index, parent) => {
      if (node.lang !== "mermaid" || parent === undefined || index === undefined) return;
      parent.children[index] = {
        type: "html",
        value:
          `<div class="mermaid-figure">` +
          `<pre class="mermaid" data-mermaid>${escape(node.value)}</pre>` +
          `</div>`,
      };
    });
  };
}
