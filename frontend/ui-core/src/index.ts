/**
 * `@visionset/ui-core` — the design system, the domain components, and the
 * generated API client.
 *
 * ## What a consumer imports
 *
 * ```ts
 * import "@visionset/ui-core/styles.css";           // once, in the app's entry
 * import { Button, Card, EmptyState } from "@visionset/ui-core";
 * ```
 *
 * The stylesheet is the contract: Tailwind v4 reads its `@theme` block, so
 * `bg-primary` in a component here and `bg-primary` in a screen in `@visionset/app`
 * are the same colour by construction. There is no `tailwind.config.js` in this
 * repository and there must not be one — the tokens would acquire a second home.
 *
 * ## The rule this package exists to make enforceable
 *
 * `DESIGN.md`'s first principle: **never a hex or a `var()` colour in a class
 * string.** `tests/scripts/design_tokens.test.mjs` scans every tracked frontend
 * file for one and fails the build. v1 spent its life migrating away from hardcoded
 * colours; VisionSet starts clean, so the legacy escape hatch does not come along.
 *
 * ## Layering
 *
 * `app/` is navigation, layout and composition — the enterprise rule (#58). A
 * capability that lands there instead of here is an architecture bug by
 * definition, because the future enterprise UI cannot reuse it. Screens are
 * components in this package; routes are in the app.
 *
 * The public surface is listed explicitly rather than `export *`, so what this
 * package promises stays auditable — the rule `generated/api.ts` already follows.
 */

// The design tokens, and their prose contract at the repository root.
export { COLOR, DESIGN_TOKENS, FONT, RADIUS, SPACING, TEXT } from "./tokens.js";

// The class palette. Re-exported from the annotator, never respelled — see the
// argument in `palette.ts`.
export { CLASS_FILL_OPACITY, classColor } from "./palette.js";
export type { LabelClass } from "./palette.js";

export { cn } from "./lib/cn.js";

// Primitives — Radix + lucide only (decision H).
export { Button, buttonVariants, type ButtonProps } from "./primitives/Button.js";
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./primitives/Card.js";
export { FieldError, FieldHint, Input, Label, Textarea } from "./primitives/Input.js";
export {
  Alert,
  Badge,
  badgeVariants,
  type AlertProps,
  type BadgeProps,
} from "./primitives/Badge.js";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
  type SheetContentProps,
} from "./primitives/Dialog.js";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./primitives/Tabs.js";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./primitives/Select.js";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./primitives/Menu.js";
export { Progress, Skeleton, Toaster, toast } from "./primitives/Feedback.js";
export {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "./primitives/Table.js";

// The three states every async surface owes.
export {
  EmptyState,
  ErrorState,
  LoadingState,
  type EmptyStateProps,
  type ErrorStateProps,
  type LoadingStateProps,
} from "./patterns/AsyncStates.js";

// The typed client, and the generated contract under the names every
// openapi-typescript consumer expects.
export { createApiClient } from "./client.js";
export type { ApiClientOptions, VisionSetClient } from "./client.js";
export type { components, operations, paths } from "./generated/api.js";

// The data shell (#52): one client, one query cache, one answer to a 401.
export {
  ApiProvider,
  useApiClient,
  useApiSession,
  type ApiProviderProps,
  type ApiSession,
} from "./data/ApiProvider.js";
export { TokenForm, TokenGate, type TokenGateProps } from "./data/TokenGate.js";
export { Async, type AsyncProps, type AsyncQuery } from "./data/Async.js";
export {
  ApiError,
  MALFORMED_ERROR,
  NETWORK_ERROR,
  asApiError,
  unwrap,
  type ErrorBody,
  type FetchResult,
} from "./data/errors.js";
export { DEFAULT_POLL_MS, usePollingQuery, type PollingQueryOptions } from "./data/polling.js";
export { clearToken, readToken, writeToken } from "./data/session.js";

// Screens (#53 →). Domain UI, so it lives here and not in `@visionset/app`:
// a capability in the app is one the enterprise UI cannot reuse. Navigation
// arrives as a callback — a screen that imported a router would only work inside
// one particular router's tree.
export { ProjectsScreen, type ProjectsScreenProps } from "./screens/ProjectsScreen.js";
export { ProjectScreen, type ProjectScreenProps } from "./screens/ProjectScreen.js";
export { SchemaEditor, type SchemaEditorProps } from "./screens/SchemaEditor.js";
export { IngestScreen, type IngestScreenProps } from "./screens/IngestScreen.js";
export {
  queryKeys,
  useActiveSchema,
  useCreateProject,
  useCreateSchemaVersion,
  useDeleteProject,
  useProject,
  useProjects,
  useRenameProject,
  useSchemaVersions,
  type AttributeBody,
  type GeometryType,
  type LabelClassBody,
  type Project,
  type ProjectPage,
  type SchemaVersion,
  type SchemaVersionPage,
  ingestKeys,
  useBatches,
  useIngestJob,
  useRegisterSource,
  useResumeIngest,
  useSources,
  useStartIngest,
  type Batch,
  type BatchPage,
  type IngestFailure,
  type IngestJob,
  type Source,
  type SourcePage,
} from "./screens/queries.js";
