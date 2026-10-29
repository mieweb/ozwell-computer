import { REASON_STATUS } from '../errors.js';

// OpenAPI fragments shared by the route schemas. Responses are documentation only:
// buildServer serializes with JSON.stringify, so these never reshape a reply.

type Schema = Record<string, unknown>;

export const prop = (type: string | string[], description: string, extra: Schema = {}) => ({ type, description, ...extra });

export const obj = (description: string, properties: Record<string, Schema>, extra: Schema = {}) =>
  ({ type: 'object', description, properties, ...extra });

/** An object whose listed properties are always present. */
export const record = (description: string, properties: Record<string, Schema>, extra: Schema = {}) =>
  obj(description, properties, { required: Object.keys(properties), ...extra });

/** A non-JSON response, e.g. an image or a byte stream. */
export const media = (description: string, contentTypes: string[], schema: Schema = { type: 'string', format: 'binary' }, extra: Schema = {}) => ({
  description,
  content: Object.fromEntries(contentTypes.map((t) => [t, { schema }])),
  ...extra,
});

const errorBody = (description: string) => record(description, {
  error: obj('What went wrong', {
    reason: prop('string', 'Machine-readable cause; it determines the HTTP status', { enum: Object.keys(REASON_STATUS) }),
    message: prop('string', 'Human-readable explanation'),
    feature: prop('string', 'The missing feature, when reason is feature_unsupported'),
    retry_after_ms: prop('integer', 'How long to wait before retrying, when reason is rate_limited'),
  }, { required: ['reason', 'message'] }),
});

/** Every route can fail with the shared error envelope. */
export const errors = {
  '4xx': errorBody('Request error: invalid_request (400), unauthenticated (401), permission_denied (403), target_unavailable or path_not_found (404), stale_* (409), limit_exceeded (413), would_require_activation or checksum_mismatch (422), rate_limited (429)'),
  '5xx': errorBody('Server error: internal (500) or feature_unsupported (501)'),
};

export const ok = record('The operation succeeded', { ok: prop('boolean', 'Always true') });

export const point = record('A point', { x: prop('number', 'X coordinate'), y: prop('number', 'Y coordinate') });

export const bounds = record('Rectangle in root-window (screen) pixels', {
  x: prop('integer', 'Left edge'),
  y: prop('integer', 'Top edge'),
  width: prop('integer', 'Width in pixels'),
  height: prop('integer', 'Height in pixels'),
});

export const windowRef = 'Window id: hex (0x1a00003, as returned by the windows API) or decimal';

export const windowInfo = record('A top-level window', {
  id: prop('string', 'Window id (hex)'),
  epoch: prop('integer', 'Increments when this id is reused by a new window; pass it back to detect stale handles'),
  title: prop('string', 'Window title'),
  app: prop(['string', 'null'], 'WM_CLASS class name (application)'),
  app_instance: prop(['string', 'null'], 'WM_CLASS instance name'),
  pid: prop(['integer', 'null'], 'Owning process id (_NET_WM_PID), if advertised'),
  bounds,
  focused: prop('boolean', 'Whether this is the active window'),
  minimized: prop('boolean', 'Whether the window is minimized (hidden)'),
  maximized: prop('boolean', 'Whether the window is maximized both ways'),
});

export const participant = record('A participant sharing the desktop', {
  participant_id: prop('string', 'Participant id'),
  name: prop('string', 'Display name'),
  kind: prop('string', 'Who this is', { enum: ['human', 'agent'] }),
  color: prop('string', 'Cursor and badge colour (#rrggbb)'),
  cursor: obj('Last reported pointer position (normalized 0..1), or null', {
    x: prop('number', 'X, 0..1 across the screen'),
    y: prop('number', 'Y, 0..1 down the screen'),
    visible: prop('boolean', 'Whether the cursor is drawn'),
  }, { type: ['object', 'null'], required: ['x', 'y', 'visible'] }),
  joined_at: prop('integer', 'Join time (ms since epoch)'),
  last_seen: prop('integer', 'Last activity (ms since epoch)'),
});

export const roster = prop('array', 'Everyone currently on the desktop', { items: participant });

export const inputResult = record('Outcome of an input action', {
  delivery: prop('string', 'How the input was delivered (XTEST input always goes to the foreground)', { enum: ['foreground'] }),
  pointer_moved: prop('boolean', 'Whether the pointer position changed'),
  focus_changed: prop('boolean', 'Whether the active window changed'),
  cursor: { ...point, description: 'Pointer position afterwards, in screen pixels' },
});

export const feature = obj('Availability of a feature', {
  available: prop('boolean', 'Whether the feature can be used'),
  limitation: prop('string', 'Why it is unavailable or limited'),
}, { required: ['available'], additionalProperties: true });

