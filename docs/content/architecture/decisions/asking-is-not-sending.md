# Asking is not sending

Requesting a suggestion and posting one to a route are separate concerns. The editor owns the
first and knows nothing about the second, and every answer arrives in one shape regardless of
what produced it.

## The two halves

A `SuggestionRequest` is what is being asked: whose asset, every accumulated positive and
negative point in placement order, the geometry kinds this ask will accept, and where the
adjustments stand. A `SuggestionExecutor` answers one.

```ts
interface SuggestionExecutor {
  suggest(request: SuggestionRequest, signal?: AbortSignal): Promise<SuggestionOut>;
}
```

The request carries no connection id. That omission is the whole of the type's argument: where
an answer gets routed is the executor's own business, fixed when the executor is built, and the
question being asked is the same question either way.

`useServerSuggestionExecutor()` is the shipped implementation. It posts to `/inference/suggest`
exactly as the editor used to, and it answers `null` when there is no usable connection -
because "there is nowhere to send this" is a state
[`usableConnection()`](../frontend/ui-core.md) already reports through its blocker, and the
panel renders that blocker. An executor that existed only to refuse would put a second spelling
of the same fact in front of the reader.

## Why the editor cannot just call the route

The editor owns a suggestion session: accumulated points, a serial stamped on every ask, and
the rule that a slow first answer may not overwrite a fast second one. None of that is
transport, but before this seam existed none of it could be reused either. The ask went
straight into a call whose body requires a connection, so a second kind of answer could only
arrive by fabricating a connection to satisfy the type - which
[a connection is not a browser](a-connection-is-not-a-browser.md) forbids - or by forking the
call site into branches that each re-implement the serial discipline.

The serial discipline is the part that must not be duplicated. It is the only thing standing
between a slow answer and the wrong shape appearing over the right one.

## One answer shape

Every executor returns `SuggestionOut`: a model reference, a confidence, the proposed regions
with their unsimplified contours, the tolerance that was applied, and which parameters have any
effect. The editor reads it through one function, which drops a region whose geometry will not
parse rather than losing the whole answer, and hands the result to the headless annotator.

Nothing downstream asks where the answer came from. That is what makes a second kind of
executor a change to *what the chooser offers* rather than a second state machine - and it is
why the shape is a decision rather than a convenience.

## What this forbids

- a suggestion state machine that exists once per kind of executor;
- an answer shape that varies by who produced it, or a second conversion beside the existing
  one;
- reading transport facts - a connection, a route, a status code - inside the session;
- an executor that reports a refusal as prose of its own rather than rejecting with a cause the
  shared refusal reader can interpret;
- pushing any of this into [`@visionset/annotator`](../frontend/annotator.md), which is
  headless and owns no transport at all.
