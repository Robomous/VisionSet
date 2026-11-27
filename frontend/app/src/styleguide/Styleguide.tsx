/**
 * The design system, rendered.
 *
 * The claim it exists for is that *a screen built only from semantic
 * utilities matches the contract* — which is a claim about pixels, and a claim
 * about pixels needs a page. This is that page: every primitive `ui-core` exports,
 * composed with nothing but token utilities, so the contract can be looked at
 * rather than only asserted.
 *
 * It is also the honest test of the wiring. `ui-core` ships as `tsc` output and
 * its class strings only become CSS if the consumer's Tailwind build sees them —
 * a `@source` that misses would produce a page that compiles, renders, and is
 * completely unstyled. `e2e/styleguide.spec.ts` reads a computed colour back for
 * exactly that reason.
 *
 * Deliberately in `@visionset/app` and not in `ui-core`: this is composition, and
 * the enterprise rule says composition lives here. It carries no capability
 * a product would want — only the components it is showing.
 */

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  AssetMosaic,
  ClassDistribution,
  ClassListRow,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  DistributionBar,
  formatCount,
  formatPercent,
  StatCard,
  ThumbnailGrid,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  type EmptyArtName,
  ErrorState,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  LoadingState,
  ProgressBar,
  PROJECT_SECTIONS,
  ProjectEyebrow,
  ProjectKpi,
  ProjectNav,
  SectionHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Toaster,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  classColor,
  formatGeometries,
  toast,
} from "@visionset/ui-core";
import { ArrowUpRight, CircleCheck, Database, ImageIcon, Info, MousePointer2, Plus, Square, SquareDashed, Tag, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";

/** The demo schema, borrowed so the swatches show the real palette rule. */
const CLASSES = [
  { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
  { name: "lane", geometries: ["polygon"], color: "#f97316", attributes: [] },
  { name: "daytime", geometries: ["classification_tag"], color: "#a3e635", attributes: [] },
  // No colour — `classColor` derives a stable hue from the name instead.
  { name: "pedestrian", geometries: ["bbox"], color: null, attributes: [] },
] as const;

const BATCHES = [
  { name: "drive-01", state: "in_annotation", assets: 412, done: 240 },
  { name: "drive-02", state: "draft", assets: 96, done: 0 },
  { name: "night-run", state: "completed", assets: 1204, done: 1204 },
] as const;

// Sorted descending, because that is the order the chart is drawn in and the
// first row is where its shared max comes from. The tail is deliberately tiny:
// a class at 1% is what a proportional bar has to survive without vanishing.
const DISTRIBUTION = [
  { name: "dog", count: 4372 },
  { name: "person", count: 1544 },
  { name: "bicycle", count: 515 },
  { name: "traffic light", count: 61 },
] as const;

// Forty of them, which is an ordinary Physical AI ontology and the size the
// old stacked-card schema editor became unusable at.
const ONTOLOGY = Array.from({ length: 40 }, (_, index) => `class-${String(index + 1).padStart(2, "0")}`);

/** The Combobox demo's items — one of them ("lane") is the sole `an` match. */
const DEMO_CLASSES = ["barrier", "bicycle", "cyclist", "lane", "sign", "truck", "vehicle"];

/** `Badge`'s shadcn variants, then VisionSet's four status extensions. */
const BADGE_OFFICIAL = ["default", "secondary", "outline", "destructive", "ghost", "link"] as const;
const BADGE_STATUS = ["success", "warning", "info", "quiet"] as const;

const EMPTY_ART: readonly EmptyArtName[] = ["projects", "images", "classes", "models", "dataset", "recipes"];

export function Styleguide(): JSX.Element {
  return (
    <TooltipProvider>
      <div className="mx-auto flex max-w-page flex-col gap-6 px-6 py-6">
        <header className="flex flex-col gap-1 border-b border-border pb-4">
          <h1 className="text-2xl font-semibold tracking-tight">VisionSet design system</h1>
          <p className="text-xs text-muted-foreground">
            Every primitive <code className="font-mono">@visionset/ui-core</code> exports, composed
            from token utilities only. The contract is <code className="font-mono">DESIGN.md</code>{" "}
            at the repository root.
          </p>
        </header>

        <Section
          title="Colour"
          description="Intent, never a value. The shadcn preset's own vocabulary, plus the foundation's brand and VisionSet's three justified extensions. Every caption is the value the browser resolves for that swatch."
        >
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">Semantic</h3>
              <div className="flex flex-wrap gap-3" data-testid="swatches">
                <Swatch name="background" className="bg-background" />
                <Swatch name="foreground" className="bg-foreground" />
                <Swatch name="card" className="bg-card" />
                <Swatch name="popover" className="bg-popover" />
                <Swatch name="primary" className="bg-primary" />
                <Swatch name="secondary" className="bg-secondary" />
                <Swatch name="muted" className="bg-muted" />
                <Swatch name="muted-foreground" className="bg-muted-foreground" />
                <Swatch name="accent" className="bg-accent" />
                <Swatch name="destructive" className="bg-destructive" />
                <Swatch name="border" className="bg-border" />
                <Swatch name="input" className="bg-input" />
                <Swatch name="ring" className="bg-ring" />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">Sidebar</h3>
              <div className="flex flex-wrap gap-3">
                <Swatch name="sidebar" className="bg-sidebar" />
                <Swatch name="sidebar-foreground" className="bg-sidebar-foreground" />
                <Swatch name="sidebar-primary" className="bg-sidebar-primary" />
                <Swatch name="sidebar-primary-foreground" className="bg-sidebar-primary-foreground" />
                <Swatch name="sidebar-accent" className="bg-sidebar-accent" />
                <Swatch name="sidebar-accent-foreground" className="bg-sidebar-accent-foreground" />
                <Swatch name="sidebar-border" className="bg-sidebar-border" />
                <Swatch name="sidebar-ring" className="bg-sidebar-ring" />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                VisionSet extensions
              </h3>
              <div className="flex flex-wrap gap-3">
                <Swatch name="stage" className="bg-stage" />
                {/* The brand, shown here because a styleguide is where a value is
                    inspected rather than used. Its one product site is the VisionSet
                    logo (`shell/Brand.tsx`); Robomous's mark on the Models page (`OriginLogo`) is its other. */}
                <Swatch name="brand" style={{ backgroundColor: "var(--brand)" }} />
                <Swatch name="origin-custom" className="bg-origin-custom" />
              </div>
            </div>
          </div>
        </Section>

        <Section title="Typography" description="One scale. Reuse it; do not invent a size.">
          <p className="text-2xl font-semibold font-heading tracking-tight">Page title — 1.5rem / 600</p>
          <p className="text-base font-semibold font-heading">Section title — 1rem / 600</p>
          <p className="text-sm">Body — 0.875rem, line-height 1.6</p>
          <p className="text-xs text-muted-foreground">Meta — 0.75rem, muted</p>
        </Section>

        <Section title="Buttons" description="Six variants, eight sizes.">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="default" data-testid="button-primary">
              <Plus className="size-4" aria-hidden="true" />
              New project
            </Button>
            <Button variant="outline">Outline</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">
              <Trash2 className="size-4" aria-hidden="true" />
              Delete
            </Button>
            <Button variant="link" className="h-auto p-0">
              Learn more
              <ArrowUpRight className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            </Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs">Extra small</Button>
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="default" size="icon" aria-label="Select (V)">
                  <MousePointer2 className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Select (V)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Zoom out">
                  <Square className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Zoom out</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Box (B)">
                  <Square className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Box (B)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-lg" aria-label="Zoom in">
                  <Square className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Zoom in</TooltipContent>
            </Tooltip>
          </div>
        </Section>

        <Section
          title="The class palette"
          description="One spelling, shared by the canvas, the side panel and the gallery."
        >
          <div className="flex flex-wrap gap-2" data-testid="class-palette">
            {CLASSES.map((declared) => (
              <span
                key={declared.name}
                className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-sm"
              >
                <span
                  aria-hidden="true"
                  className="size-3 rounded-sm"
                  // The one legitimate inline colour on this page: the value comes
                  // from the *schema*, so no utility could name it — which is
                  // exactly the case `DESIGN.md`'s no-hex-in-a-className rule is
                  // not about.
                  style={{ background: classColor(declared, declared.name) }}
                />
                {declared.name}
                <span className="text-xs text-muted-foreground">
                  {formatGeometries(declared.geometries)}
                </span>
              </span>
            ))}
          </div>
        </Section>

        <Section
          title="Fields"
          description="Radix labels; every control carries Nova's own focus ring."
        >
          <FieldSet className="max-w-3xl">
            <FieldLegend>Dataset</FieldLegend>
            <FieldGroup className="grid gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="sg-name">Project name</FieldLabel>
                <Input id="sg-name" defaultValue="highway-survey" />
                <FieldDescription>Unique per workspace, case-insensitively.</FieldDescription>
                <FieldError>Already taken — try “highway-survey-2”.</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor="sg-geometry">Geometry</FieldLabel>
                <Select defaultValue="bbox">
                  <SelectTrigger id="sg-geometry">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bbox">bbox</SelectItem>
                    <SelectItem value="obb">obb</SelectItem>
                    <SelectItem value="polygon">polygon</SelectItem>
                    <SelectItem value="classification_tag">classification_tag</SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>A hint, under a field that needs one.</FieldDescription>
              </Field>
              {/*
                The two-line option, composed at the call site: an option that is
                an identifier plus the facts about it stacks them, and the trigger
                shows the same two lines the list does because Radix renders the
                selected item's own children into it.
              */}
              <Field className="md:col-span-2">
                <FieldLabel htmlFor="sg-model">Model</FieldLabel>
                <Select defaultValue="facebook/sam2.1-hiera-base-plus">
                  <SelectTrigger id="sg-model" multiline>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="facebook/sam2.1-hiera-tiny">
                      <span className="flex flex-col items-start">
                        <span>facebook/sam2.1-hiera-tiny</span>
                        <span className="text-xs text-muted-foreground">
                          311.9 MB · tiny — fastest, comfortable on a CPU
                        </span>
                      </span>
                    </SelectItem>
                    <SelectItem value="facebook/sam2.1-hiera-base-plus">
                      <span className="flex flex-col items-start">
                        <span>facebook/sam2.1-hiera-base-plus</span>
                        <span className="text-xs text-muted-foreground">
                          647.1 MB · base-plus — the balanced default
                        </span>
                      </span>
                    </SelectItem>
                    <SelectItem value="facebook/sam2.1-hiera-large">
                      <span className="flex flex-col items-start">
                        <span>facebook/sam2.1-hiera-large</span>
                        <span className="text-xs text-muted-foreground">
                          1.8 GB · large — the most accurate, wants a GPU
                        </span>
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  The id at the label role, what it costs beneath it. Nothing truncates.
                </FieldDescription>
              </Field>
              <Field className="md:col-span-2">
                <FieldLabel htmlFor="sg-notes">Description</FieldLabel>
                <Textarea id="sg-notes" placeholder="What this dataset is for" />
              </Field>
            </FieldGroup>
          </FieldSet>
        </Section>

        <Section
          title="Badges and status"
          description="Status is a soft surface and readable ink on shadcn's geometry — no coloured stroke. Outline is the only visible border."
        >
          <BadgeRow theme="light" />
          <div className="dark bg-background text-foreground rounded-lg p-3">
            <BadgeRow theme="dark" />
          </div>
          <div className="max-w-md">
            <p className="mb-1 text-xs text-muted-foreground">
              Ingest — 240 of 412. An amount completed, never a polarity.
            </p>
            <ProgressBar value={58} aria-label="Ingest progress" />
          </div>
          <div className="max-w-md">
            <p className="mb-1 text-xs text-muted-foreground">
              Annotation — 7 of 11 annotated (64%)
            </p>
            <ProgressBar
              value={64}
              aria-label="Annotation progress"
              className="h-2 border border-border"
            />
          </div>
        </Section>

        <Section
          title="Cards, tabs and tables"
          description="The screens are made of these. A tab bar is a segmented control; the line variant is the other shape."
        >
          <Tabs defaultValue="batches" data-testid="tabs-segmented">
            <TabsList>
              <TabsTrigger value="batches">Batches</TabsTrigger>
              <TabsTrigger value="about">About</TabsTrigger>
            </TabsList>
            <TabsContent value="batches">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Assets</TableHead>
                    <TableHead>Annotated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {BATCHES.map((batch) => (
                    <TableRow key={batch.name}>
                      <TableCell className="font-medium">{batch.name}</TableCell>
                      <TableCell>
                        <Badge variant={batch.state === "in_annotation" ? "default" : "secondary"}>
                          {batch.state}
                        </Badge>
                      </TableCell>
                      <TableCell>{batch.assets}</TableCell>
                      <TableCell>{batch.done}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="about">
              <Card className="max-w-md">
                <CardHeader>
                  <CardTitle>highway-survey</CardTitle>
                  <CardDescription>Created 2026-07-31 · schema v3</CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  A card is a border and a 16px radius. The shadow is resting-only.
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* There is no second specimen: the `segmented` variant is gone
              along with the Objects | Labels switch that was its only caller, so
              every shape that ships has one specimen and that is this one. */}
        </Section>

        <Section
          title="Project navigation"
          description="Inside a project: one link per section with the open one marked, Add images where images are the subject (the Overview's is its batches band's, beside Annotate), and the overflow. A toolbar across the pane at lg and above; the same data as a strip below. The project's identity is the eyebrow above the content (see Section header)."
        >
          <div className="flex flex-col gap-6">
            <div className="flex flex-col overflow-hidden rounded-lg border border-border" data-testid="sg-project-nav-bar">
              <ProjectNav
                layout="bar"
                sections={PROJECT_SECTIONS}
                active="images"
                hrefFor={(section) => `#${section}`}
                onNavigate={() => undefined}
                onIngest={() => undefined}
                onRename={() => undefined}
                onDelete={() => undefined}
              />
              <div className="h-24 bg-background p-6 text-xs text-muted-foreground">the section</div>
            </div>
            <div className="min-w-0 max-w-xl rounded-lg border border-border p-4" data-testid="sg-project-nav-strip">
              <ProjectNav
                layout="strip"
                sections={PROJECT_SECTIONS}
                active="images"
                onNavigate={() => undefined}
                onIngest={() => undefined}
                onRename={() => undefined}
                onDelete={() => undefined}
              >
                <p className="text-xs text-muted-foreground">the section</p>
              </ProjectNav>
            </div>
          </div>
        </Section>

        <Section
          title="Section header"
          description="The project's eyebrow — its name and active version, identity and not navigation — then a section's page h1, one line of meta under it, and its own secondary actions on the right. The filled control lives in the navigation, never here."
        >
          <ProjectEyebrow name="road-signs" version={4} />
          <SectionHeader
            as="h2"
            title="Overview"
            meta="11 images · ingested Aug 7, 2026"
            actions={
              <Button variant="outline">
                <Plus className="size-4" aria-hidden="true" />
                Ingest
              </Button>
            }
          />
        </Section>

        <Section
          title="Overlays"
          description="Radix owns the focus trap, the Escape key and the scroll lock."
        >
          <div className="flex flex-col gap-3">
            <Alert className="max-w-md">
              <AlertTitle>Ingest queued</AlertTitle>
              <AlertDescription>
                412 assets are being processed. This can take a few minutes.
              </AlertDescription>
            </Alert>
            <Alert variant="destructive" className="max-w-md">
              <AlertTitle>Export failed</AlertTitle>
              <AlertDescription>
                The release manifest could not be written. Retry, or contact support if it keeps
                happening.
              </AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm">
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="destructive" data-testid="open-dialog">
                  Delete project
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogTitle>Delete highway-survey?</DialogTitle>
                <DialogDescription>
                  This removes the project, its schema versions, batches, annotations and
                  releases. Blobs are never deleted.
                </DialogDescription>
                <DialogFooter>
                  <Button variant="outline">Cancel</Button>
                  <Button variant="destructive">Delete</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <SheetDemo />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">Actions</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem>Rename</DropdownMenuItem>
                <DropdownMenuItem>Duplicate schema</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="What is a release?">
                  <Info className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>A frozen, exportable snapshot of one schema version.</TooltipContent>
            </Tooltip>

            <Button
              variant="outline"
              data-testid="open-toast"
              onClick={() => toast("Release v0.3 published")}
            >
              Toast
            </Button>
          </div>

          <div className="max-w-sm">
            <p className="mb-1 text-xs text-muted-foreground">
              Combobox — Base UI, filtered as you type.
            </p>
            <ComboboxDemo />
          </div>
        </Section>

        <Section
          title="Loading, empty and error"
          description="The three states every async surface owes."
        >
          <div className="grid gap-4 lg:grid-cols-3">
            <LoadingState rows={3} />
            <EmptyState
              art="images"
              title="No images yet"
              description="Images and video frames you add to this project appear here."
              action={<Button variant="outline">Add images</Button>}
            />
            <ErrorState
              code="SCHEMA_CHANGE_WOULD_ORPHAN"
              message="Removing “lane” would orphan 1,204 annotations."
              incidentId="7f1c9a2e"
              onRetry={() => toast("Retried")}
            />
          </div>
        </Section>

        <Section
          title="Empty-state drawings"
          description="One stack per space, a plain stack that holds an icon for the rest, and the compact size a pane or a sheet gets. Hover one: the cards spread."
        >
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
            {EMPTY_ART.map((name) => (
              <EmptyState key={name} art={name} title={name} />
            ))}
            <EmptyState title="plain" description="No drawing of its own." />
            <EmptyState size="compact" art="recipes" title="compact" description="In a pane, a sheet or a form." />
          </div>
        </Section>

        <Section
          title="Data surfaces"
          description="The parts a project page is built from (#209). Shown at their awkward sizes, because those are the ones that break."
        >
          <div className="flex flex-col gap-6">
            <div className="grid gap-3 sm:grid-cols-4">
              <StatCard label="Images" value={formatCount(1248)} />
              <StatCard label="Annotations" value={formatCount(6431)} />
              <StatCard label="Classes" value={formatCount(3)} />
              <StatCard
                label="Annotated"
                value={formatPercent(62)}
                context={`${formatCount(774)} of ${formatCount(1248)}`}
              />
            </div>

            {/* A seven-digit count beside a single digit: the case tabular
                figures and thousands separators exist for. */}
            <div className="grid gap-3 sm:grid-cols-2">
              <StatCard label="Annotations" value={formatCount(1234567)} />
              <StatCard label="Classes" value={formatCount(1)} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                {DISTRIBUTION.map((row) => (
                  <DistributionBar
                    key={row.name}
                    label={row.name}
                    count={row.count}
                    // One max for the whole chart, which is what makes the bars
                    // comparable. Derived once, here, and never per row.
                    max={DISTRIBUTION[0].count}
                    color={classColor(undefined, row.name)}
                  />
                ))}
              </div>

              {/* Two real tiles, four placeholders and a "+N" — the state the
                  Overview is in whenever thumbnails are missing. */}
              <ThumbnailGrid
                tiles={[
                  <div key="a" className="size-full bg-primary/20" />,
                  <div key="b" className="size-full bg-primary/10" />,
                  <div key="c" className="size-full" />,
                  <div key="d" className="size-full" />,
                  <div key="e" className="size-full" />,
                ]}
                overflow={1243}
                onOverflow={() => toast("Browse dataset")}
              />
            </div>

            {/* Forty classes is an ordinary Physical AI ontology, and the reason
                the schema editor stopped being a stack of full-width cards. */}
            <div className="max-h-64 w-60 overflow-y-auto rounded-lg border border-border">
              {ONTOLOGY.map((name, index) => (
                <ClassListRow
                  key={name}
                  name={name}
                  geometry={index % 3 === 0 ? "polygon" : "bbox"}
                  count={(index + 1) * 137}
                  color={classColor(undefined, name)}
                  selected={index === 1}
                  onSelect={() => toast(`Selected ${name}`)}
                />
              ))}
            </div>
          </div>
        </Section>

        <Section
          title="Project components"
          description="What the project Overview is composed from: five pointers, the batches at a glance, the class split and the image window. Data-only — view models in, callbacks out."
        >
          <ProjectComponentsDemo />
        </Section>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}

function Section({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** `Badge`'s ten variants, each labelled with its own name — see `BADGE_OFFICIAL`/`BADGE_STATUS`. */
function BadgeRow({ theme }: { readonly theme: "light" | "dark" }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {BADGE_OFFICIAL.map((variant) => (
        <Badge key={variant} variant={variant}>
          {variant}
        </Badge>
      ))}
      {BADGE_STATUS.map((variant) => (
        <Badge key={variant} variant={variant} data-testid={`badge-${variant}-${theme}`}>
          {variant}
        </Badge>
      ))}
    </div>
  );
}

/** A right-hand sheet, opened from an outline trigger — the panel `Dialog` never is. */
function SheetDemo(): JSX.Element {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Open sheet</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>drive-02</SheetTitle>
          <SheetDescription>96 assets, none annotated yet.</SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <Button variant="outline">Close</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Base UI's Combobox, filtered against `DEMO_CLASSES` — see its own docstring. */
function ComboboxDemo(): JSX.Element {
  return (
    <Combobox items={DEMO_CLASSES}>
      <ComboboxInput aria-label="Class" placeholder="Search classes" />
      <ComboboxContent>
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function Swatch({
  name,
  className = "",
  style,
}: {
  readonly name: string;
  readonly className?: string;
  readonly style?: CSSProperties;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  // The stylesheet is the only copy of a token, so the caption asks the browser.
  useEffect(() => {
    if (box.current !== null) setValue(getComputedStyle(box.current).backgroundColor);
  }, []);
  return (
    <div className="flex flex-col gap-1">
      <div ref={box} className={`size-16 rounded-md border border-border ${className}`} style={style} />
      <span className="text-xs text-muted-foreground">{name}</span>
      <span className="font-mono text-xs text-muted-foreground">{value}</span>
    </div>
  );
}

/** Road-sign fixtures from the Paper Overview, so the catalogue shows a full project. */
const ROAD_CLASSES = [
  { name: "Traffic light", annotations: 1076210, assets: 412000 },
  { name: "Speed limit", annotations: 770530, assets: 301000 },
  { name: "Stop sign", annotations: 462318, assets: 220400 },
  { name: "Pedestrian crossing", annotations: 339033, assets: 190300 },
  { name: "Yield sign", annotations: 246569, assets: 140200 },
] as const;

function ProjectComponentsDemo(): JSX.Element {
  const [lens, setLens] = useState<"annotations" | "assets">("annotations");
  const [assetLens, setAssetLens] = useState<"imported" | "dataset">("dataset");
  const [labelClass, setLabelClass] = useState<string | null>(null);
  const totalAnnotations = ROAD_CLASSES.reduce((sum, one) => sum + one.annotations, 0) + 154105;
  const rows = [
    ...ROAD_CLASSES.map((one) => ({
      key: one.name,
      label: one.name,
      color: classColor(undefined, one.name),
      count: lens === "annotations" ? one.annotations : one.assets,
      share: lens === "annotations" ? one.annotations / totalAnnotations : one.assets / 906595,
    })),
    lens === "annotations"
      ? { key: "other", label: "Other · 2 classes", color: null, count: 154105, share: 154105 / totalAnnotations }
      : { key: "other", label: "Other · 2 classes", color: null, count: null, share: null },
  ];
  const tones = ["bg-primary/30", "bg-primary/20", "bg-primary/10", "bg-muted"];
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <ProjectKpi icon={ImageIcon} label="Images" value={formatCount(906595)} context="from 4 sources" />
        <ProjectKpi icon={CircleCheck} label="Annotated" value="76" unit="%" context={`${formatCount(686421)} of ${formatCount(906595)}`} onGo={() => toast("Batches")} />
        <ProjectKpi icon={SquareDashed} label="Annotations" value={formatCount(3048765)} context="7 classes · schema v4" onGo={() => toast("Schema")} />
        <ProjectKpi icon={Database} label="In dataset" value={formatCount(606421)} context="67% of images" onGo={() => toast("Dataset")} />
        <ProjectKpi icon={Tag} label="Latest release" value="v0.6" mono context="Sep 15 · 602,421 images" onGo={() => toast("Dataset")} />
      </div>
      <ClassDistribution
        lens={lens}
        onLensChange={setLens}
        subtitle={lens === "annotations" ? "Share of all annotations" : "Share of images showing each class"}
        rows={rows}
        empty="No annotations yet."
        note="Class imbalance: Lane marking is 2% of annotations"
      />
      <AssetMosaic
        lens={assetLens}
        onLensChange={setAssetLens}
        subtitle={`${formatCount(606421)} in the dataset`}
        {...(assetLens === "dataset"
          ? {
              filter: {
                options: ROAD_CLASSES.map((one) => ({ value: one.name, label: one.name, color: classColor(undefined, one.name) })),
                value: labelClass,
                onChange: setLabelClass,
              },
            }
          : {})}
        tiles={Array.from({ length: 8 }, (_, index) => ({
          id: String(index),
          thumbnail: <div className={`size-full ${tones[index % tones.length]}`} />,
        }))}
        caption={{
          title: "4032 × 3024 · JPEG",
          tag: "v0.6",
          classes: [
            { label: "Traffic light", color: classColor(undefined, "Traffic light"), count: 2 },
            { label: "Stop sign", color: classColor(undefined, "Stop sign"), count: 1 },
          ],
        }}
        overflow={606413}
        onOverflow={() => toast("Browse dataset")}
        loading={false}
        empty="Nothing in the dataset yet."
      />
    </div>
  );
}
