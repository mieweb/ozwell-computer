// One shared /api/v1/events stream. Components subscribe with useServerEvent; the root
// opens the stream from its own effect, which React runs after its children's effects,
// so every listener is attached before the first event (`hello`) can arrive.
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import { isNewBuild } from './version';

const hub = new EventTarget();
const types = new Set<string>();
let source: EventSource | null = null;

type StreamState = 'connecting' | 'open' | 'broken';
let streamState: StreamState = 'connecting';
let streamId: string | null = null;
const setStream = (s: StreamState, id: string | null) => {
  streamState = s;
  streamId = id;
  hub.dispatchEvent(new Event('stream-state'));
};
const onStreamChange = (cb: () => void) => {
  hub.addEventListener('stream-state', cb);
  return () => hub.removeEventListener('stream-state', cb);
};

const forward = (type: string) => source?.addEventListener(type, (e) => hub.dispatchEvent(new MessageEvent(type, { data: e.data })));

/** 'broken' after an error, until the EventSource reconnects. */
export function useServerEventsState() {
  return useSyncExternalStore(onStreamChange, () => streamState);
}

/** The connected stream's `stream_id` (new on every reconnect), or null while it is not connected. */
export function useServerStreamId() {
  return useSyncExternalStore(onStreamChange, () => streamId);
}

export function useServerEvent<T>(type: string, handler: (data: T) => void) {
  const onEvent = useEffectEvent(handler);
  useEffect(() => {
    // Types first used after the stream opened (e.g. by a panel) are forwarded from then on.
    if (!types.has(type)) { types.add(type); forward(type); }
    const listener = (e: Event) => onEvent(JSON.parse((e as MessageEvent<string>).data));
    hub.addEventListener(type, listener);
    return () => hub.removeEventListener(type, listener);
  }, [type]);
}

export function openServerEvents() {
  const s = new EventSource('/api/v1/events');
  source = s;
  s.addEventListener('hello', (e) => {
    const { stream_id, build } = JSON.parse(e.data);
    // Even the first hello may come from an updated server; compare it with the build this page was loaded from.
    if (isNewBuild(__VIEWER_BUILD__, build)) { location.reload(); return; }
    setStream('open', stream_id);
  });
  for (const type of types) forward(type);
  s.onopen = () => setStream('open', streamId);
  s.onerror = () => setStream('broken', null);
  return () => { s.close(); source = null; setStream('connecting', null); };
}
