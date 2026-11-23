/**
 * Every URL this application answers, in one table.
 *
 * `@visionset/app` is **shell only** — navigation, layout, composition — and this
 * file is the shell's centre. The enterprise rule is that
 * a capability living here instead of in `@visionset/ui-core` is an architecture
 * bug by definition, because the future enterprise UI cannot reuse it. So a route
 * is allowed to decide *which* screen renders and *what its parameters are*, and
 * nothing else: no fetching, no domain logic, no error interpretation.
 *
 * ## Three regions, and the boundary between them is the token
 *
 * | region | routes | inside `TokenGate`? |
 * | --- | --- | --- |
 * | the product | `/`, `/projects`, `/projects/:projectId/:section`, … | yes |
 * | the annotator showcase | `/demo` | **no** |
 * | the design system | `/styleguide` | **no** |
 *
 * The last two need no server and no credential — the showcase's picture is a
 * `data:` URI and the styleguide is pure CSS — so putting them behind the gate
 * would be asking for a token to look at a page that cannot use one. They are also
 * what lets this repository's browser suite run with no backend at all.
 *
 * ## Why those two stopped being separate Vite entries
 *
 * The benchmark had a query parameter and the styleguide a second HTML entry,
 * both because there was no router to put them behind. There is one
 * now, so both are routes and `rollupOptions.input` is gone.
 *
 * The benchmark keeps its query parameter (`/demo?scene=bench`) rather than
 * gaining a route: it is an instrument, its recorded numbers were taken against
 * that exact page, and moving it would change what it measures for no reason
 * anybody asked for. `e2e/assetPixels.spec.ts`'s fixture rides the same route
 * behind `/demo?scene=asset-pixels`, for the same reason: test-only, not linked
 * from the product, so it earns no route of its own either.
 *
 * ## Every route has a screen
 *
 * There are no placeholders left, and the compiler is what says so: an unused
 * function is an error here.
 */

import {
  AnnotationPage,
  assetParamFor,
  DEFAULT_PROJECT_SECTION,
  ModelsScreen,
  isProjectSection,
  resolveProjectTab,
  IngestScreen,
  PROJECT_SECTIONS,
  ProjectFrame,
  ProjectScreen,
  ProjectsScreen,
  type ProjectFrameProps,
  type ProjectSection,
} from "@visionset/ui-core";
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router";
import type { JSX } from "react";

import { AnnotatorDemo } from "./demo/AnnotatorDemo";
import { AssetPixelsFixture } from "./demo/AssetPixelsFixture";
import { BenchmarkHost } from "./demo/BenchmarkHost";
import { ShowcaseFrame } from "./demo/ShowcaseFrame";
import { AppShell, FullBleedPane, ListPane, PaddedPane, ProjectPane } from "./shell/AppShell";
import { Gated } from "./shell/Gated";
import { NotFound } from "./shell/NotFound";
import { Styleguide } from "./styleguide/Styleguide";

export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      {/* The product. Everything under here needs a workspace token. */}
      <Route element={<Gated />}>
        <Route element={<AppShell />}>
          {/* The workspace's lists: full-bleed tables, edge to edge under the
              tabs — `ListPane`, not the padded column. */}
          <Route element={<ListPane />}>
            <Route path="projects" element={<Projects />} />
            {/*
              A top-level destination rather than a project route, per the
              settled decision: a connection carries no project id and
              every project uses the same ones, so nesting it under a project
              would put a workspace-scoped object inside one project's URL.
              `/inference` was its address before the page was named for the
              noun it catalogues; a bookmarked URL is a promise, so it redirects.
            */}
            <Route path="models" element={<ModelsScreen />} />
          </Route>

          {/* Forms and everything else: the padded, centred column. */}
          <Route element={<PaddedPane />}>
            {/* The workspace's front door is the project list. There was a Home
                dashboard here; it was removed, and `/` went back to being what
                it was before one existed. A redirect rather than a second
                rendering of the list, so the list has one address and the rail
                lights one entry for it. */}
            <Route index element={<Navigate to={PARENT.projects} replace />} />
            <Route path="inference" element={<Navigate to={PARENT.models} replace />} />
            <Route path="*" element={<NotFound />} />
          </Route>

          {/*
            Everything that belongs to one project: its navigation column beside
            the content, so the pane is the shell's own rather than the padded
            one. The sections and the ingest flow all
            render inside the same column — only the annotator, which needs the
            whole screen, stands outside it. The bare project URL and the old
            `?tab=` addresses both land on a section, because a URL somebody
            bookmarked is a promise.
          */}
          <Route element={<ProjectPane />}>
            <Route path="projects/:projectId" element={<ProjectRedirect />} />
            <Route path="projects/:projectId/ingest" element={<Ingest />} />
            <Route path="projects/:projectId/batches/:batchId" element={<BatchRedirect />} />
            <Route path="projects/:projectId/:section" element={<Project />} />
          </Route>
        </Route>

        {/*
          The editing surface, and the only product route that stands outside the
          shell: the whole viewport, no main rail, no tabs, no status bar. The
          pixels are the reason — `fitToViewport` derives the zoom from the
          pane's rect — and the way out is the page's own back control, which
          knows the batch it came from. It is a *sibling* of `AppShell` under the
          same `Gated`, so it still needs a workspace token and the shell stays
          composition-only. A route rather than a `useMatch` in the shell, per
          the rule in `AppShell.tsx`. The rail's collapsed preference is
          persisted, so it is still what it was on the way back.
        */}
        <Route element={<FullBleedPane />}>
          <Route path="jobs/:jobId" element={<Annotate />} />
        </Route>
      </Route>

      {/* No token, no server. Also what the browser suite drives. */}
      <Route path="demo" element={<Showcase />} />
      <Route path="styleguide" element={<Styleguide />} />
    </Routes>
  );
}

