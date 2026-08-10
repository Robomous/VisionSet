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
 * | the product | `/`, `/projects`, `/projects/:projectId`, … | yes |
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
 * anybody asked for.
 *
 * ## Every route has a screen
 *
 * There are no placeholders left, and the compiler is what says so: an unused
 * function is an error here.
 */

import {
  AnnotationPage,
  assetParamFor,
  GalleryScreen,
  InferenceScreen,
  resolveProjectTab,
  IngestScreen,
  ProjectScreen,
  ProjectsScreen,
} from "@visionset/ui-core";
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router";
import type { JSX } from "react";

import { AnnotatorDemo } from "./demo/AnnotatorDemo";
import { BenchmarkHost } from "./demo/BenchmarkHost";
import { ShowcaseFrame } from "./demo/ShowcaseFrame";
import { AppShell, FullBleedPane, PaddedPane } from "./shell/AppShell";
import { Gated } from "./shell/Gated";
import { NotFound } from "./shell/NotFound";
import { Styleguide } from "./styleguide/Styleguide";

export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      {/* The product. Everything under here needs a workspace token. */}
      <Route element={<Gated />}>
        <Route element={<AppShell />}>
          {/* Lists and forms: the padded, `max-w-7xl` column. */}
          <Route element={<PaddedPane />}>
            {/* Home is the project list. There is nothing else a workspace's front
                page could honestly be until a dashboard has numbers to show, and a
                redirect keeps one screen rather than two that drift. */}
            <Route index element={<Navigate to="/projects" replace />} />
            <Route path="projects" element={<Projects />} />
            {/*
              A top-level destination rather than a project route, per the
              settled decision: a connection carries no project id and
              every project uses the same ones, so nesting it under a project
              would put a workspace-scoped object inside one project's URL.
            */}
            <Route path="inference" element={<InferenceScreen />} />
            <Route path="projects/:projectId" element={<Project />} />
            <Route path="projects/:projectId/ingest" element={<Ingest />} />
            <Route path="projects/:projectId/batches/:batchId" element={<Gallery />} />
            {/* The dataset is a project *tab* now, not a route of its own — it
                is the product's central object and it was reachable only through
                an overflow menu, an Overview link, and the last step of an
                onboarding checklist. The old URL stays as a redirect, because a
                URL somebody bookmarked is a promise. */}
            <Route path="projects/:projectId/dataset" element={<DatasetRedirect />} />
            <Route path="*" element={<NotFound />} />
          </Route>

          {/*
            The editing surface, and the only route that takes the whole viewport
            It is a *route* rather than a prop on the shell because that
            keeps `AppShell` composition-only and keeps `ui-core` from fighting
            the container from the inside with negative margins.

            Nested under the same shell as the padded pane, so there is one
            `AppShell` in this tree rather than two that have to be kept
            identical. It is *not* what preserves the rail's collapsed state —
            that survives two sibling shells too, because React reconciles them
            into one instance — and `annotate.spec.ts` asserts the behaviour
            directly rather than through the structure.
          */}
          <Route element={<FullBleedPane />}>
            <Route path="jobs/:jobId" element={<Annotate />} />
          </Route>
        </Route>
      </Route>

      {/* No token, no server. Also what the browser suite drives. */}
      <Route path="demo" element={<Showcase />} />
      <Route path="styleguide" element={<Styleguide />} />
    </Routes>
  );
}

/** The showcase, and the benchmark behind its query parameter. */
function Showcase(): JSX.Element {
  const [query] = useSearchParams();
  const bench = query.get("scene") === "bench";
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
  return <ProjectsScreen onOpenProject={(projectId) => void navigate(`/projects/${projectId}`)} />;
}

