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
  Badge,
  Breadcrumb,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ClassListRow,
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
  ErrorState,
  FieldHint,
  Input,
  Label,
  LIGHT_THEME,
  LoadingState,
  Progress,
  PROJECT_SECTIONS,
  ProjectNav,
  SectionHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import { IconPlus, IconPointer, IconSquare, IconTrash } from "@tabler/icons-react";
import type { JSX, ReactNode } from "react";

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

export function Styleguide(): JSX.Element {
  return (
    <TooltipProvider>
      <div className="mx-auto flex max-w-[112rem] flex-col gap-6 px-6 py-6">
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
          description="Intent, never a value. The shadcn preset's own vocabulary, plus VisionSet's four justified extensions. Every caption is LIGHT_THEME's value for that name."
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
              <h3 className="text-xs font-medium text-muted-foreground">Chart palette</h3>
              <div className="flex flex-wrap gap-3">
                <Swatch name="chart-1" className="bg-chart-1" />
                <Swatch name="chart-2" className="bg-chart-2" />
                <Swatch name="chart-3" className="bg-chart-3" />
                <Swatch name="chart-4" className="bg-chart-4" />
                <Swatch name="chart-5" className="bg-chart-5" />
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
                    inspected rather than used. Its two product sites are the rail's
                    wordmark and the progress fill. */}
                <Swatch name="brand" className="bg-brand" />
                <Swatch name="success" className="bg-success" />
                <Swatch name="warning" className="bg-warning" />
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

        <Section title="Buttons" description="Five variants, four sizes.">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" data-testid="button-primary">
              <IconPlus className="size-4" aria-hidden="true" />
              New project
            </Button>
            <Button variant="secondary">Cancel</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">
              <IconTrash className="size-4" aria-hidden="true" />
              Delete
            </Button>
            <Button variant="link">Learn more</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="primary" size="icon" aria-label="Select (V)">
                  <IconPointer className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Select (V)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Box (B)">
                  <IconSquare className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Box (B)</TooltipContent>
            </Tooltip>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
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
          <div className="grid max-w-3xl gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sg-name">Project name</Label>
              <Input id="sg-name" defaultValue="highway-survey" />
              <FieldHint>Unique per workspace, case-insensitively.</FieldHint>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sg-geometry">Geometry</Label>
              <Select defaultValue="bbox">
                <SelectTrigger id="sg-geometry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bbox">bbox</SelectItem>
                  <SelectItem value="polygon">polygon</SelectItem>
                  <SelectItem value="classification_tag">classification_tag</SelectItem>
                </SelectContent>
              </Select>
              <FieldHint>A hint, under a field that needs one.</FieldHint>
            </div>
            {/*
              The two-line option. Here because it is a primitive variant
              rather than one screen's styling: an option that is an identifier
              plus the facts about it stacks them, and the trigger shows the same
              two lines the list does because Radix renders the selected item's
              own text into it.
            */}
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Label htmlFor="sg-model">Model</Label>
              <Select defaultValue="facebook/sam2.1-hiera-base-plus">
                <SelectTrigger id="sg-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value="facebook/sam2.1-hiera-tiny"
                    meta="311.9 MB · tiny — fastest, comfortable on a CPU"
                  >
                    facebook/sam2.1-hiera-tiny
                  </SelectItem>
                  <SelectItem
                    value="facebook/sam2.1-hiera-base-plus"
                    meta="647.1 MB · base-plus — the balanced default"
                  >
                    facebook/sam2.1-hiera-base-plus
                  </SelectItem>
                  <SelectItem
                    value="facebook/sam2.1-hiera-large"
                    meta="1.8 GB · large — the most accurate, wants a GPU"
                  >
                    facebook/sam2.1-hiera-large
                  </SelectItem>
                </SelectContent>
              </Select>
              <FieldHint>
                The id at the label role, what it costs beneath it. Nothing truncates.
              </FieldHint>
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Label htmlFor="sg-notes">Description</Label>
              <Textarea id="sg-notes" placeholder="What this dataset is for" />
            </div>
          </div>
        </Section>

        <Section title="Badges and status" description="The domain's states, as intents.">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>draft</Badge>
            <Badge variant="accent">in_annotation</Badge>
            <Badge variant="success">completed</Badge>
            <Badge variant="warning">stale</Badge>
            <Badge variant="outline">outline</Badge>
            <Badge variant="destructive">failed</Badge>
          </div>
          <div className="max-w-md">
            <p className="mb-1 text-xs text-muted-foreground">Ingest — 240 of 412</p>
            <Progress value={58} aria-label="Ingest progress" />
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
                        <Badge variant={batch.state === "in_annotation" ? "accent" : "neutral"}>
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
          description="Inside a project: the one filled control, one link per section with the open one marked, and the overflow — as wide as its widest control. Column at lg and above; the same data as a strip below. The project's identity is the eyebrow above the content (see Section header)."
        >
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
            <div className="flex h-[22rem] overflow-hidden rounded-lg border border-border" data-testid="sg-project-nav-column">
              <ProjectNav
                layout="column"
                sections={PROJECT_SECTIONS}
                active="overview"
                hrefFor={(section) => `#${section}`}
                onNavigate={() => undefined}
                annotate={{
                  targets: [
                    { id: "b2", name: "drive-02", remaining: 7, schemaVersion: 4 },
                    { id: "b1", name: "drive-01", remaining: 240, schemaVersion: 3 },
                  ],
                  onOpen: () => undefined,
                }}
                onIngest={() => undefined}
                onRename={() => undefined}
                onDelete={() => undefined}
              />
              <div className="flex-1 bg-background p-6 text-xs text-muted-foreground">the section</div>
            </div>
            <div className="min-w-0 flex-1 rounded-lg border border-border p-4" data-testid="sg-project-nav-strip">
              <ProjectNav
                layout="strip"
                sections={PROJECT_SECTIONS}
                active="batches"
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
          description="The project's eyebrow — the way out, the name, the active version — then a section's page h1, one line of meta under it, and its own secondary actions on the right. The filled control lives in the navigation, never here."
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Breadcrumb items={[{ label: "Projects", onNavigate: () => undefined }]} />
            <span aria-hidden="true">·</span>
            <span className="font-medium text-foreground">road-signs</span>
            <Badge variant="outline">v4 active</Badge>
          </div>
          <SectionHeader
            as="h2"
            title="Overview"
            meta="11 images · ingested Aug 7, 2026"
            actions={
              <Button variant="secondary">
                <IconPlus className="size-4" aria-hidden="true" />
                Ingest
              </Button>
            }
          />
        </Section>

        <Section
          title="Overlays"
          description="Radix owns the focus trap, the Escape key and the scroll lock."
        >
          <div className="flex flex-wrap gap-2">
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
                  <Button variant="secondary">Cancel</Button>
                  <Button variant="destructive">Delete</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary">Actions</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem>Rename</DropdownMenuItem>
                <DropdownMenuItem>Duplicate schema</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive>Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="secondary"
              data-testid="open-toast"
              onClick={() => toast("Release v0.3 published")}
            >
              Toast
            </Button>
          </div>
        </Section>

        <Section
          title="Loading, empty and error"
          description="The three states every async surface owes."
        >
          <div className="grid gap-4 lg:grid-cols-3">
            <LoadingState rows={3} />
            <EmptyState
              title="No batches yet"
              description="Ingest images or a video to create the first one."
              action={<Button variant="primary">Ingest</Button>}
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
      </div>
      <Toaster />
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

function Swatch({ name, className }: { readonly name: string; readonly className: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className={`size-16 rounded-md border border-border ${className}`} />
      <span className="text-xs text-muted-foreground">{name}</span>
      <span className="font-mono text-xs text-muted-foreground">{LIGHT_THEME[name]}</span>
    </div>
  );
}
