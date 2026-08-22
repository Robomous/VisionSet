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
  DEFAULT_PROJECT_SECTION,
  GalleryScreen,
  HomeScreen,
  InferenceScreen,
  isProjectSection,
  resolveProjectTab,
  IngestScreen,
  PROJECT_SECTIONS,
  ProjectFrame,
  ProjectScreen,
  ProjectsScreen,
  type ProjectSection,
} from "@visionset/ui-core";
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router";
import type { JSX } from "react";

import { AnnotatorDemo } from "./demo/AnnotatorDemo";
import { BenchmarkHost } from "./demo/BenchmarkHost";
import { ShowcaseFrame } from "./demo/ShowcaseFrame";
import { AppShell, FullBleedPane, PaddedPane, ProjectPane } from "./shell/AppShell";
import { Gated } from "./shell/Gated";
import { NotFound } from "./shell/NotFound";
import { Styleguide } from "./styleguide/Styleguide";

export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      {/* The product. Everything under here needs a workspace token. */}
      <Route element={<Gated />}>
        <Route element={<AppShell />}>
          {/* Lists and forms: the padded, centred column. */}
          <Route element={<PaddedPane />}>
            {/* Home was a redirect to the project list, on the reasoning that
                there was nothing else a workspace's front page could honestly be
                until a dashboard had numbers to show. `GET /home` is those
                numbers: what is waiting across every project, and which batch to
                carry on with. The two screens do not drift because they answer
                different questions — this one is *what needs me*, the list is
                *what exists* — and Home links to the list rather than repeating
                it. */}
            <Route index element={<Home />} />
            <Route path="projects" element={<Projects />} />
            {/*
              A top-level destination rather than a project route, per the
              settled decision: a connection carries no project id and
              every project uses the same ones, so nesting it under a project
              would put a workspace-scoped object inside one project's URL.
            */}
            <Route path="inference" element={<InferenceScreen />} />
            <Route path="*" element={<NotFound />} />
          </Route>

          {/*
            Everything that belongs to one project: its navigation column beside
            the content, so the pane is the shell's own rather than the padded
            one. The four sections, the ingest flow and the batch gallery all
            render inside the same column — only the annotator, which needs the
            whole screen, stands outside it. The bare project URL and the old
            `?tab=` addresses both land on a section, because a URL somebody
            bookmarked is a promise.
          */}
          <Route element={<ProjectPane />}>
            <Route path="projects/:projectId" element={<ProjectRedirect />} />
            <Route path="projects/:projectId/ingest" element={<Ingest />} />
            <Route path="projects/:projectId/batches/:batchId" element={<Gallery />} />
            <Route path="projects/:projectId/:section" element={<Project />} />
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
  return <ProjectsScreen onOpenProject={(projectId) => void navigate(PARENT.project(projectId))} />;
}

/**
 * The workspace's front page, and the four edges it hands out.
 *
 * `onContinue` is the one that carries a decision rather than a path. The screen
 * passes a null asset when the batch it is offering has no unlabeled frame left,
 * and the annotator's `?asset=` is *where to start* rather than part of its
 * identity — so a null simply means "open the job wherever it opens", which is
 * what a deep link nobody parameterised already does.
 */
function Home(): JSX.Element {
  const navigate = useNavigate();
  return (
    <HomeScreen
      onContinue={(jobId, assetId) =>
        void navigate(assetId === null ? `/jobs/${jobId}` : `/jobs/${jobId}?asset=${assetId}`)
      }
      onOpenBatch={(projectId, batchId) =>
        void navigate(`/projects/${projectId}/batches/${batchId}`)
      }
      onOpenProject={(projectId) => void navigate(PARENT.project(projectId))}
      onOpenProjects={() => void navigate(PARENT.projects)}
    />
  );
}

/**
 * Every ancestor of every sub-view, in one place.
 *
 * A breadcrumb crumb navigates to its **declared ancestor**, never `navigate(-1)`:
 * the destination has to be the same whether the page was reached by clicking
 * through, by pasting a URL, by reloading, or by walking forward from a sibling.
 * History cannot promise that, and on a fresh tab it leaves the application
 * entirely.
 *
 * The ancestors live here rather than in the screens because a destination is a
 * fact about the *route table*, and `ui-core` deliberately does not have one — the
 * note on `Projects` above is the same rule from the other side. `DESIGN.md`'s
 * **Navigation rules** is the prose half of this table.
 *
 * **This table is walked by hand rather than transitively, and the reason is
 * labels.** A crumb needs a name as well as a URL, and a project's name is behind
 * a query `ui-core` makes — this file holds ids and does not fetch, by the rule at
 * the top of it. So the split is: the host spells every URL, the screen supplies
 * every label and composes the chain from the callbacks it was handed. What could
 * silently drift is a URL, and a URL still has exactly one spelling.
 *
 * A project's sections are path segments, and each is a place: the gallery's
 * chain ends at the Batches section, because landing on the project's default
 * section after leaving a batch is landing somewhere you were not. `project`
 * itself spells the default section outright rather than the bare project URL,
 * so a crumb lands in one hop instead of bouncing through the redirect.
 */
