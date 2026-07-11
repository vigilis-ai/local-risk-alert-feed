/**
 * Timezone helpers for plugins whose upstream emits "floating" local timestamps
 * (a wall-clock time with no timezone suffix — common in Socrata datasets).
 *
 * We label the reported wall-clock time with the correct UTC offset for the
 * source's timezone rather than shifting it: the instant the source meant is
 * preserved and made unambiguous, which is what the alert contract requires
 * (timezone-qualified ISO-8601 timestamps).
 */

/**
 * UTC offset (e.g. "-07:00") that `ianaZone` is at for the given local wall-clock
 * time, DST-aware via `Intl` `longOffset` (Node 18+). The instant is approximated
 * by reading the local components as UTC, which selects the correct side of a DST
 * boundary except within the ~1h transition window.
 */
export function offsetForZone(localNoZone: string, ianaZone: string): string {
  const approxInstant = new Date(`${localNoZone}Z`).getTime();
  if (Number.isNaN(approxInstant)) return '+00:00';
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: ianaZone, timeZoneName: 'longOffset' })
      .formatToParts(approxInstant)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const off = name.replace(/^GMT/, '');
  return off === '' ? '+00:00' : off;
}

/**
 * Convert a floating local timestamp (no zone) into an ISO-8601 string stamped
 * with the correct offset for `ianaZone`. Accepts `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm[:ss[.sss]]`,
 * or the space-separated Socrata variant. Returns `undefined` when the input
 * can't be parsed, so optional timestamp fields can be omitted rather than
 * emitting an invalid value.
 */
export function zonedIso(
  floatingLocal: string | undefined | null,
  ianaZone: string
): string | undefined {
  const m = floatingLocal
    ?.trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?/);
  if (!m) return undefined;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  const local = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  return `${local}${offsetForZone(local, ianaZone)}`;
}
