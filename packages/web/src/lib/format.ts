const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The browser's resolved IANA zone, used for the "your time" columns. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Display-only rendering of an ISO-8601 UTC instant in an explicit IANA zone. */
export function formatInZone(iso: string | null, timeZone: string): string {
  if (!iso) return '—';
  return formatter(timeZone).format(new Date(iso));
}

export const STATUS_LABELS: Record<string, string> = {
  planned: 'Planned',
  sent: 'Sent',
  delivered: 'Delivered',
  undelivered: 'Undelivered',
  failed: 'Failed',
  skipped_opt_out: 'Opted out',
  not_scheduled: 'Not scheduled',
};
