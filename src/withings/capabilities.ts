export interface WithingsCapability {
  id: string;
  title: string;
  description: string;
  risk: 'read' | 'write' | 'auth';
  keywords: string[];
}

export const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const SELF = 'Only ever returns YOUR OWN Withings data (bound to your verified identity).';

export const WITHINGS_CAPABILITIES: WithingsCapability[] = [
  { id: 'withings_search_capabilities', title: 'Search Withings Capabilities', description: 'Find the right Withings tool.', risk: 'read', keywords: ['help', 'discover'] },
  { id: 'withings_connect', title: 'Connect Withings account', description: 'Start linking YOUR Withings account: returns an authorization link to open in your browser and approve. Needed once before any data tools work.', risk: 'auth', keywords: ['connect', 'link', 'auth', 'login', 'forbind'] },
  { id: 'withings_status', title: 'Withings Connection Status', description: 'Whether your Withings account is linked, which Withings user id, and token freshness.', risk: 'read', keywords: ['status', 'connected'] },
  { id: 'withings_disconnect', title: 'Disconnect Withings', description: 'Remove your stored Withings tokens from this server.', risk: 'auth', keywords: ['disconnect', 'revoke', 'logout'] },
  { id: 'withings_get_measures', title: 'Body Measures (Withings)', description: `Weight, fat mass/ratio, muscle/bone/hydration, blood pressure, heart pulse, SpO2, temperature, etc. by measure type + date range. ${SELF}`, risk: 'read', keywords: ['weight', 'vægt', 'fedt', 'blodtryk', 'spo2', 'measures', 'body'] },
  { id: 'withings_get_activity', title: 'Daily Activity (Withings)', description: `Daily steps, calories, distance, active minutes for a date range. ${SELF}`, risk: 'read', keywords: ['steps', 'skridt', 'activity', 'aktivitet', 'calories'] },
  { id: 'withings_get_sleep', title: 'Sleep (Withings)', description: `Per-night sleep summary (duration, stages, score) or high-frequency sleep phases. ${SELF}`, risk: 'read', keywords: ['sleep', 'søvn', 'stages', 'score'] },
  { id: 'withings_get_workouts', title: 'Workouts (Withings)', description: `Logged workouts with type, duration, calories, heart-rate data. ${SELF}`, risk: 'read', keywords: ['workouts', 'træning', 'exercise'] },
  { id: 'withings_get_heart', title: 'Heart / ECG (Withings)', description: `List heart/ECG recordings, or fetch one ECG signal by id. ${SELF}`, risk: 'read', keywords: ['heart', 'ecg', 'puls', 'afib'] },
  { id: 'withings_get_devices', title: 'Devices (Withings)', description: `Your linked Withings devices (scales, watches, BP monitors) and battery. ${SELF}`, risk: 'read', keywords: ['devices', 'enheder', 'scale', 'vægt'] },
  { id: 'withings_get_goals', title: 'Goals (Withings)', description: `Your step/sleep/weight goals. ${SELF}`, risk: 'read', keywords: ['goals', 'mål'] },
  { id: 'withings_add_measure', title: 'Log Measure (Withings)', description: `Manually log a body measurement (e.g. weight). Requires write access. ${SELF}`, risk: 'write', keywords: ['log', 'add', 'vægt', 'weight', 'measure'] },
];

export function searchCapabilities(query: string, available: Set<string>, limit = 20): WithingsCapability[] {
  const pool = WITHINGS_CAPABILITIES.filter(c => available.has(c.id));
  const q = query.trim().toLowerCase();
  if (!q) return pool.slice(0, limit);
  return pool
    .map(c => ({ c, score: q.split(/\s+/).filter(Boolean).reduce((s, t) => s + ([c.id, c.title, c.description, ...c.keywords].join(' ').toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.c);
}
