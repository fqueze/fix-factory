import { lookup, reverse } from "node:dns/promises";
import { isIP } from "node:net";
import { hostname } from "node:os";

// The server listens on all interfaces so the page can be opened from other
// machines. Against DNS rebinding (another site's name resolving to this machine),
// it only answers requests whose Host is an IP literal, localhost, this machine's
// name, or a name from config.allowedHosts.
export class HostCheck {
  private names = new Set<string>(["localhost"]);

  constructor(allowedHosts: string[] = [], machineName = hostname()) {
    for (const name of [machineName, machineName.split(".")[0], ...allowedHosts]) {
      this.names.add(name.toLowerCase());
    }
  }

  // Adds the machine's fully qualified name, which os.hostname() often lacks.
  async addFqdn(machineName = hostname()): Promise<void> {
    try {
      const { address } = await lookup(machineName);
      for (const name of await reverse(address)) {
        this.names.add(name.toLowerCase().replace(/\.$/, ""));
      }
    } catch {
      // No DNS entry for this machine: its short name and the IP literals still work.
    }
  }

  // `host` is a Host header: name or IP, with an optional port, IPv6 in brackets.
  allows(host: string | undefined): boolean {
    if (!host) {
      return false;
    }
    const m = host.toLowerCase().match(/^(?:\[([0-9a-f:.]+)\]|([^:\[\]]+))(?::\d{1,5})?$/);
    if (!m) {
      return false;
    }
    if (m[1] !== undefined) {
      return isIP(m[1]) === 6;
    }
    const name = m[2].replace(/\.$/, "");
    return isIP(name) === 4 || this.names.has(name);
  }
}
