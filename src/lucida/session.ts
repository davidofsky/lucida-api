import { launch } from 'cloakbrowser';
import type { Browser, Page } from 'playwright-core';
import { setTimeout as sleep } from 'node:timers/promises';

import { HttpError } from '../errors.ts';
import { BASE_URL } from './constants.ts';
const CLEARANCE_COOKIE = 'cf_clearance';
const CLEARANCE_TIMEOUT_MS = Number(process.env['CLEARANCE_TIMEOUT_MS'] ?? 60_000);
const POLL_INTERVAL_MS = 500;

export interface Clearance {
  cookie: string;
  userAgent: string;
}

export class ClearanceError extends HttpError {
  constructor(message: string) {
    super(message, 503);
  }
}

export class LucidaSession {
  #browser: Browser | null = null;
  #page: Page | null = null;
  #userAgent = '';
  #clearance: Clearance | null = null;
  #refreshing: Promise<Clearance> | null = null;

  get #activePage(): Page {
    if (!this.#page) throw new ClearanceError('Session not started');
    return this.#page;
  }

  async start(): Promise<this> {
    const args = process.env['CHROME_NO_SANDBOX'] ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
    this.#browser = await launch(args.length ? { args } : {});
    this.#page = await this.#browser.newPage();

    this.#userAgent = await this.#page.evaluate(() => navigator.userAgent);
 
    if (!this.#userAgent) {
      throw new ClearanceError('could not read the browser User-Agent');
    }

    this.#clearance = await this.#solve();
    return this;
  }

  async clearance(): Promise<Clearance> {
    return this.#clearance ?? this.refresh();
  }

  async refresh(): Promise<Clearance> {
    if (this.#refreshing) return this.#refreshing;

    this.#refreshing = (async () => {
      try {
        // Cloudflare hands out a new cookie only once the stale one is gone
        await this.#activePage.context().clearCookies({ name: CLEARANCE_COOKIE });
        this.#clearance = await this.#solve();
        return this.#clearance;
      } finally {
        this.#refreshing = null;
      }
    })();

    return this.#refreshing;
  }

  async #solve(): Promise<Clearance> {
    await this.#activePage
      .goto(BASE_URL, { waitUntil: 'domcontentloaded' })
      .catch(() => undefined);

    return { cookie: await this.#waitForClearanceCookie(), userAgent: this.#userAgent };
  }

  async #waitForClearanceCookie(): Promise<string> {
    const deadline = Date.now() + CLEARANCE_TIMEOUT_MS;

    while (true) {
      const cookies = await this.#activePage.context().cookies(BASE_URL);
      const clearance = cookies.find((cookie) => cookie.name === CLEARANCE_COOKIE);

      if (clearance?.value) return clearance.value;

      if (Date.now() >= deadline) {
        throw new ClearanceError(
          `lucida did not issue a ${CLEARANCE_COOKIE} cookie within ${CLEARANCE_TIMEOUT_MS}ms`,
        );
      }

      await sleep(POLL_INTERVAL_MS);
    }
  }

  async close(): Promise<void> {
    if (this.#browser) {
      await this.#browser.close();
      this.#browser = null;
      this.#page = null;
      this.#clearance = null;
    }
  }
}
