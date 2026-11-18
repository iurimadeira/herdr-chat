// Where the host's WebSocket listens (--listen). A local chat's host listens
// on 127.0.0.1; a remote space's host on its machine's tailnet address, so the
// Mac can reach it. Anything else (0.0.0.0, ::, a LAN or public address)
// would expose the chat beyond the tailnet: the host refuses to start.
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

export const LOOPBACK = "127.0.0.1";

const TAILNET = new BlockList();
TAILNET.addSubnet("100.64.0.0", 10, "ipv4");
TAILNET.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

export type Listen = { address: string; loopback: boolean };

/** The address as given, if it is one a host may listen on; else null. */
export function allowed(ip: string): Listen | null {
  if (ip === LOOPBACK) return { address: ip, loopback: true };
  const family = isIP(ip);
  if (family === 4 && TAILNET.check(ip, "ipv4")) return { address: ip, loopback: false };
  if (family === 6 && TAILNET.check(ip, "ipv6")) return { address: ip, loopback: false };
  return null;
}

function refusal(given: string): Error {
  return new Error(`refusing to listen on ${given}: a host listens only on ${LOOPBACK} or a tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48)`);
}

/** --listen's value (an address or a name, resolved here) as the address to listen on and advertise; throws when it isn't allowed. */
export async function resolveListen(given: string | undefined): Promise<Listen> {
  if (!given) return { address: LOOPBACK, loopback: true };
  if (isIP(given)) {
    const ok = allowed(given);
    if (!ok) throw refusal(given);
    return ok;
  }
  let found: { address: string }[];
  try {
    found = await lookup(given, { all: true });
  } catch (e) {
    throw new Error(`can't resolve --listen ${given}: ${e instanceof Error ? e.message : e}`);
  }
  for (const a of found) {
    const ok = allowed(a.address);
    if (ok) return ok;
  }
  throw refusal(`${given} (${found.map((a) => a.address).join(", ") || "no address"})`);
}
