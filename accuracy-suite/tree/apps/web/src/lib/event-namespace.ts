/** A namespaced DOM listener, as older plugins build it. */
export function namespaced(eventType: string, space: string): string {
  return eventType + '.' + space;
}
