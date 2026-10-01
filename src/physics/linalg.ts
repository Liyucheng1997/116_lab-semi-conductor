/**
 * Symmetric 5-point sparse matrix on a tensor-product grid (natural ordering k = j·nx + i)
 * and an IC(0)-preconditioned conjugate-gradient solver.
 */
export class Stencil5 {
  readonly n: number;
  readonly diag: Float64Array;
  /** coupling between k and k+1 (x direction) */
  readonly ex: Float64Array;
  /** coupling between k and k+nx (y direction) */
  readonly ey: Float64Array;
  private readonly d: Float64Array;
  private readonly r: Float64Array;
  private readonly z: Float64Array;
  private readonly p: Float64Array;
  private readonly q: Float64Array;

  constructor(readonly nx: number, readonly ny: number) {
    this.n = nx * ny;
    this.diag = new Float64Array(this.n);
    this.ex = new Float64Array(this.n);
    this.ey = new Float64Array(this.n);
    this.d = new Float64Array(this.n);
    this.r = new Float64Array(this.n);
    this.z = new Float64Array(this.n);
    this.p = new Float64Array(this.n);
    this.q = new Float64Array(this.n);
  }

  clear() {
    this.diag.fill(0);
    this.ex.fill(0);
    this.ey.fill(0);
  }

  multiply(x: Float64Array, out: Float64Array) {
    const { nx, n, diag, ex, ey } = this;
    for (let k = 0; k < n; k += 1) {
      let s = diag[k] * x[k];
      if (k + 1 < n) s += ex[k] * x[k + 1];
      if (k >= 1) s += ex[k - 1] * x[k - 1];
      if (k + nx < n) s += ey[k] * x[k + nx];
      if (k >= nx) s += ey[k - nx] * x[k - nx];
      out[k] = s;
    }
  }

  private factor() {
    const { nx, n, diag, ex, ey, d } = this;
    for (let k = 0; k < n; k += 1) {
      let v = diag[k];
      if (k >= 1 && d[k - 1] !== 0) v -= (ex[k - 1] * ex[k - 1]) / d[k - 1];
      if (k >= nx && d[k - nx] !== 0) v -= (ey[k - nx] * ey[k - nx]) / d[k - nx];
      d[k] = v > diag[k] * 1e-6 ? v : diag[k];
    }
  }

  private precondition(r: Float64Array, z: Float64Array) {
    const { nx, n, ex, ey, d } = this;
    for (let k = 0; k < n; k += 1) {
      let v = r[k];
      if (k >= 1) v -= ex[k - 1] * z[k - 1];
      if (k >= nx) v -= ey[k - nx] * z[k - nx];
      z[k] = v / d[k];
    }
    for (let k = n - 1; k >= 0; k -= 1) {
      let v = 0;
      if (k + 1 < n) v += ex[k] * z[k + 1];
      if (k + nx < n) v += ey[k] * z[k + nx];
      z[k] -= v / d[k];
    }
  }

  /** Solve A·x = b in place (x holds the initial guess). Returns iterations used. */
  solve(b: Float64Array, x: Float64Array, tol = 1e-10, maxIter = 2000) {
    const { n, r, z, p, q } = this;
    this.factor();
    this.multiply(x, q);
    let bnorm = 0;
    for (let k = 0; k < n; k += 1) {
      r[k] = b[k] - q[k];
      bnorm += b[k] * b[k];
    }
    bnorm = Math.sqrt(bnorm) || 1;
    this.precondition(r, z);
    p.set(z);
    let rz = 0;
    for (let k = 0; k < n; k += 1) rz += r[k] * z[k];
    let it = 0;
    for (; it < maxIter; it += 1) {
      this.multiply(p, q);
      let pq = 0;
      for (let k = 0; k < n; k += 1) pq += p[k] * q[k];
      if (pq === 0) break;
      const alpha = rz / pq;
      let rnorm = 0;
      for (let k = 0; k < n; k += 1) {
        x[k] += alpha * p[k];
        r[k] -= alpha * q[k];
        rnorm += r[k] * r[k];
      }
      if (Math.sqrt(rnorm) / bnorm < tol) break;
      this.precondition(r, z);
      let rzNew = 0;
      for (let k = 0; k < n; k += 1) rzNew += r[k] * z[k];
      const beta = rzNew / rz;
      rz = rzNew;
      for (let k = 0; k < n; k += 1) p[k] = z[k] + beta * p[k];
    }
    return it + 1;
  }
}
