import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { startServer, until, type TestServer } from "./harness";
import { createPage, createSpace, data } from "./harness/spaces-pages";

/**
 * A minute after it starts (and every hour after that) a server deletes for good the pages that have been in the
 * trash longer than the workspace's retention. Two copies are started twenty seconds apart on one database, so one
 * wait shows the default retention and a configured one.
 */
describe.skipIf(process.env.API_TEST_SKIP_SLOW === "1")("trash retention", () => {
  const servers: TestServer[] = [];

  afterAll(async () => {
    for (const server of servers) await server.close();
  });

  test(
    "pages trashed longer ago than the retention (30 days unless set) are purged with their subtrees and files",
    async () => {
      const first = await startServer();
      servers.push(first);
      const { owner } = await first.setupOwner();
      const space = await createSpace(owner, "Retention", "retention");
      const trashedDaysAgo = async (title: string, days: number) => {
        const page = await createPage(owner, { spaceId: space.id, title });
        const file = data(await owner.uploadFile(new File([title], "file.txt", { type: "text/plain" }), page.id));
        data(await owner.post(`/pages/${page.id}/delete`));
        await first.sql`UPDATE pages SET deleted_at = now() - make_interval(days => ${days}, mins => 5) WHERE id = ${page.id}`;
        return { page, file };
      };
      const old = await createPage(owner, { spaceId: space.id, title: "31 days" });
      const oldChild = await createPage(owner, { spaceId: space.id, parentId: old.id, title: "31 days, child" });
      const lateChild = await createPage(owner, { spaceId: space.id, parentId: old.id, title: "trashed yesterday under a parent trashed long ago" });
      const oldFile = data(await owner.uploadFile(new File(["old"], "old.txt", { type: "text/plain" }), oldChild.id));
      data(await owner.post(`/pages/${lateChild.id}/delete`));
      data(await owner.post(`/pages/${old.id}/delete`));
      await first.sql`UPDATE pages SET deleted_at = now() - interval '31 days' WHERE id IN (${old.id}, ${oldChild.id})`;
      await first.sql`UPDATE pages SET deleted_at = now() - interval '1 day' WHERE id = ${lateChild.id}`;
      const d29 = await trashedDaysAgo("29 days", 29);
      const d8 = await trashedDaysAgo("8 days", 8);
      const d6 = await trashedDaysAgo("6 days", 6);
      const live = await createPage(owner, { spaceId: space.id, title: "Never trashed" });
      const liveOld = await createPage(owner, { spaceId: space.id, title: "Old but never trashed" });
      await first.sql`UPDATE pages SET created_at = now() - interval '400 days', updated_at = now() - interval '400 days' WHERE id = ${liveOld.id}`;
      const remaining = async () => (await first.sql`SELECT title FROM pages WHERE space_id = ${space.id} ORDER BY title`).map((r: any) => r.title);
      const onDisk = (file: any) => existsSync(path.join(first.storageDir, "files", file.id, file.name));
      expect(await remaining()).toHaveLength(8);

      // The second copy shares the database and the storage, and runs its own housekeeping twenty seconds later.
      await Bun.sleep(20_000);
      servers.push(await startServer({ keepDatabase: true, env: { STORAGE_PATH: first.storageDir } }));

      // First purge, with the default retention of 30 days.
      await until(async () => !(await remaining()).includes("31 days"), 70_000, "the first purge");
      expect(await remaining()).toEqual(["29 days", "6 days", "8 days", "Never trashed", "Old but never trashed"]);
      // What is under a purged page goes with it, however recently it was trashed itself; so do the files.
      expect(onDisk(oldFile)).toBe(false);
      const [{ files }] = await first.sql`SELECT count(*)::int AS files FROM files WHERE id = ${oldFile.id}`;
      expect(files).toBe(0);
      expect([onDisk(d29.file), onDisk(d8.file), onDisk(d6.file)]).toEqual([true, true, true]);
      expect(data(await owner.get(`/spaces/${space.id}/trash`)).map((p: any) => p.title).sort()).toEqual(["29 days", "6 days", "8 days"]);

      // Second purge, by the other copy, with a retention of 7 days.
      expect(data(await owner.post("/workspace/update", { settings: { trashRetentionDays: 7 } })).workspace.settings).toEqual({ trashRetentionDays: 7 });
      await until(async () => !(await remaining()).includes("8 days"), 40_000, "the second purge");
      expect(await remaining()).toEqual(["6 days", "Never trashed", "Old but never trashed"]);
      expect([onDisk(d29.file), onDisk(d8.file), onDisk(d6.file)]).toEqual([false, false, true]);
      expect(data(await owner.get(`/pages/${live.id}`)).page.deletedAt).toBeNull();
      expect(data(await owner.get(`/pages/${d6.page.id}`)).page.deletedAt).not.toBeNull();
    },
    150_000,
  );
});
