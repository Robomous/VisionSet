# The image embedding stays in the worker

The tensor EfficientSAM-Ti's encoder produces for a prepared image lives in
`@visionset/browser-inference`'s worker and nowhere else. It is never returned to the caller,
never accepted from one, and the worker never holds more than one at a time.

## What the two graphs actually cost

EfficientSAM-Ti is two ONNX graphs of deliberately unequal cost, and the numbers, not the
architecture diagram, are the argument for everything below. In a headless Chromium running
`onnxruntime-web` on WASM, single-threaded: the first `prepareImage` - model load and encode,
fused - takes 6,546.8 ms; the first decode takes 135.7 ms; five further refinements each decode
in roughly 110-112 ms, flat. Model load and encode against a warm decode is a ratio of about 60x.
Python ORT on CPU, running the same two graphs outside a browser entirely, shows the same shape:
encoder 620-648 ms, decoder 14-22 ms. Two runtimes, two orders of magnitude apart in absolute
time, and the same ratio - which is what makes it a property of the model rather than an artifact
of WASM being slow.

The tensor that ratio buys is `1x256x64x64` float32: 4,194,304 bytes. `prepare()` produces it
once; every `suggest()` after that reuses it and touches the encoder not at all. The whole reason
a persistent worker exists - see
[the inference worker is persistent](the-inference-worker-is-persistent.md) - is that this
tensor, and the session that produced it, are worth keeping between clicks. This page is about
what keeping it costs when a caller is tempted to reach in and touch it anyway.

## Crossing the boundary buys nothing

A structured clone of a 4 MiB `Float32Array` is not free, and sending the embedding to the main
thread only to hand it back on the next `suggest()` would move 8 MB per refinement - out once, in
again - for a `suggest()` call that would still have to run the decoder against it worker-side
regardless. There is no version of "expose the embedding" that skips the expensive part; there is
only a version that also pays a clone for it. Nothing about the API needs the tensor outside the
worker: a caller that wants a mask calls `suggest()`, and the value on the other side of
`prepareImage()`'s promise is a `PreparedImage` - width, height, an opaque handle - never the
tensor itself.

## One slot, not a cache

The worker holds exactly one prepared image. Calling `prepareImage()` again replaces it, and the
old handle answers nothing afterwards - a `suggest()` against it fails with `image-superseded`
rather than quietly running against whatever is prepared now. That failure mode is the one this
decision refuses to let happen the other way: a superseded handle must never be silently
satisfied with the *current* image's mask, because a caller reading that answer would attribute
someone else's segmentation to the image they asked about.

A cache of several embeddings, keyed per image, is a reasonable-sounding next step and exactly
the one this page declines to take pre-emptively. Each slot is another 4 MiB retained for the
life of the runtime, on top of two loaded sessions, for a workflow - preparing several images and
flipping between them - that nothing in this codebase does yet. One slot is the whole of what the
current workflow needs; a second is a cost this decision is unwilling to carry until a real
workflow, measured, says it pays for itself.

## A refused prompt, not a smaller one

EfficientSAM-Ti's decoder graph takes at most six points. A prompt over that limit is refused,
not truncated to the first six - a caller who sent nine points asked a question about nine
points, and answering as though they had sent six would be a wrong answer wearing the shape of a
right one, with nothing in the response to say so.

The same refusal, for a sharper reason, applies to any negative point. `PointPrompt` carries a
`negative` field because a promptable-segmentation model in general can have a background class,
but EfficientSAM-Ti's prompt encoder does not: it has a learned type embedding for a positive
point and none for a background one, so a point labelled "negative" is not subtracted from the
mask - it is read as one more positive point. Sending it anyway, on the grounds that the field
exists on the type, would answer a question the caller did not ask while looking exactly like an
answer to the one they did. The model refuses the prompt instead of guessing at what a label the
graph cannot represent was supposed to mean.

## What this forbids

- returning an image embedding to the main thread, or accepting one from it;
- re-running the encoder for a prompt against an image already prepared;
- holding more than one prepared image, until a measurement says a window pays for itself;
- answering a prompt against a superseded handle with the current image's mask;
- trimming a prompt to fit the model's point limit instead of refusing it;
- sending a negative point to a model with no background embedding, on the grounds that the
  field exists.

## What would have to change to revisit it

A workflow that genuinely needs more than one prepared image live at once, with a measurement of
what that costs in retained memory against what it saves in re-encoding - not the existence of
the workflow alone, since the one-slot policy already tolerates preparing a new image whenever a
caller wants one, just not two at once. Nothing here is about whether a second model could ever
have a real background embedding; a model that does gets a `negative` field that means something,
without this page needing to be reopened.