export const PARENT = {
  //: A rail destination, like `inference` below, so nothing declares it as a
  //: parent either. It is here because this table is the route map's own index.
  home: "/",
  projects: "/projects",
  //: A rail destination, so nothing declares it as a parent — it is here because
  //: this table is the route map's own index, and an entry point missing from it
  //: is exactly the drift this table exists to prevent. Its own way out is the rail.
  inference: "/inference",
  section: (projectId: string, section: ProjectSection) => `/projects/${projectId}/${section}`,
  project: (projectId: string) => PARENT.section(projectId, DEFAULT_PROJECT_SECTION),
  batches: (projectId: string) => PARENT.section(projectId, "batches"),
  dataset: (projectId: string) => PARENT.section(projectId, "dataset"),
  schema: (projectId: string) => PARENT.section(projectId, "schema"),
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
  const navigate = useNavigate();
  // The router guarantees the segments exist for this path; the type does not.
  if (projectId === undefined || !isProjectSection(section)) return <NotFound />;
  return (
    <ProjectScreen
      projectId={projectId}
      tab={section}
      onTabChange={(next) => void navigate(PARENT.section(projectId, next), { replace: true })}
      hrefFor={(next) => PARENT.section(projectId, next)}
      backHref={PARENT.projects}
      onBack={() => void navigate(PARENT.projects)}
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
    // Inside the project's frame, with Batches lit: a batch belongs to that
    // section. No `cta` — the gallery owns its own dominant action.
    <ProjectFrame {...frameProps(projectId, navigate)} active="batches">
      <GalleryScreen
        projectId={projectId}
        batchId={batchId}
        onBack={() => void navigate(PARENT.batches(projectId))}
        // The two levels above the Batches section. The gallery is the product's
        // deepest padded page, so it is the one whose chain is three long.
        onOpenProject={() => void navigate(PARENT.project(projectId))}
        onOpenProjects={() => void navigate(PARENT.projects)}
        onOpenAsset={(asset) => {
          if (asset.job_id === null || asset.job_id === undefined) return;
          void navigate(`/jobs/${asset.job_id}?asset=${asset.id}`);
        }}
        // The approve dialog's SCHEMA_NOT_FOUND remedy: the schema section of
        // the project, and spelling that URL is this file's job.
        onOpenSchema={() => void navigate(PARENT.schema(projectId))}
        // Where a promotion from this screen lands (F18). The gallery is where a
        // batch is finished, and it had no way to reach the one screen that shows
        // what finishing it produced — a section of the project now, not a route.
        onOpenDataset={() => void navigate(PARENT.dataset(projectId))}
        // A correction just cut, or this batch's own parent (audit G6). Same
        // route the batch table's rows use — a batch is a batch, whichever screen
        // named it.
        onOpenBatch={(next) => void navigate(`/projects/${projectId}/batches/${next}`)}
        // This screen's whole subject has just stopped existing, so its own
        // URL is a 404 waiting to happen — the Batches section is where to land,
        // and `replace` so Back does not walk into the gone batch.
        onDeleted={() => void navigate(PARENT.batches(projectId), { replace: true })}
      />
    </ProjectFrame>
  );
}

/**
 * What every page inside a project hands the frame: the sections, their URLs,
 * the way out, and where to land once the project is gone. The sections' own
 * route adds the filled control's inputs; a sub-view does not.
 */
function frameProps(
  projectId: string,
  navigate: ReturnType<typeof useNavigate>,
): Omit<Parameters<typeof ProjectFrame>[0], "active" | "children"> {
  return {
    projectId,
    sections: PROJECT_SECTIONS,
    onNavigate: (next) => void navigate(PARENT.section(projectId, next)),
    hrefFor: (next) => PARENT.section(projectId, next),
    backHref: PARENT.projects,
    onBack: () => void navigate(PARENT.projects),
    // A deleted project's own URL is a 404 waiting to happen, so the parent is
    // where to land — and `replace`, because Back should not walk into it.
    onDeleted: () => void navigate(PARENT.projects, { replace: true }),
  };
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
    // Inside the project's frame with no section lit: an ingest is the project's,
    // not any one section's. No `cta` — the flow owns its own dominant action.
    <ProjectFrame {...frameProps(projectId, navigate)} active={null}>
      <IngestScreen
        projectId={projectId}
        onBack={() => void navigate(PARENT.project(projectId))}
        onOpenProjects={() => void navigate(PARENT.projects)}
        onOpenBatch={(batchId) => void navigate(`/projects/${projectId}/batches/${batchId}`)}
        // The foreshadowing banner's link: the schema section of the project, and
        // spelling that URL is this file's job.
        onOpenSchema={() => void navigate(PARENT.schema(projectId))}
      />
    </ProjectFrame>
  );
}