/**
 * Every sub-view's parent, in one place.
 *
 * A back affordance navigates to its **declared parent**, never `navigate(-1)`:
 * the destination has to be the same whether the page was reached by clicking
 * through, by pasting a URL, by reloading, or by walking forward from a sibling.
 * History cannot promise that, and on a fresh tab it leaves the application
 * entirely.
 *
 * The parents live here rather than in the screens because a parent is a fact
 * about the *route table*, and `ui-core` deliberately does not have one — the note
 * on `Projects` above is the same rule from the other side. `DESIGN.md`'s
 * **Navigation rules** is the prose half of this table.
 *
 * The gallery's parent carries `?tab=batches`, because landing on the project's
 * default Schema tab after leaving a batch is landing somewhere you were not.
 */
const PARENT = {
  projects: "/projects",
  //: A rail destination, so nothing declares it as a parent — it is here because
  //: this table is the route map's own index, and an entry point missing from it
  //: is exactly the drift this table exists to prevent. Its own way out is the rail.
  inference: "/inference",
  project: (projectId: string) => `/projects/${projectId}`,
  batches: (projectId: string) => `/projects/${projectId}?tab=batches`,
  dataset: (projectId: string) => `/projects/${projectId}?tab=dataset`,
} as const;

/**
 * The project, and the one screen whose *section* is part of the URL.
 *
 * The project page is tabs, and a tab that lives only in component state is
 * lost on reload and cannot be linked to — which was half of what the split was
 * meant to fix. So `?tab=` is the section, and turning it into a tab is this
 * file's job the same way turning a callback into a route change is.
 *
 * `replace` on the write: a tab is a view of the same resource, not a place, so
 * clicking through all three and pressing Back should leave the project rather
 * than walk back through Schema.
 */
function Project(): JSX.Element {
  const { projectId } = useParams();
  const [query, setQuery] = useSearchParams();
  const navigate = useNavigate();
  // The router guarantees the segment exists for this path; the type does not.
  if (projectId === undefined) return <NotFound />;
  const tab = query.get("tab");
  /**
   * A `?tab=` value that has moved is rewritten in the URL, not only resolved.
   *
   * `?tab=versions` still lands on Schema — the history nested inside it — and a
   * screen that quietly rendered the right panel under the wrong query string
   * would leave the address bar lying, and would hand the next person who copies
   * that link the same stale value again. `ui-core` cannot do this itself: it
   * imports no router, so it can only *say* what a value resolves to.
   */
  const settled = resolveProjectTab(tab ?? undefined);
  if (settled !== null && tab !== null) {
    return <Navigate to={`/projects/${projectId}?tab=${settled}`} replace />;
  }
  return (
    <ProjectScreen
      projectId={projectId}
      onBack={() => void navigate(PARENT.projects)}
      {...(tab === null ? {} : { tab })}
      onTabChange={(next) => setQuery({ tab: next }, { replace: true })}
      onIngest={() => void navigate(`/projects/${projectId}/ingest`)}
      onOpenBatch={(batchId) => void navigate(`/projects/${projectId}/batches/${batchId}`)}
      // A deleted project's own URL is a 404 waiting to happen, so the parent is
      // where to land — and `replace`, because Back should not walk into it.
      onDeleted={() => void navigate(PARENT.projects, { replace: true })}
    />
  );
}

/**
 * The gallery, and the one place the product joins its two halves.
 *
 * A route that passes no `onOpenAsset` renders every tile `disabled` and
 * **the annotator was unreachable from inside the app** — reachable only by typing
 * `/jobs/{id}` after reading the id out of the REST API. Every sibling route wired
 * its callbacks; this one looked like an omission because it was one.
 *
 * The two screens are keyed on different things — the gallery lists *assets in a
 * batch*, the annotator opens a *job* — and `asset.job_id` is the only bridge. It
 * is present exactly once the batch leaves `draft`, which is why `Tile`
 * refuses a null one on its own rather than trusting this callback to be careful.
 *
 * The asset travels as a query parameter, not a path segment: `/jobs/:jobId` is the
 * annotator's identity and the asset is *where to start*, which a person can change
 * with the next/previous buttons without the URL becoming a lie.
 */