export const jobView = record('State and output of a background command', {
  job_id: prop('string', 'Job id (j-xxxxxxxxxxxx)'),
  state: prop('string', 'Lifecycle state; lost means the process vanished without recording an exit code', { enum: ['running', 'exited', 'timed_out', 'cancelled', 'lost'] }),
  exit_code: prop(['integer', 'null'], 'Exit status once exited or timed_out, else null'),
  command: prop('string', 'The command line as run by /bin/sh'),
  started_at: prop('string', 'Start time', { format: 'date-time' }),
  duration_ms: prop('integer', 'Run time so far, or total once finished'),
  stdout: prop('string', 'Standard output from stdout_offset on (only the newest 50,000 bytes if longer)'),
  stderr: prop('string', 'Standard error from stderr_offset on (only the newest 50,000 bytes if longer)'),
  stdout_offset: prop('integer', 'Byte offset to pass next time to read only newer stdout'),
  stderr_offset: prop('integer', 'Byte offset to pass next time to read only newer stderr'),
  truncated: prop('boolean', 'Whether older output was skipped to fit the limit'),
});

export const execResult = record('Result of a finished command', {
  exit_code: prop(['integer', 'null'], 'Exit status, or null if killed by a signal'),
  signal: prop(['string', 'null'], 'Terminating signal, if any'),
  stdout: prop('string', 'Standard output (up to 8 MiB combined with stderr)'),
  stderr: prop('string', 'Standard error'),
  timed_out: prop('boolean', 'Whether timeout_ms elapsed and the process group was killed'),
  truncated: prop('boolean', 'Whether output beyond 8 MiB was dropped'),
  duration_ms: prop('integer', 'Wall-clock run time'),
});

export const updateStatus = obj('Installed and latest versions, and upgrade progress', {
  supported: prop('boolean', 'Whether in-place upgrades are possible on this install'),
  limitation: prop('string', 'Why upgrades are unsupported'),
  url: prop(['string', 'null'], 'Release index that is checked, or null when checks are disabled'),
  current: prop(['string', 'null'], 'Installed package version'),
  latest: prop(['string', 'null'], 'Newest released version seen'),
  available: prop('boolean', 'Whether latest is newer than current'),
  checked_at: prop(['string', 'null'], 'Time of the last check', { format: 'date-time' }),
  error: prop(['string', 'null'], 'Error from the last check'),
  upgrade: record('Progress of the most recent upgrade', {
    state: prop('string', 'Upgrade state', { enum: ['idle', 'requested', 'running', 'succeeded', 'unchanged', 'failed'] }),
    at: prop(['string', 'null'], 'When the state was reached', { format: 'date-time' }),
    log: prop('string', 'Tail of the upgrade log (last 4000 characters)'),
  }),
}, { required: ['supported', 'url', 'current', 'latest', 'available', 'checked_at', 'error', 'upgrade'] });

export const a11yNode = obj('An accessible element', {
  element_id: prop('string', 'Element id within this snapshot; pass it with snapshot_id to /a11y/act'),
  parent_id: prop(['string', 'null'], 'Parent element id, null for application roots'),
  depth: prop('integer', 'Depth in the tree (0 = application)'),
  role: prop('string', 'Normalized role (button, text_field, menuitem, …)'),
  native_role: prop('string', 'AT-SPI role name'),
  name: prop('string', 'Accessible name'),
  value: prop(['string', 'null'], 'Current value or text, if any'),
  description: prop('string', 'Accessible description'),
  bounds: { ...bounds, type: ['object', 'null'], description: 'Screen rectangle, or null if unknown' },
  states: prop('array', 'AT-SPI states (focused, enabled, checked, …)', { items: { type: 'string' } }),
  actions: prop('array', 'Action names accepted by /a11y/act', { items: { type: 'string' } }),
  app: prop('string', 'Owning application name'),
}, { required: ['element_id', 'parent_id', 'depth', 'role', 'native_role', 'name', 'value', 'description', 'bounds', 'states', 'actions'] });

export const fsPath = prop('string', 'Absolute path (confined to the configured filesystem root)');

const fsEntryProps = {
  path: prop('string', 'Absolute path'),
  type: prop('string', 'Entry type (symlinks are not followed)', { enum: ['file', 'directory', 'symlink', 'other'] }),
  size: prop('integer', 'Size in bytes'),
  mode: prop('string', 'Permission bits in octal, e.g. 644'),
  mtime: prop('string', 'Last modification time', { format: 'date-time' }),
};

export const fsStat = obj('The entry, plus its contents when it is a directory', {
  ...fsEntryProps,
  entries: prop('array', 'Directory contents sorted by name (directories only)', {
    items: record('A directory entry', { name: prop('string', 'Entry name'), ...fsEntryProps }),
  }),
}, { required: Object.keys(fsEntryProps) });

export const upload = record('The stored file', {
  path: prop('string', 'Absolute path written'),
  size: prop('integer', 'Bytes written'),
  sha256: prop('string', 'SHA-256 of the content (hex)'),
});
