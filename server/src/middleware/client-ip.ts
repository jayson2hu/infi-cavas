import { isIP } from "node:net";

// Enable only when the server is reachable exclusively through a proxy that overwrites X-Real-IP.
export function resolveClientIp(socketIp: string | undefined, realIp: string | undefined, trustProxy: boolean) {
  if (trustProxy && realIp && isIP(realIp)) return realIp;
  return socketIp && isIP(socketIp) ? socketIp : "unknown";
}
