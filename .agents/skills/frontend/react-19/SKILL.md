---
name: react-19
description: >
  React 19 patterns with React Compiler.
  Trigger: When writing React 19 components/hooks in .tsx (React Compiler rules, hook patterns,
  refs as props).
license: Apache-2.0
metadata:
  author: robomous
  version: "1.0"
  scope: [root, frontend]
  auto_invoke: "Writing React components"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, WebFetch, WebSearch, Task
---

## Where React is allowed (VisionSet)

| Package | React? |
| --- | --- |
| `frontend/annotator/src/core/` | **Never** — pure TS, ESLint-enforced |
| `frontend/annotator/src/adapters/react/` | Yes — the render adapter |
| `frontend/ui-core/` | Yes — domain components (Radix + lucide only) |
| `frontend/app/` | Yes — the product shell |

## No Manual Memoization (REQUIRED)

```typescript
// ✅ React Compiler handles optimization automatically
function Component({ items }) {
  const filtered = items.filter(x => x.active);
  const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name));

  const handleClick = (id) => {
    console.log(id);
  };

  return <List items={sorted} onClick={handleClick} />;
}

// ❌ NEVER: Manual memoization
const filtered = useMemo(() => items.filter((x) => x.active), [items]);
const handleClick = useCallback((id) => console.log(id), []);
```

## Imports (REQUIRED)

```typescript
// ✅ ALWAYS: Named imports
import { useState, useEffect, useRef } from "react";

// ❌ NEVER
import React from "react";
import * as React from "react";
```

## use() Hook

```typescript
import { use } from "react";

// Read promises (suspends until resolved)
function Comments({ promise }) {
  const comments = use(promise);
  return comments.map(c => <div key={c.id}>{c.text}</div>);
}

// Conditional context (not possible with useContext!)
function Theme({ showTheme }) {
  if (showTheme) {
    const theme = use(ThemeContext);
    return <div style={{ color: theme.primary }}>Themed</div>;
  }
  return <div>Plain</div>;
}
```

## ref as Prop (No forwardRef)

```typescript
// ✅ React 19: ref is just a prop
function Input({ ref, ...props }) {
  return <input ref={ref} {...props} />;
}

// ❌ Old way (unnecessary now)
const Input = forwardRef((props, ref) => <input ref={ref} {...props} />);
```

## Keep components thin

Annotation behavior (hit-testing, geometry, undo/redo, interaction state) belongs in
`@visionset/annotator` core, not in a component. A React component subscribes to core state and
renders it. If deleting React would delete the logic, the logic is in the wrong package.