/**
 * The showcase, the benchmark and the asset-pixels test fixture, each behind
 * its own `scene` query value.
 */
function Showcase(): JSX.Element {
  const [query] = useSearchParams();
  const scene = query.get("scene");
  if (scene === "asset-pixels") return <AssetPixelsFixture />;
  const bench = scene === "bench";
  return (
    <ShowcaseFrame bench={bench}>
      {bench ? <BenchmarkHost wirePane={query.get("chrome") === "wire"} /> : <AnnotatorDemo />}
    </ShowcaseFrame>
  );
}

/**
 * The project screens, and the whole of what composing one means.
 *
 * `ui-core` takes navigation as a callback rather than importing a router — a
 * screen that called `useNavigate` would only work inside a `react-router` tree,
 * which is a dependency the future enterprise UI has no reason to share. Turning
 * that callback into a route change is this file's job, and it is three lines.
 */
function Projects(): JSX.Element {
  const navigate = useNavigate();
  return <ProjectsScreen onOpenProject={(projectId) => void navigate(PARENT.project(projectId))} />;
}

/**
 * Every parent of every sub-view, in one place.
 *
 * A way out navigates to its **declared parent**, never `navigate(-1)`: the
 * destination has to be the same whether the page was reached by clicking
 * through, by pasting a URL, by reloading, or by walking forward from a sibling.
 * History cannot promise that, and on a fresh tab it leaves the application
 * entirely.
 *
 * The parents live here rather than in the screens because a destination is a
 * fact about the *route table*, and `ui-core` deliberately does not have one — the
 * note on `Projects` above is the same rule from the other side.
 * `docs/content/ui/navigation.md` is the prose half of this table.
 *
 * **The split is labels.** A way out needs a name as well as a URL, and a
 * project's name is behind a query `ui-core` makes — this file holds ids and does
 * not fetch, by the rule at the top of it. So the host spells every URL and the
 * screen supplies every label. What could silently drift is a URL, and a URL
 * still has exactly one spelling.
 *
 * A project's sections are path segments, and each is a place. A batch is not
 * one: it opens in the Overview's panel, where batches are listed, and `batch`
 * spells that as the Overview's `?batch=`. `project` itself
 * spells the default section outright rather than the bare project URL, so a
 * way out lands in one hop instead of bouncing through the redirect.
 */
export const PARENT = {
  projects: "/projects",
  //: A rail destination, so nothing declares it as a parent — it is here because
  //: this table is the route map's own index, and an entry point missing from it
  //: is exactly the drift this table exists to prevent. Its own way out is the rail.
  models: "/models",
  section: (projectId: string, section: ProjectSection) => `/projects/${projectId}/${section}`,
  project: (projectId: string) => PARENT.section(projectId, DEFAULT_PROJECT_SECTION),
  dataset: (projectId: string) => PARENT.section(projectId, "dataset"),
  schema: (projectId: string) => PARENT.section(projectId, "schema"),
  batch: (projectId: string, batchId: string) => `${PARENT.project(projectId)}?batch=${encodeURIComponent(batchId)}`,
} as const;

