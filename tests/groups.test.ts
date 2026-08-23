import { describe, expect, it } from "vitest";
import {
    isExcluded,
    rebindGroupRecords,
    toLiveGroup,
    unbindGroupId,
    upsertGroupRecord,
} from "../src/groups";
import { groupKey } from "../src/storage";
import { NO_GROUP_ID, type GroupColor, type GroupRecords, type LiveGroup } from "../src/types";

const group = (id: number, title: string, color = "blue"): LiveGroup => ({
    id,
    title,
    color: color as GroupColor,
});

describe("toLiveGroup", () => {
    it("drops untitled groups — they have no identity across a restart", () => {
        expect(toLiveGroup({ id: 1, color: "blue", collapsed: false } as chrome.tabGroups.TabGroup)).toBeNull();
        expect(
            toLiveGroup({ id: 1, title: "", color: "blue", collapsed: false } as chrome.tabGroups.TabGroup),
        ).toBeNull();
    });

    it("keeps titled groups", () => {
        expect(
            toLiveGroup({ id: 7, title: "Work", color: "red", collapsed: true } as chrome.tabGroups.TabGroup),
        ).toEqual({ id: 7, title: "Work", color: "red" });
    });
});

describe("groupKey", () => {
    it("cannot be forged by a title that looks like another key", () => {
        expect(groupKey("Work", "blue")).not.toBe(groupKey("Work blue", "blue"));
        expect(groupKey("a", "blue")).not.toBe(groupKey("a blue", "grey"));
    });
});

describe("upsertGroupRecord", () => {
    it("creates a record with auto-pause on", () => {
        const records = upsertGroupRecord({}, group(1, "Work"));
        expect(records[groupKey("Work", "blue")]).toEqual({
            groupId: 1,
            title: "Work",
            color: "blue",
            excluded: false,
        });
    });

    it("carries the exclusion across a rename and drops the stale key", () => {
        let records = upsertGroupRecord({}, group(1, "Work"));
        records[groupKey("Work", "blue")].excluded = true;

        records = upsertGroupRecord(records, group(1, "Job"));

        expect(records[groupKey("Work", "blue")]).toBeUndefined();
        expect(records[groupKey("Job", "blue")]).toEqual({
            groupId: 1,
            title: "Job",
            color: "blue",
            excluded: true,
        });
    });

    it("carries the exclusion across a recolour", () => {
        let records = upsertGroupRecord({}, group(1, "Work", "blue"));
        records[groupKey("Work", "blue")].excluded = true;

        records = upsertGroupRecord(records, group(1, "Work", "red"));

        expect(Object.keys(records)).toEqual([groupKey("Work", "red")]);
        expect(records[groupKey("Work", "red")].excluded).toBe(true);
    });

    it("does not touch a different group that happens to share the title", () => {
        let records = upsertGroupRecord({}, group(1, "Work", "blue"));
        records = upsertGroupRecord(records, group(2, "Work", "red"));
        expect(Object.keys(records).sort()).toEqual(
            [groupKey("Work", "blue"), groupKey("Work", "red")].sort(),
        );
    });

    it("over-excludes when a rename collides with an already-excluded key", () => {
        let records = upsertGroupRecord({}, group(2, "Job"));
        records[groupKey("Job", "blue")].excluded = true;
        records = upsertGroupRecord(records, group(1, "Work"));

        // group 1 renamed onto the excluded "Job" key
        records = upsertGroupRecord(records, group(1, "Job"));

        expect(records[groupKey("Job", "blue")].excluded).toBe(true);
    });

    it("is pure", () => {
        const before: GroupRecords = {};
        upsertGroupRecord(before, group(1, "Work"));
        expect(before).toEqual({});
    });
});

describe("isExcluded", () => {
    it("applies to every group sharing title + color", () => {
        const records = upsertGroupRecord({}, group(1, "Work"));
        records[groupKey("Work", "blue")].excluded = true;
        expect(isExcluded(records, group(1, "Work"))).toBe(true);
        expect(isExcluded(records, group(99, "Work"))).toBe(true);
        expect(isExcluded(records, group(2, "Work", "red"))).toBe(false);
    });

    it("defaults to auto-pause on for an unknown group", () => {
        expect(isExcluded({}, group(1, "Work"))).toBe(false);
    });
});

describe("rebindGroupRecords", () => {
    it("re-binds fresh ids by title + color", () => {
        const stored = upsertGroupRecord({}, group(1, "Work"));
        stored[groupKey("Work", "blue")].excluded = true;

        const rebound = rebindGroupRecords(stored, [group(42, "Work")]);

        expect(rebound[groupKey("Work", "blue")]).toEqual({
            groupId: 42,
            title: "Work",
            color: "blue",
            excluded: true,
        });
    });

    it("keeps the exclusion of a group that is not open", () => {
        const stored = upsertGroupRecord({}, group(1, "Work"));
        stored[groupKey("Work", "blue")].excluded = true;

        const rebound = rebindGroupRecords(stored, []);

        expect(rebound[groupKey("Work", "blue")]).toMatchObject({
            groupId: NO_GROUP_ID,
            excluded: true,
        });
    });

    it("adds live groups it has never seen", () => {
        const rebound = rebindGroupRecords({}, [group(5, "Fresh", "green")]);
        expect(rebound[groupKey("Fresh", "green")]).toEqual({
            groupId: 5,
            title: "Fresh",
            color: "green",
            excluded: false,
        });
    });
});

describe("unbindGroupId", () => {
    it("forgets the live id but keeps the exclusion", () => {
        const records = upsertGroupRecord({}, group(1, "Work"));
        records[groupKey("Work", "blue")].excluded = true;

        const after = unbindGroupId(records, 1);

        expect(after[groupKey("Work", "blue")]).toEqual({
            groupId: NO_GROUP_ID,
            title: "Work",
            color: "blue",
            excluded: true,
        });
    });
});
