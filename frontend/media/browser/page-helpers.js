/**
 * Page-side helpers, served raw — the specs pull this in from inside `page.evaluate`,
 * where they cannot close over anything from the Node side. Plain JS with no build
 * step, because the harness has no bundler and is not meant to need one.
 */

/** The adapter under test, loaded from `dist/` exactly as a consumer would load it. */
export async function materializer() {
  const { MediabunnyVideoMaterializer } = await import("/dist/mediabunny/index.js");
  return new MediabunnyVideoMaterializer();
}

/**
 * A fixture as a real `File`. The name is passed through unchanged, including
 * `garbage.webm`, whose extension says WebM and whose bytes do not — nothing in the
 * adapter is allowed to believe the extension.
 */
export async function fixture(name) {
  const response = await fetch(`/test-fixtures/${name}`);
  return new File([await response.arrayBuffer()], name);
}

/** Every frame, in order, with no back-pressure of its own. */
export function collecting() {
  const frames = [];
  return {
    frames,
    chunks: [],
    async append(chunk) {
      this.chunks.push(chunk.length);
      frames.push(...chunk);
    },
  };
}

/**
 * The centre pixel of a materialized frame, its real decoded dimensions, and the
 * markers its own bytes open and close with. `createImageBitmap` decodes whatever
 * it is handed, so the markers are what say *which* encoding it decoded.
 */
export async function inspectImage(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hex = (at, count) =>
    [...bytes.slice(at, at + count)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  const [r, g, b] = context.getImageData(bitmap.width >> 1, bitmap.height >> 1, 1, 1).data;
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { ...size, rgb: [r, g, b], head: hex(0, 2), tail: hex(bytes.length - 2, 2) };
}

/**
 * Eight solid-colour VP8 frames at 8 fps with key frames at 0 and 4, cut by dropping the
 * first packet. Mediabunny's muxer refuses a first packet that is not labelled key, so
 * the delta frame that now leads is labelled key — what a naive cutter writes. The
 * decoder sees through the label (`verifyKeyPackets`), so the frames before the next
 * real key frame have nothing to decode from and come back `null`.
 */
export async function cutMidGop(colours) {
  const mb = await import("/mediabunny.mjs");
  const canvas = new OffscreenCanvas(64, 64);
  const context = canvas.getContext("2d");
  const whole = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
  const source = new mb.CanvasSource(canvas, {
    codec: "vp8",
    bitrate: mb.QUALITY_VERY_HIGH,
    keyFrameInterval: 0.5,
  });
  whole.addVideoTrack(source, { frameRate: 8 });
  await whole.start();
  for (const [index, colour] of colours.entries()) {
    context.fillStyle = colour;
    context.fillRect(0, 0, 64, 64);
    await source.add(index / 8, 1 / 8);
  }
  source.close();
  await whole.finalize();

  const input = new mb.Input({
    source: new mb.BufferSource(whole.target.buffer),
    formats: mb.ALL_FORMATS,
  });
  const track = await input.getPrimaryVideoTrack();
  const decoderConfig = await track.getDecoderConfig();
  const packets = [];
  for await (const packet of new mb.EncodedPacketSink(track).packets()) packets.push(packet);

  const cut = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
  const passthrough = new mb.EncodedVideoPacketSource("vp8");
  cut.addVideoTrack(passthrough, { frameRate: 8 });
  await cut.start();
  for (const [index, packet] of packets.slice(1).entries()) {
    const type = index === 0 ? "key" : packet.type;
    await passthrough.add(
      new mb.EncodedPacket(packet.data, type, packet.timestamp, packet.duration),
      index === 0 ? { decoderConfig } : undefined,
    );
  }
  passthrough.close();
  await cut.finalize();
  input.dispose();
  return {
    encodedTypes: packets.map((packet) => packet.type),
    file: new File([cut.target.buffer], "cut-mid-gop.webm"),
  };
}
