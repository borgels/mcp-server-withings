import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../withings/audit.js';
import { READ_ANNOTATIONS, WRITE_ANNOTATIONS, WITHINGS_CAPABILITIES, searchCapabilities } from '../withings/capabilities.js';
import type { WithingsClient } from '../withings/client.js';
import type { TokenStore } from '../withings/store.js';
import { assertWritesEnabled, requireUser } from '../withings/policy.js';

export interface RegisterOptions {
  onBehalfOf?: string;
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export function registerWithingsTools(
  server: McpServer,
  client: WithingsClient,
  store: TokenStore,
  options: RegisterOptions = {},
): void {
  const available = new Set(WITHINGS_CAPABILITIES.map(c => c.id));

  server.registerTool(
    'withings_search_capabilities',
    { title: 'Search Withings Capabilities', description: 'Find the right Withings tool. Use first.', inputSchema: { query: z.string().trim().default(''), limit: z.number().int().min(1).max(50).default(20) }, annotations: READ_ANNOTATIONS },
    async input => run('withings_search_capabilities', options, input, async () => json(searchCapabilities(input.query, available, input.limit))),
  );

  server.registerTool(
    'withings_connect',
    { title: 'Connect Withings account', description: 'Start linking YOUR Withings account. Returns an authorization URL — open it in your browser, sign into Withings, and approve. After that the data tools work. Needed once (and again only if you disconnect or the link expires).', inputSchema: {}, annotations: { ...WRITE_ANNOTATIONS, readOnlyHint: false } },
    async input =>
      run('withings_connect', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        const already = store.getTokens(user);
        const state = store.createState(user);
        return json({
          alreadyConnected: Boolean(already),
          authorizationUrl: client.authorizeUrl(state),
          instructions: 'Open authorizationUrl in your browser, sign into YOUR Withings account and approve. This link is single-use and expires in 10 minutes.',
        });
      }),
  );

