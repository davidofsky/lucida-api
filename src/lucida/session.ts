import { HttpError } from '../errors.ts';
import { BASE_URL } from './constants.ts';

const CLEARANCE_COOKIE = 'cf_clearance';
const CLEARANCE_TIMEOUT_MS = Number(process.env['CLEARANCE_TIMEOUT_MS'] ?? 60_000);

/** Byparr speaks the FlareSolverr API, so any drop-in replacement also fits. */
const SOLVER_URL = (process.env['SOLVER_URL'] ?? 'http://127.0.0.1:8191').replace(/\/+$/, '');

// The solver enforces its own deadline; this one only guards against it never
// answering at all, so it sits a little beyond the solve budget.
const SOLVER_GRACE_MS = 15_000;

export interface Clearance {
  cookie: string;
  userAgent: string;
}

export class ClearanceError extends HttpError {
  constructor(message: string) {
    super(message, 503);
  }
}

interface SolverResponse {
  status?: string;
  message?: string;
  solution?: {
    status?: number;
    userAgent?: string;
    cookies?: { name?: string; value?: string }[];
  };
}

/**
 * Holds the `cf_clearance` cookie the solver last handed back.
 *
 * The solver drives a stealth browser through Cloudflare's challenge and returns
 * the cookie plus the User-Agent it was issued to. Both travel together on every
 * request, because a clearance cookie is only valid for its own User-Agent.
 */
export class LucidaSession {
  #clearance: Clearance | null = null;
  #refreshing: Promise<Clearance> | null = null;

  async start(): Promise<this> {
    this.#clearance = await this.#solve();
    return this;
  }

  async clearance(): Promise<Clearance> {
    return this.#clearance ?? this.refresh();
  }

  /** Concurrent callers share one solve rather than queueing up behind the browser. */
  async refresh(): Promise<Clearance> {
    if (this.#refreshing) return this.#refreshing;

    this.#refreshing = (async () => {
      try {
        this.#clearance = await this.#solve();
        return this.#clearance;
      } finally {
        this.#refreshing = null;
      }
    })();

    return this.#refreshing;
  }

  async #solve(): Promise<Clearance> {
    let response: Response;

    try {
      response = await fetch(`${SOLVER_URL}/v1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cmd: 'request.get',
          url: BASE_URL,
          maxTimeout: CLEARANCE_TIMEOUT_MS,
        }),
        signal: AbortSignal.timeout(CLEARANCE_TIMEOUT_MS + SOLVER_GRACE_MS),
      });
    } catch (cause) {
      throw new ClearanceError(
        `could not reach the challenge solver at ${SOLVER_URL} ` +
          `(${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }

    if (!response.ok) {
      throw new ClearanceError(`the challenge solver returned ${response.status}`);
    }

    const body = (await response.json()) as SolverResponse;

    if (body.status !== 'ok') {
      throw new ClearanceError(
        `the challenge solver could not clear lucida: ${body.message ?? 'no reason given'}`,
      );
    }

    const cookie = body.solution?.cookies?.find(
      (candidate) => candidate.name === CLEARANCE_COOKIE,
    )?.value;
    const userAgent = body.solution?.userAgent;

    if (!cookie || !userAgent) {
      throw new ClearanceError(
        `the challenge solver returned no ${CLEARANCE_COOKIE} cookie for lucida`,
      );
    }

    return { cookie, userAgent };
  }

  // Nothing to tear down: the solver owns the browser, this only holds a cookie.
  close(): void {
    this.#clearance = null;
  }
}
