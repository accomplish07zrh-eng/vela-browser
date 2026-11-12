import { isSafeProfileId } from "./profile-id.ts";
import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { UiRuntimeOptions } from "./ui.ts";
import type { TrashMutationResult, TrashProfileView } from "./proxy-tools-types.ts";

export async function handleTrashRequest(req: Request, store: ProfileStore, launcher: Launcher, options: UiRuntimeOptions): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const current = () => !req.signal.aborted;
    if (!current()) return json({ ok: false, error: "Request cancelled; reload Trash" }, 409);
    const profiles: TrashProfileView[] = store.listTrashed().map((p) => ({ ...p, canRestore: true, canPurge: true }));
    if (!current()) return json({ ok: false, error: "Request cancelled; reload Trash" }, 409);
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/ui/api/trash") return json({ ok: true, profiles });
    if (req.method !== "POST" || !["/ui/api/trash/restore", "/ui/api/trash/purge"].includes(path)) return json({ ok: false, error: "Unknown Trash operation" }, 404);
    const body = await req.json();
    if (!Array.isArray(body?.ids) || !body.ids.length || body.ids.some((id: unknown) => typeof id !== "string" || !isSafeProfileId(id))) return json({ ok: false, error: "Select profiles in Trash" }, 400);
    const purge = path.endsWith("/purge");
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const ids = [...new Set<string>(body.ids)];
    const results: TrashMutationResult["results"] = [];
    const mutate = async (id: string): Promise<TrashMutationResult["results"][number]> => {
      if (!current()) return { id, status: "failed", code: "cancelled" };
      const profile = byId.get(id);
      if (!profile) return { id, status: "failed", code: "not_in_trash" };
      if (purge ? !profile.canPurge : !profile.canRestore) return { id, status: "failed", code: "permission_denied" };
      await launcher.cacheCleanupSettled(id);
      if (launcher.profileDeletionBlocked(id)) return { id, status: "failed", code: "profile_open" };
      try {
        if (purge) {
          if (!store.isTrashed(id)) return { id, status: "failed", code: "not_in_trash" };
          if (!launcher.removeUserDataDir(id)) throw new Error("cleanup refused");
          store.deleteProfile(id);
        } else if (!store.restoreProfile(id)) {
          return { id, status: "failed", code: "not_in_trash" };
        }
        return { id, status: purge ? "purged" : "restored" };
      } catch (error) {
        return { id, status: "failed", code: "operation_failed" };
      }
    };
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const index = cursor++;
        results[index] = await mutate(ids[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(1, ids.length) }, worker));
    if (!current()) return json({ ok: false, error: "Request cancelled; reload Trash" }, 409);
    return json({ ok: true, results } satisfies TrashMutationResult);
  } catch {
    return json({ ok: false, error: "Trash could not be updated. Refresh and try again." }, 500);
  }
}
