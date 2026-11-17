import { randomUUID } from "node:crypto";
import { platformHomeUrl } from "./launcher.ts";
import type { Profile } from "./types.ts";

/** Bitwarden's personal vault JSON. Include only the site's login fields. */
export function serializeBitwarden(profiles: readonly Profile[]): string {
  const groups = new Map<string, string>();
  const items = profiles.filter(profile => profile.username || profile.password || profile.twofa).map(profile => {
    const group = profile.group.trim();
    if (group && !groups.has(group)) groups.set(group, randomUUID());
    const url = platformHomeUrl(profile.platform);
    return {
      id: randomUUID(), organizationId: null, folderId: groups.get(group) ?? null,
      type: 1, reprompt: 0, name: profile.name || profile.username || profile.id, notes: null, favorite: false,
      login: {
        uris: url ? [{ match: null, uri: new URL(url).origin }] : [],
        username: profile.username || null, password: profile.password || null, totp: profile.twofa || null,
      },
    };
  });
  if (!items.length) throw new Error("The selected profiles have no saved site credentials");
  const folders = [...groups].map(([name, id]) => ({ id, name }));
  return JSON.stringify({ encrypted: false, folders, items }, null, 2) + "\n";
}
