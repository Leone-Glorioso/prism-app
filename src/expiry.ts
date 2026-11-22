// Token expiry reminder. A browser cannot read a token's expiry from GitHub (the header is not exposed to web pages),
// so the user enters the date they chose when creating the token, and the app warns shortly before it.

export const EXPIRY_WARNING_DAYS = 10;

/** Whole calendar days from today (local date) to the expiry date "YYYY-MM-DD". Negative once expired. Null if invalid. */
export function daysLeft(expires: string | undefined, now: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expires ?? '');
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null; // e.g. 2026-02-31
  return Math.round((probe.getTime() - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
}

export interface ExpiryState {
  level: 'expired' | 'soon';
  text: string;
}

export function expiryState(expires: string | undefined, now: Date = new Date()): ExpiryState | null {
  const days = daysLeft(expires, now);
  if (days === null) return null;
  if (days < 0) return { level: 'expired', text: `Your GitHub token expired on ${expires}. Create a new token and enter it under Connection and security.` };
  if (days <= EXPIRY_WARNING_DAYS) {
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    return { level: 'soon', text: `Your GitHub token expires ${when} (${expires}). Create a new one before then and enter it under Connection and security.` };
  }
  return null;
}