/**
 * Where a project URL without a section goes: its default section, or the
 * section a `?tab=` named when the address is an old one.
 *
 * Pure and exported so the route test can hold every row of it without a
 * browser: `?tab=` is dropped, every other query parameter is kept, a value
 * that has moved (`versions`) lands where it went, and an unknown one lands on
 * the default rather than on a 404 — old links exist, and a stale one is still
 * a promise about the project.
 */
export function projectRedirectTarget(projectId: string, search: string): string {
  const query = new URLSearchParams(search);
  const tab = query.get("tab");
  query.delete("tab");
  const section: ProjectSection =
    tab === null
      ? DEFAULT_PROJECT_SECTION
      : (resolveProjectTab(tab) ?? (isProjectSection(tab) ? tab : DEFAULT_PROJECT_SECTION));
  const rest = query.toString();
  return `${PARENT.section(projectId, section)}${rest === "" ? "" : `?${rest}`}`;
}

/**
 * The bare project URL, and every `?tab=` address that used to be one.
 *
 * `replace`, so Back does not walk into a URL that only ever bounces — a
 * redirect in the history is a trap the second time somebody presses it.
 */
function ProjectRedirect(): JSX.Element {
  const { projectId } = useParams();
  const [query] = useSearchParams();
  if (projectId === undefined) return <NotFound />;
  return <Navigate to={projectRedirectTarget(projectId, query.toString())} replace />;
}

/**
 * The project, and the one screen whose *section* is a path segment.
 *
 * A section that lives only in component state is lost on reload and cannot be
 * linked to — which was half of what the split was meant to fix. So the section
 * is the URL's last segment, and turning a navigation callback into that route
 * change is this file's job the same way it is for every other screen. The
 * screen is handed the spelling too, so its items are real links.
 *
 * `replace` on the write: a section is a view of the same resource, not a
 * place, so clicking through all four and pressing Back should leave the
 * project rather than walk back through Schema.
 *
 * An unknown segment is a 404 rather than a quiet Overview: unlike a `?tab=`
 * value, nothing ever linked to `/projects/:id/anything`, so there is no promise
 * to keep and a typo should say so.
 */
function Project(): JSX.Element {
  const { projectId, section } = useParams();
  const [query, setQuery] = useSearchParams();
  const navigate = useNavigate();
  // The router guarantees the segments exist for this path; the type does not.
  if (projectId === undefined) return <NotFound />;
  // `batches` was a section until its list moved onto the Overview. A link to it
  // is a promise somebody bookmarked, so it lands where the batches now are
  // rather than on a 404.
  if (section === "batches") return <Navigate to={PARENT.project(projectId)} replace />;
  if (!isProjectSection(section)) return <NotFound />;
  return (
    <ProjectScreen
      projectId={projectId}
      tab={section}
      onTabChange={(next) => void navigate(PARENT.section(projectId, next), { replace: true })}
      hrefFor={(next) => PARENT.section(projectId, next)}
      onIngest={() => void navigate(`/projects/${projectId}/ingest`)}
      onOpenBatch={(batchId) => void navigate(PARENT.batch(projectId, batchId))}
      // The open batch is the URL's, so a reload or a pasted link opens the same
      // panel. `replace`: opening batches one after another is looking, not going
      // somewhere, and Back should leave the Overview rather than walk the list.
      openBatchId={query.get("batch")}
      onOpenBatchChange={(batchId) => {
        // A press outside the panel closes it only once the click is over —
        // Radix waits for the click, so a link or a button under the pointer
        // has already navigated by then. `setQuery` spells its address from
        // this render, the Overview's, so taking `?batch=` out of it would
        // put the old page back over the one the press asked for. A close
        // acts only while the address still names a batch.
        if (batchId === null && !new URLSearchParams(window.location.search).has("batch")) return;
        setQuery(
          (now) => {
            const next = new URLSearchParams(now);
            if (batchId === null) next.delete("batch");
            else next.set("batch", batchId);
            return next;
          },
          { replace: true },
        );
      }}
      onOpenJob={(jobId) => void navigate(`/jobs/${jobId}`)}
      // A deleted project's own URL is a 404 waiting to happen, so the parent is
      // where to land — and `replace`, because Back should not walk into it.
      onDeleted={() => void navigate(PARENT.projects, { replace: true })}
    />
  );
}

/**
 * A batch's old address. Batches had a gallery page; they now open in the
 * Overview's panel, which is where every action on a batch lives. A link to the
 * old page is a promise somebody bookmarked, so it lands on that panel —
 * `replace`, so Back does not walk into a URL that only ever bounces.
 */
