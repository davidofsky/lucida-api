import { HttpError } from '../errors.ts';
import { BASE_URL } from './constants.ts';
import type { LucidaSession } from './session.ts';

export class LucidaError extends HttpError {}

let session: LucidaSession | null = null;

export function useSession(value: LucidaSession | null): void {
  session = value;
}

/** A hand-copied cookie is an escape hatch that skips the browser entirely. */
export function hasManualClearance(): boolean {
  return Boolean(process.env['CF_CLEARANCE'] && process.env['USER_AGENT']);
}

async function clearanceHeaders(): Promise<Record<string, string>> {
  const manualCookie = process.env['CF_CLEARANCE'];
  const manualUserAgent = process.env['USER_AGENT'];

  if (manualCookie && manualUserAgent) {
    return { cookie: `cf_clearance=${manualCookie}`, 'user-agent': manualUserAgent };
  }

  if (session === null) return {};

  const clearance = await session.clearance();

  return {
    cookie: `cf_clearance=${clearance.cookie}`,
    'user-agent': clearance.userAgent,
  };
}

export async function request(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(await clearanceHeaders()), ...init.headers },
  });

  if (response.status === 403 && retry && session !== null) {
    await session.refresh();
    return request(url, init, false);
  }

  return response;
}

export async function checkAvailability(): Promise<'available' | 'captcha' | 'unavailable'> {
  const response = await request(BASE_URL);

  if (response.status === 200) return 'available';
  if (response.status === 403) return 'captcha';
  return 'unavailable';
}
