/**
 * Most agency servers don't send CORS headers. Every third-party GTFS ZIP URL
 * and GTFS-RT protobuf URL is wrapped with the SysDevRun CORS proxy.
 * Local files (drag & drop) never go through the proxy.
 */
export function proxied(httpsUrl: string): string {
  if (!httpsUrl.startsWith('https://')) throw new Error('https:// URLs only');
  return `https://gtfs-proxy.sys-dev-run.re/proxy/${httpsUrl.slice(8)}`;
}