  server.registerTool(
    'withings_status',
    { title: 'Withings Connection Status', description: 'Whether your Withings account is linked and token freshness.', inputSchema: {}, annotations: READ_ANNOTATIONS },
    async input =>
      run('withings_status', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        const t = store.getTokens(user);
        if (!t) return json({ connected: false, hint: 'Run withings_connect to link your account.' });
        return json({ connected: true, withingsUserId: t.withingsUserId, scope: t.scope, connectedAt: new Date(t.connectedAt).toISOString(), accessTokenExpiresAt: new Date(t.accessExpiresAt).toISOString() });
      }),
  );

  server.registerTool(
    'withings_disconnect',
    { title: 'Disconnect Withings', description: 'Remove your stored Withings tokens from this server.', inputSchema: {}, annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true } },
    async input =>
      run('withings_disconnect', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        return json({ disconnected: store.deleteTokens(user) });
      }),
  );

  server.registerTool(
    'withings_get_measures',
    { title: 'Body Measures (Withings)', description: 'Body measurements by type + date range. Common meastypes: 1=weight,5=fat-free mass,6=fat ratio %,8=fat mass,9=diastolic,10=systolic,11=heart pulse,54=SpO2,76=muscle mass,77=hydration,88=bone mass. Defaults to weight+composition.', inputSchema: { meastypes: z.array(z.number().int()).optional().describe('Measure type codes; default weight+composition.'), startDate: ymd.optional(), endDate: ymd.optional(), lastUpdate: z.number().int().optional().describe('Epoch seconds — fetch only newer than this.') }, annotations: READ_ANNOTATIONS },
    async input =>
      run('withings_get_measures', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        return json(await client.call(user, store, '/measure', 'getmeas', {
          meastypes: (input.meastypes ?? [1, 5, 6, 8, 76, 77, 88]).join(','),
          startdate: input.startDate ? epoch(input.startDate) : undefined,
          enddate: input.endDate ? epoch(input.endDate) : undefined,
          lastupdate: input.lastUpdate,
          category: 1,
        }));
      }),
  );

  server.registerTool(
    'withings_get_activity',
    { title: 'Daily Activity (Withings)', description: 'Daily steps/calories/distance/active minutes for a date range.', inputSchema: { startDate: ymd, endDate: ymd, intraday: z.boolean().default(false).describe('High-resolution intraday instead of daily summary.') }, annotations: READ_ANNOTATIONS },
    async input =>
      run('withings_get_activity', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        if (input.intraday) {
          return json(await client.call(user, store, '/v2/measure', 'getintradayactivity', { startdate: epoch(input.startDate), enddate: epoch(input.endDate) }));
        }
        return json(await client.call(user, store, '/v2/measure', 'getactivity', { startdateymd: input.startDate, enddateymd: input.endDate, data_fields: 'steps,distance,elevation,calories,totalcalories,hr_average,active,soft,moderate,intense' }));
      }),
  );

  server.registerTool(
    'withings_get_sleep',
    { title: 'Sleep (Withings)', description: 'Per-night sleep summary, or high-frequency sleep phases with detailed=true.', inputSchema: { startDate: ymd, endDate: ymd, detailed: z.boolean().default(false) }, annotations: READ_ANNOTATIONS },
    async input =>
      run('withings_get_sleep', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        if (input.detailed) {
          return json(await client.call(user, store, '/v2/sleep', 'get', { startdate: epoch(input.startDate), enddate: epoch(input.endDate) }));
        }
        return json(await client.call(user, store, '/v2/sleep', 'getsummary', { startdateymd: input.startDate, enddateymd: input.endDate, data_fields: 'total_sleep_time,deepsleepduration,lightsleepduration,remsleepduration,wakeupduration,sleep_score,hr_average,rr_average,sleep_efficiency' }));
      }),
  );

  server.registerTool(
    'withings_get_workouts',
    { title: 'Workouts (Withings)', description: 'Logged workouts with type, duration, calories, HR.', inputSchema: { startDate: ymd, endDate: ymd }, annotations: READ_ANNOTATIONS },
    async input =>
      run('withings_get_workouts', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        return json(await client.call(user, store, '/v2/measure', 'getworkouts', { startdateymd: input.startDate, enddateymd: input.endDate, data_fields: 'calories,intensity,distance,steps,hr_average,hr_max,hr_min' }));
      }),
  );

  server.registerTool(
    'withings_get_heart',
    { title: 'Heart / ECG (Withings)', description: 'List heart/ECG recordings for a date range, or fetch one ECG signal by signalId.', inputSchema: { startDate: ymd.optional(), endDate: ymd.optional(), signalId: z.number().int().optional() }, annotations: READ_ANNOTATIONS },
    async input =>
      run('withings_get_heart', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        if (input.signalId !== undefined) return json(await client.call(user, store, '/v2/heart', 'get', { signalid: input.signalId }));
        return json(await client.call(user, store, '/v2/heart', 'list', { startdate: input.startDate ? epoch(input.startDate) : undefined, enddate: input.endDate ? epoch(input.endDate) : undefined }));
      }),
  );

  server.registerTool(
    'withings_get_devices',
    { title: 'Devices (Withings)', description: 'Your linked Withings devices.', inputSchema: {}, annotations: READ_ANNOTATIONS },
    async input => run('withings_get_devices', options, input, async () => { const user = requireUser(options.onBehalfOf); return json(await client.call(user, store, '/v2/user', 'getdevice')); }),
  );

  server.registerTool(
    'withings_get_goals',
    { title: 'Goals (Withings)', description: 'Your step/sleep/weight goals.', inputSchema: {}, annotations: READ_ANNOTATIONS },
    async input => run('withings_get_goals', options, input, async () => { const user = requireUser(options.onBehalfOf); return json(await client.call(user, store, '/v2/user', 'getgoals')); }),
  );

  server.registerTool(
    'withings_add_measure',
    { title: 'Log Measure (Withings)', description: 'Manually log a body measurement (e.g. weight in kg). Requires write access.', inputSchema: { type: z.number().int().describe('Measure type code, e.g. 1=weight.'), value: z.number().describe('Value in the base unit (kg for weight).'), date: ymd.optional().describe('Defaults to today.') }, annotations: WRITE_ANNOTATIONS },
    async input =>
      run('withings_add_measure', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        assertWritesEnabled('withings_add_measure');
        // Withings stores measures as value * 10^unit; send unit 0 and the raw value.
        return json(await client.call(user, store, '/v2/measure', 'store', {
          date: input.date ? epoch(input.date) : Math.floor(Date.now() / 1000),
          measuregrps: JSON.stringify([{ measures: [{ value: Math.round(input.value * 1000), unit: -3, type: input.type }] }]),
        }));
      }),
  );
}

async function run<T>(tool: string, options: RegisterOptions, input: unknown, call: () => Promise<T>): Promise<T> {
  const actingAs = options.onBehalfOf ?? '(no identity)';
  await writeAuditEvent({ tool, actingAs, action: 'start', target: auditTarget(input) });
  try {
    const result = await call();
    await writeAuditEvent({ tool, actingAs, action: 'finish', status: 'ok' });
    return result;
  } catch (error) {
    await writeAuditEvent({ tool, actingAs, action: 'error', status: 'error', error: formatUnknownError(error) });
    throw error;
  }
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const v = input as Record<string, unknown>;
  return { startDate: v.startDate, endDate: v.endDate, type: v.type, signalId: v.signalId, query: v.query };
}

function epoch(ymdStr: string): number {
  return Math.floor(new Date(`${ymdStr}T00:00:00Z`).getTime() / 1000);
}

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
