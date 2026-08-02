/**
 * The design system, rendered.
 *
 * #128's first acceptance criterion is that *a screen built only from semantic
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
 * the enterprise rule (#58) says composition lives here. It carries no capability
 * a product would want — only the components it is showing.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ClassListRow,
  COLOR,
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
  LoadingState,
  Progress,
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
  toast,
} from "@visionset/ui-core";
import { MousePointer2, Plus, Square, Trash2 } from "lucide-react";
import type { JSX, ReactNode } from "react";

/** The demo schema, borrowed so the swatches show the real palette rule. */
const CLASSES = [
  { name: "vehicle", geometry: "bbox", color: "#38bdf8", attributes: [] },
  { name: "lane", geometry: "polygon", color: "#f97316", attributes: [] },
  { name: "daytime", geometry: "classification_tag", color: "#a3e635", attributes: [] },
  // No colour — `classColor` derives a stable hue from the name instead.
  { name: "pedestrian", geometry: "bbox", color: null, attributes: [] },
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
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6">
        <header className="flex flex-col gap-1 border-b border-border pb-4">
          <h1 className="text-page font-semibold tracking-tight">VisionSet design system</h1>
          <p className="text-meta text-muted-foreground">
            Every primitive <code className="font-mono">@visionset/ui-core</code> exports, composed
            from token utilities only. The contract is <code className="font-mono">DESIGN.md</code>{" "}
            at the repository root.
          </p>
        </header>

        <Section title="Colour" description="Intent, never a value. Orange is an accent.">
          <div className="flex flex-wrap gap-3" data-testid="swatches">
            <Swatch name="primary" className="bg-primary" />
            <Swatch name="foreground" className="bg-foreground" />
            <Swatch name="muted" className="bg-muted" />
            <Swatch name="border" className="bg-border" />
            <Swatch name="destructive" className="bg-destructive" />
            <Swatch name="sidebar" className="bg-sidebar" />
          </div>
        </Section>

        <Section title="Typography" description="One scale. Reuse it; do not invent a size.">
          <p className="text-page font-semibold tracking-tight">Page title — 1.5rem / 600</p>
          <p className="text-section font-semibold">Section title — 1rem / 600</p>
          <p className="text-body">Body — 0.875rem, line-height 1.6</p>
          <p className="text-meta text-muted-foreground">Meta — 0.75rem, muted</p>
        </Section>

        <Section title="Buttons" description="Five variants, four sizes.">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" data-testid="button-primary">
              <Plus className="size-4" aria-hidden="true" />
              New project
            </Button>
            <Button variant="secondary">Cancel</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">
              <Trash2 className="size-4" aria-hidden="true" />
              Delete
            </Button>
            <Button variant="link">Learn more</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="primary" size="icon" aria-label="Select (V)">
                  <MousePointer2 className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Select (V)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Box (B)">
                  <Square className="size-4" aria-hidden="true" />
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
                className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-body"
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
                <span className="text-meta text-muted-foreground">{declared.geometry}</span>
              </span>
            ))}
          </div>
        </Section>

        <Section title="Fields" description="Radix labels; the ring comes from the base layer.">
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
              <FieldHint>Singular per class — picking a class picks a tool.</FieldHint>
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
            <Badge variant="outline">completed</Badge>
            <Badge variant="destructive">failed</Badge>
          </div>
          <div className="max-w-md">
            <p className="mb-1 text-meta text-muted-foreground">Ingest — 240 of 412</p>
            <Progress value={58} aria-label="Ingest progress" />
          </div>
        </Section>

        <Section
          title="Cards, tabs and tables"
          description="The screens are made of these. A tab bar underlines; a 288px panel switches."
        >
          <Tabs defaultValue="batches" data-testid="tabs-underline">
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
                <CardContent className="text-body text-muted-foreground">
                  A card is a border and a 16px radius. The shadow is resting-only.
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* The second variant, at the width it exists for: the annotation page's
              288px side panel (#126), where two equal halves are a switch and not a
              row of page sections. Shown here so every variant that ships has a
              specimen (#182). */}
          <div className="w-72 rounded-lg border border-border bg-muted p-2">
            <Tabs defaultValue="objects" data-testid="tabs-segmented">
              <TabsList variant="segmented" className="w-full">
                <TabsTrigger value="objects">Objects</TabsTrigger>
                <TabsTrigger value="labels">Labels</TabsTrigger>
              </TabsList>
              <TabsContent value="objects" className="text-meta text-muted-foreground">
                3 objects — rows carry the class colour, an eye and a trash.
              </TabsContent>
              <TabsContent value="labels" className="text-meta text-muted-foreground">
                The schema's palette, each row showing the digit it answers to.
              </TabsContent>
            </Tabs>
          </div>
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
                  Overview is in whenever thumbnails are missing (#21). */}
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
        <h2 className="text-section font-semibold">{title}</h2>
        <p className="text-meta text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Swatch({ name, className }: { readonly name: string; readonly className: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className={`size-16 rounded-md border border-border ${className}`} />
      <span className="text-meta text-muted-foreground">{name}</span>
      <span className="font-mono text-meta text-muted-foreground">
        {COLOR[name as keyof typeof COLOR]}
      </span>
    </div>
  );
}
