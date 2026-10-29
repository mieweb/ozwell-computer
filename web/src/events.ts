// One shared /api/v1/events stream. Components subscribe with useServerEvent; the root
// opens the stream from its own effect, which React runs after its children's effects,
// so every listener is attached before the first event (`hello`) can arrive.
import { useEffect, useEffectEvent } from 'react';

const hub = new EventTarget();
const types = new Set<string>();

export function useServerEvent<T>(type: string, handler: (data: T) => void) {
  const onEvent = useEffectEvent(handler);
  useEffect(() => {
    types.add(type);
    const listener = (e: Event) => onEvent(JSON.parse((e as MessageEvent<string>).data));
    hub.addEventListener(type, listener);
    return () => hub.removeEventListener(type, listener);
  }, [type]);
}

export function openServerEvents() {
  const source = new EventSource('/api/v1/events');
  for (const type of types) source.addEventListener(type, (e) => hub.dispatchEvent(new MessageEvent(type, { data: e.data })));
  return () => source.close();
}
