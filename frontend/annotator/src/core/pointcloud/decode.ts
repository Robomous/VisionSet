/**
 * The points route's buffer, read without a copy where the host allows it.
 *
 * Little-endian throughout: a 16-byte header (`VSPC`, u32 version, u32 count,
 * u32 flags), f32 `x, y, z` per point, then f32 intensity per point when flag
 * bit 0 is set, then u8 `r, g, b` per point when bit 1 is set. Anything else —
 * a short or long buffer, another version, a flag this build does not know — is
 * refused rather than read as something it is not.
 */

import type { Point3D } from "../types";

export const POINT_BUFFER_MAGIC = "VSPC";
export const POINT_BUFFER_VERSION = 1;
export const POINT_BUFFER_HEADER_BYTES = 16;
export const POINT_FLAG_INTENSITY = 1;
export const POINT_FLAG_RGB = 2;

export interface PointSample {
  readonly count: number;
  /** `x, y, z` per point, in the scan's declared frame. */
  readonly positions: Float32Array;
  readonly intensity: Float32Array | null;
  /** `r, g, b` per point, one byte a channel. */
  readonly rgb: Uint8Array | null;
}

export interface PointBounds {
  readonly minimum: Point3D;
  readonly maximum: Point3D;
}

export class PointBufferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PointBufferError";
  }
}

const KNOWN_FLAGS = POINT_FLAG_INTENSITY | POINT_FLAG_RGB;
const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function decodePoints(buffer: ArrayBuffer): PointSample {
  if (buffer.byteLength < POINT_BUFFER_HEADER_BYTES) {
    throw new PointBufferError(
      `a point buffer starts with a ${POINT_BUFFER_HEADER_BYTES}-byte header, got ${buffer.byteLength} bytes`,
    );
  }
  const header = new DataView(buffer, 0, POINT_BUFFER_HEADER_BYTES);
  const magic = String.fromCharCode(
    header.getUint8(0),
    header.getUint8(1),
    header.getUint8(2),
    header.getUint8(3),
  );
  if (magic !== POINT_BUFFER_MAGIC) {
    throw new PointBufferError(`not a point buffer: the magic is not ${POINT_BUFFER_MAGIC}`);
  }
  const version = header.getUint32(4, true);
  if (version !== POINT_BUFFER_VERSION) {
    throw new PointBufferError(
      `point buffer version ${version} is not one this build reads (${POINT_BUFFER_VERSION})`,
    );
  }
  const count = header.getUint32(8, true);
  const flags = header.getUint32(12, true);
  if ((flags & ~KNOWN_FLAGS) !== 0) {
    throw new PointBufferError(`point buffer flags ${flags} name a section this build cannot read`);
  }
  const hasIntensity = (flags & POINT_FLAG_INTENSITY) !== 0;
  const hasRgb = (flags & POINT_FLAG_RGB) !== 0;
  const expected =
    POINT_BUFFER_HEADER_BYTES + count * 12 + (hasIntensity ? count * 4 : 0) + (hasRgb ? count * 3 : 0);
  if (buffer.byteLength !== expected) {
    throw new PointBufferError(
      `a point buffer of ${count} points with flags ${flags} is ${expected} bytes, got ${buffer.byteLength}`,
    );
  }

  const positions = float32s(buffer, POINT_BUFFER_HEADER_BYTES, count * 3);
  const intensityAt = POINT_BUFFER_HEADER_BYTES + count * 12;
  const intensity = hasIntensity ? float32s(buffer, intensityAt, count) : null;
  const rgbAt = intensityAt + (hasIntensity ? count * 4 : 0);
  const rgb = hasRgb ? new Uint8Array(buffer, rgbAt, count * 3) : null;
  return { count, positions, intensity, rgb };
}

function float32s(buffer: ArrayBuffer, offset: number, length: number): Float32Array {
  if (LITTLE_ENDIAN_HOST) return new Float32Array(buffer, offset, length);
  const view = new DataView(buffer, offset, length * 4);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** The box around every point, or `null` for an empty sample. */
export function boundsOf(positions: Float32Array): PointBounds | null {
  if (positions.length < 3) return null;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis];
      if (value < minimum[axis]) minimum[axis] = value;
      if (value > maximum[axis]) maximum[axis] = value;
    }
  }
  return {
    minimum: [minimum[0], minimum[1], minimum[2]],
    maximum: [maximum[0], maximum[1], maximum[2]],
  };
}