function BatchRedirect(): JSX.Element {
  const { projectId, batchId } = useParams();
  if (projectId === undefined || batchId === undefined) return <NotFound />;
  return <Navigate to={PARENT.batch(projectId, batchId)} replace />;
}

/**
 * What every page inside a project hands the frame: the sections, their URLs,
 * and where to land once the project is gone. The sections' own
 * route adds the filled control's inputs; a sub-view does not.
 */
function frameProps(
  projectId: string,
  navigate: ReturnType<typeof useNavigate>,
): Omit<ProjectFrameProps, "active" | "children"> {
  return {
    projectId,
    sections: PROJECT_SECTIONS,
    onNavigate: (next) => void navigate(PARENT.section(projectId, next)),
    hrefFor: (next) => PARENT.section(projectId, next),
    // A deleted project's own URL is a 404 waiting to happen, so the parent is
    // where to land — and `replace`, because Back should not walk into it.
    onDeleted: () => void navigate(PARENT.projects, { replace: true }),
  };
}

/**
 * The annotator, and the return leg into its batch.
 *
 * `?asset=` is where somebody said to start; absent — a deep link somebody
 * pasted, or a reload — the page opens on the job's first asset, which is what it
 * always did.
 *
 * "Back to the batch" is passed the project and batch by `AnnotationPage`, because
 * that screen has already walked job → batch to find the pinned schema and this
 * one has not. It is a *navigate* rather than a `navigate(-1)` on purpose: it
 * means "show me this batch" — its panel on the Overview — whether the annotator
 * was reached from a job, by pasting a URL, or by walking forward from another
 * asset.
 *
 * The same argument applies to the **back arrow**, the one control most likely to
 * be wired to history. So this route passes one callback and
 * the page drives both controls with it: the batch is this page's parent, and
 * the arrow means *up*.
 *
 * The parameter is kept true rather than only read. The page says which
 * frame it is showing and this route writes it, which is the split the project's
 * section is on one screen over — `ui-core` imports no router, so spelling a URL
 * is this file's job. `replace` rather than `push`, for the sections' reason
 * applied to frames: with `push`, Back would walk an annotation session backwards
 * one picture at a time, turning the browser's own button into an undo nobody
 * asked for — and the annotator has a real one two keys away.
 */
function Annotate(): JSX.Element {
  const { jobId } = useParams();
  const [query, setQuery] = useSearchParams();
  const navigate = useNavigate();
  if (jobId === undefined) return <NotFound />;
  const asset = query.get("asset");
  return (
    <AnnotationPage
      jobId={jobId}
      {...(asset === null ? {} : { initialAssetId: asset })}
      onOpenGallery={(projectId, batchId) => void navigate(PARENT.batch(projectId, batchId))}
      onAssetChange={(showing) => {
        const next = assetParamFor(showing, query.get("asset"));
        if (next !== null) setQuery({ asset: next }, { replace: true });
      }}
      // The editor's no-connection panel needs somewhere to send somebody.
      // `ui-core` renders no control when this callback is absent.
      onConfigureInference={() => void navigate(PARENT.models)}
    />
  );
}

/**
 * Ingest, and the way out of it.
 *
 * A route that passes no navigation leaves a run that reached `completed` ending
 * the page — the batch it had just filled was reachable only by walking back to
 * the project and finding it in the list. `IngestScreen` names the batch itself;
 * turning that into a URL is this file's job, and it is the same one line as
 * `Project`'s own `onOpenBatch`.
 *
 * The screen refuses a null `batch_id` on its own rather than trusting this
 * callback to be careful — a run creating its own batch has no id until it
 * completes, and one that failed first never gets one.
 */
function Ingest(): JSX.Element {
  const { projectId } = useParams();
  const navigate = useNavigate();
  if (projectId === undefined) return <NotFound />;
  return (
    // Inside the project's frame with no section lit: an ingest is the project's,
    // not any one section's. No `cta` — the flow owns its own dominant action.
    <ProjectFrame {...frameProps(projectId, navigate)} active={null}>
      <IngestScreen
        projectId={projectId}
        onBack={() => void navigate(PARENT.project(projectId))}
        onOpenBatch={(batchId) => void navigate(PARENT.batch(projectId, batchId))}
        // The foreshadowing banner's link: the schema section of the project, and
        // spelling that URL is this file's job.
        onOpenSchema={() => void navigate(PARENT.schema(projectId))}
      />
    </ProjectFrame>
  );
}
