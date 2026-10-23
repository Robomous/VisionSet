/**
 * Structural readers for a stylesheet's token blocks. `@robomous/ui-core` no
 * longer ships these — its own suite holds the foundation — so the extension
 * gates here parse `styles.css` the way that suite does: by brace depth, not
 * by evaluating `@theme`.
 */

/** Whitespace and quote style are presentation, not value. */
function normalize(value: string): string {
  return value.replace(/\s+/g, " ").replace(/"/g, "'").trim();
}

/** The `{ … }` body of the block whose header appears first, matched by brace depth. */
export function blockBody(css: string, header: string): string {
  const headerAt = css.indexOf(header);
  if (headerAt === -1) throw new Error(`styles.css has no ${JSON.stringify(header)} block`);
  const braceAt = css.indexOf("{", headerAt);
  let depth = 1;
  let i = braceAt + 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(braceAt + 1, i - 1);
}

/** Every `--name: value;` declaration in a block, keyed WITH the leading `--`. */
export function rawDeclarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    map.set(match[1], normalize(match[2]));
  }
  return map;
}

/** The same, keyed WITHOUT the leading `--`, which is how a role is named. */
export function declarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of rawDeclarations(block)) map.set(name.slice(2), value);
  return map;
}
