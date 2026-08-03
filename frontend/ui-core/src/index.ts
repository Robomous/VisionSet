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
export {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  tabsListVariants,
  tabsTriggerVariants,
  type TabsListProps,
  type TabsVariant,
} from "./primitives/Tabs.js";
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

// The data-surface parts (#209). Four rather than six: `EmptyState` is already
// above and Chip is `Badge`, so neither is respelled here.
export {
  ClassListRow,
  DistributionBar,
  StatCard,
  ThumbnailGrid,
  type ClassListRowProps,
  type DistributionBarProps,
  type StatCardProps,
  type ThumbnailGridProps,
} from "./patterns/DataDisplay.js";

// How a number and a moment are written, so eight screens do not each decide.
export { formatCount, formatPercent, formatWhen } from "./lib/format.js";

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
  type Access,
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
// `unwrap` takes a check, so a consumer calling it needs the type and the checks for
// the operations it calls. The combinators themselves stay unexported: they are the
// generator's vocabulary, and a hand-written check would be a second spelling of the
// contract — exactly what `generated/checks.ts` exists to prevent.
export { type Check } from "./data/check.js";
export * as checks from "./generated/checks.js";
export { DEFAULT_POLL_MS, usePollingQuery, type PollingQueryOptions } from "./data/polling.js";
export { clearToken, readToken, writeToken } from "./data/session.js";

// Screens (#53 →). Domain UI, so it lives here and not in `@visionset/app`:
// a capability in the app is one the enterprise UI cannot reuse. Navigation
// arrives as a callback — a screen that imported a router would only work inside
// one particular router's tree.
export { ProjectsScreen, type ProjectsScreenProps } from "./screens/ProjectsScreen.js";
export { ProjectScreen, type ProjectScreenProps, type ProjectTab } from "./screens/ProjectScreen.js";
export { SchemaEditor, type SchemaEditorProps } from "./screens/SchemaEditor.js";
export { IngestScreen, type IngestScreenProps } from "./screens/IngestScreen.js";
export { BatchesScreen, type BatchesScreenProps } from "./screens/BatchesScreen.js";
export { GalleryScreen, type GalleryScreenProps } from "./screens/GalleryScreen.js";
export { ApproveDialog, BatchProgressBar } from "./screens/BatchLifecycle.js";
export {
  batchStateLabel,
  isApprovable,
  segmentCounts,
  segmentOf,
  relativeAge,
  type Segment,
} from "./screens/batchState.js";
export { DatasetScreen, type DatasetScreenProps } from "./screens/DatasetScreen.js";
export { saveBlob } from "./screens/download.js";
export { AssetThumbnail, type AssetThumbnailProps } from "./screens/AssetThumbnail.js";

// The Overview panel (#212) and the heuristic it shows, exported separately so
// the rule can be replaced without touching the screen that renders it.
export { OverviewPanel, type OverviewPanelProps } from "./screens/OverviewPanel.js";
export {
  imbalanceNote,
  IMBALANCE_MIN_CLASSES,
  IMBALANCE_SHARE,
  type ClassShare,
} from "./screens/imbalance.js";

// The annotation page's side panel (#126). Driven entirely by the `AnnotatorStore`
// the page already holds — no second door to the document.
export { AnnotatorPanel, type AnnotatorPanelProps } from "./annotator/AnnotatorPanel.js";
export { ShortcutSheet, type ShortcutSheetProps } from "./annotator/ShortcutSheet.js";

// Whether the rail starts collapsed (#200). One declaration, guarded storage.
export {
  RAIL_COLLAPSED_BY_DEFAULT,
  readRailCollapsed,
  writeRailCollapsed,
} from "./data/railState.js";

// The way out of a sub-view (#199). Structural, never `navigate(-1)`.
export { BackLink, type BackLinkProps } from "./patterns/BackLink.js";
export { parentLabel } from "./patterns/parentLabel.js";

// The floating tool palette (#198). Reports the derived tool; never stores one.
export { ToolPalette, toolChoices, type ToolPaletteProps } from "./annotator/ToolPalette.js";
export {
  AddClassDialog,
  runAddClass,
  type AddClassDialogProps,
} from "./annotator/AddClassDialog.js";
export { ClassFields, type ClassFieldsProps } from "./patterns/ClassFields.js";

// The annotator's minimum viewport (#184). Followed live, never sniffed.
export {
  ANNOTATOR_MIN_VIEWPORT_PX,
  atLeastQuery,
  useViewportAtLeast,
} from "./annotator/viewportFloor.js";

// The annotation page (#56) — where M4's engine meets M3's API.
export { AnnotationPage, type AnnotationPageProps } from "./annotator/AnnotationPage.js";
export { AssetImage, type AssetImageProps } from "./annotator/AssetImage.js";
export {
  isEmptyPlan,
  jobKeys,
  planSave,
  useAssetAnnotations,
  useJob,
  useJobAssets,
  useJobProgress,
  usePinnedSchema,
  useSaveAnnotations,
  useSetAssetProgress,
  type AssetProgress,
  type SavePlan,
} from "./annotator/jobQueries.js";
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
  GALLERY_PAGE_SIZE,
  batchKeys,
  useApproveBatch,
  useBatch,
  useBatchAssets,
  useBatchJobs,
  useBatchTransition,
  type BatchAsset,
  type BatchAssetPage,
  type Job,
  type Partition,
  type ProgressCounts,
  datasetKeys,
  useDatasetStats,
  useDownloadManifest,
  useExportRelease,
  useFormats,
  useProjectDataset,
  usePromoteBatch,
  usePublishRelease,
  useReleases,
  useVerifyRelease,
  type Dataset,
  type DatasetStats,
  type Format,
  type Release,
  type ReleaseVerification,
  type SplitRecipe,
} from "./screens/queries.js";
