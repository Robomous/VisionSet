/**
 * The two WebGL2 programs the point-cloud view draws with: one for the points,
 * coloured per point, and one for label edges, one colour a label. Points are
 * depth-tested against each other; edges are drawn over them, because a label
 * hidden inside its own points is a label nobody can check.
 */

const POINTS_VERTEX = `#version 300 es
uniform mat4 u_viewProjection;
uniform float u_pointSize;
in vec3 a_position;
in vec3 a_color;
out vec3 v_color;
void main() {
  gl_Position = u_viewProjection * vec4(a_position, 1.0);
  gl_PointSize = u_pointSize;
  v_color = a_color;
}`;

const POINTS_FRAGMENT = `#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 outColor;
void main() {
  outColor = vec4(v_color, 1.0);
}`;

const LINES_VERTEX = `#version 300 es
uniform mat4 u_viewProjection;
in vec3 a_position;
void main() {
  gl_Position = u_viewProjection * vec4(a_position, 1.0);
}`;

const LINES_FRAGMENT = `#version 300 es
precision mediump float;
uniform vec3 u_color;
out vec4 outColor;
void main() {
  outColor = vec4(u_color, 1.0);
}`;

const POSITION = 0;
const COLOR = 1;

export interface GlLabel {
  readonly color: readonly [number, number, number];
  readonly segments: Float32Array;
}

export class PointCloudRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly pointsProgram: WebGLProgram;
  private readonly linesProgram: WebGLProgram;
  private readonly pointsVao: WebGLVertexArrayObject;
  private readonly linesVao: WebGLVertexArrayObject;
  private readonly positionBuffer: WebGLBuffer;
  private readonly colorBuffer: WebGLBuffer;
  private readonly lineBuffer: WebGLBuffer;
  private pointCount = 0;
  private lineRuns: { readonly first: number; readonly count: number; readonly color: readonly [number, number, number] }[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.pointsProgram = program(gl, POINTS_VERTEX, POINTS_FRAGMENT);
    this.linesProgram = program(gl, LINES_VERTEX, LINES_FRAGMENT);
    this.positionBuffer = required(gl.createBuffer(), "buffer");
    this.colorBuffer = required(gl.createBuffer(), "buffer");
    this.lineBuffer = required(gl.createBuffer(), "buffer");

    this.pointsVao = required(gl.createVertexArray(), "vertex array");
    gl.bindVertexArray(this.pointsVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(POSITION);
    gl.vertexAttribPointer(POSITION, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.enableVertexAttribArray(COLOR);
    gl.vertexAttribPointer(COLOR, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    this.linesVao = required(gl.createVertexArray(), "vertex array");
    gl.bindVertexArray(this.linesVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.enableVertexAttribArray(POSITION);
    gl.vertexAttribPointer(POSITION, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  setPositions(positions: Float32Array): void {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    this.pointCount = Math.floor(positions.length / 3);
  }

  setColors(colors: Uint8Array): void {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
  }

  setLabels(labels: readonly GlLabel[]): void {
    const { gl } = this;
    const total = labels.reduce((sum, label) => sum + label.segments.length, 0);
    const vertices = new Float32Array(total);
    const runs: typeof this.lineRuns = [];
    let at = 0;
    for (const label of labels) {
      vertices.set(label.segments, at);
      runs.push({ first: at / 3, count: label.segments.length / 3, color: label.color });
      at += label.segments.length;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    this.lineRuns = runs;
  }

  draw(viewProjection: Float32Array, width: number, height: number, pointSize: number, showLabels: boolean): void {
    const { gl } = this;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this.pointCount > 0) {
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(this.pointsProgram);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.pointsProgram, "u_viewProjection"), false, viewProjection);
      gl.uniform1f(gl.getUniformLocation(this.pointsProgram, "u_pointSize"), pointSize);
      gl.bindVertexArray(this.pointsVao);
      gl.drawArrays(gl.POINTS, 0, this.pointCount);
    }

    if (showLabels && this.lineRuns.length > 0) {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.linesProgram);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.linesProgram, "u_viewProjection"), false, viewProjection);
      const color = gl.getUniformLocation(this.linesProgram, "u_color");
      gl.bindVertexArray(this.linesVao);
      for (const run of this.lineRuns) {
        gl.uniform3f(color, run.color[0], run.color[1], run.color[2]);
        gl.drawArrays(gl.LINES, run.first, run.count);
      }
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteVertexArray(this.pointsVao);
    gl.deleteVertexArray(this.linesVao);
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteBuffer(this.colorBuffer);
    gl.deleteBuffer(this.lineBuffer);
    gl.deleteProgram(this.pointsProgram);
    gl.deleteProgram(this.linesProgram);
  }
}

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`WebGL could not create a ${what}`);
  return value;
}

function program(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertex = shader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const linked = required(gl.createProgram(), "program");
  gl.attachShader(linked, vertex);
  gl.attachShader(linked, fragment);
  gl.bindAttribLocation(linked, POSITION, "a_position");
  gl.bindAttribLocation(linked, COLOR, "a_color");
  gl.linkProgram(linked);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(linked);
    gl.deleteProgram(linked);
    throw new Error(`WebGL program failed to link: ${log ?? "no log"}`);
  }
  return linked;
}

function shader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const compiled = required(gl.createShader(type), "shader");
  gl.shaderSource(compiled, source);
  gl.compileShader(compiled);
  if (!gl.getShaderParameter(compiled, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(compiled);
    gl.deleteShader(compiled);
    throw new Error(`WebGL shader failed to compile: ${log ?? "no log"}`);
  }
  return compiled;
}

/** A CSS colour as the class palette spells it — `#rgb`, `#rrggbb` or `hsl()` — in `[0, 1]`; white otherwise. */
export function cssColorToRgb(color: string): readonly [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex !== null) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
    return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16) / 255) as unknown as readonly [number, number, number];
  }
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(color.trim());
  if (hsl !== null) {
    const h = (Number(hsl[1]) % 360) / 360;
    const s = Number(hsl[2]) / 100;
    const l = Number(hsl[3]) / 100;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t: number): number => {
      const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
      if (u < 1 / 6) return p + (q - p) * 6 * u;
      if (u < 1 / 2) return q;
      if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
      return p;
    };
    return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
  }
  return [1, 1, 1];
}

const resolved = new Map<string, readonly [number, number, number]>();

/**
 * Any CSS colour a stylesheet can spell — a `var()` token, `oklch()` — as `[0, 1]`
 * channels, read as `host` would paint it. `null` where the browser cannot say.
 */
export function resolveCssColor(host: HTMLElement, color: string): readonly [number, number, number] | null {
  const probe = document.createElement("span");
  probe.style.color = color;
  probe.style.display = "none";
  host.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  if (computed === "") return null;
  const cached = resolved.get(computed);
  if (cached !== undefined) return cached;
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(computed);
  let channels: readonly [number, number, number];
  if (rgb !== null) {
    channels = [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  } else {
    // A colour space `rgb()` cannot carry: let a 2D canvas convert one pixel.
    const pixel = document.createElement("canvas");
    pixel.width = 1;
    pixel.height = 1;
    const context = pixel.getContext("2d", { willReadFrequently: true });
    if (context === null) return null;
    context.fillStyle = computed;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    channels = [r / 255, g / 255, b / 255];
  }
  resolved.set(computed, channels);
  return channels;
}
