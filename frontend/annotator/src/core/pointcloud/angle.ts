/** `angle` turned into `(-π, π]`. */
export function wrapAngle(angle: number): number {
  const turn = 2 * Math.PI;
  const wrapped = ((((angle + Math.PI) % turn) + turn) % turn) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}