function Gallery(): JSX.Element {
  const { projectId, batchId } = useParams();
  const navigate = useNavigate();
  if (projectId === undefined || batchId === undefined) return <NotFound />;
  return (
    <GalleryScreen
      projectId={projectId}
      batchId={batchId}
      onBack={() => void navigate(PARENT.batches(projectId))}
      onOpenAsset={(asset) => {
        if (asset.job_id === null || asset.job_id === undefined) return;
        void navigate(`/jobs/${asset.job_id}?asset=${asset.id}`);
      }}
      // The approve dialog's SCHEMA_NOT_FOUND remedy: the schema section
      // is a `?tab=` on the project page, and spelling that URL is this file's job.
      onOpenSchema={() => void navigate(`/projects/${projectId}?tab=schema`)}
      // Where a promotion from this screen lands (F18). The gallery is where a
      // batch is finished, and it had no way to reach the one screen that shows
      // what finishing it produced — a tab of the project now, not a route.
      onOpenDataset={() => void navigate(PARENT.dataset(projectId))}
      // A correction just cut, or this batch's own parent (audit G6). Same
      // route the batch table's rows use — a batch is a batch, whichever screen
      // named it.
      onOpenBatch={(next) => void navigate(`/projects/${projectId}/batches/${next}`)}
      // This screen's whole subject has just stopped existing, so its own
      // URL is a 404 waiting to happen — the Batches tab is where to land, and
      // `replace` so Back does not walk into the gone batch.
      onDeleted={() => void navigate(PARENT.batches(projectId), { replace: true })}
    />
  );
}

/**
 * The dataset's old address, kept as a promise rather than as a screen.
 *
 * `replace`, so Back does not walk into a URL that only ever bounces — a
 * redirect in the history is a trap the second time somebody presses it.
 */
function DatasetRedirect(): JSX.Element {
  const { projectId } = useParams();
  if (projectId === undefined) return <NotFound />;
  return <Navigate to={PARENT.dataset(projectId)} replace />;
}

/**
 * The annotator, and the return leg into the gallery.
 *
 * `?asset=` is where the gallery said to start; absent — a deep link somebody
 * pasted, or a reload — the page opens on the job's first asset, which is what it
 * always did.
 *
 * "Open the gallery" is passed the project and batch by `AnnotationPage`, because
 * that screen has already walked job → batch to find the pinned schema and this
 * one has not. It is a *navigate* rather than a `navigate(-1)` on purpose: the
 * grid button means "show me this batch", and it has to mean that whether the
 * annotator was reached by clicking a tile, by pasting a URL, or by walking
 * forward from another asset.
 *
 * The same argument applies to the **back arrow**, the one control most likely to
 * be wired to history. So this route passes one callback and
 * the page drives both controls with it: the batch gallery is this page's parent,
 * the arrow means *up* and the grid means *show me the grid*, and they coincide
 * because the annotator's parent is the grid.
 *
 * The parameter is kept true rather than only read. The page says which
 * frame it is showing and this route writes it, which is the split `?tab=` is on
 * one screen over — `ui-core` imports no router, so spelling a URL is this file's
 * job. `replace` rather than `push`, for the tabs' reason applied to frames: with
 * `push`, Back would walk an annotation session backwards one picture at a time,
 * turning the browser's own button into an undo nobody asked for — and the
 * annotator has a real one two keys away.
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
      onOpenGallery={(projectId, batchId) =>
        void navigate(`/projects/${projectId}/batches/${batchId}`)
      }
      onAssetChange={(showing) => {
        const next = assetParamFor(showing, query.get("asset"));
        if (next !== null) setQuery({ asset: next }, { replace: true });
      }}
      // The editor's no-connection panel needs somewhere to send somebody.
      // `ui-core` renders no control when this callback is absent.
      onConfigureInference={() => void navigate(PARENT.inference)}
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
    <IngestScreen
      projectId={projectId}
      onBack={() => void navigate(PARENT.project(projectId))}
      onOpenBatch={(batchId) => void navigate(`/projects/${projectId}/batches/${batchId}`)}
      // The foreshadowing banner's link: the schema section is a `?tab=`
      // on the project page, and spelling that URL is this file's job.
      onOpenSchema={() => void navigate(`/projects/${projectId}?tab=schema`)}
    />
  );
}

