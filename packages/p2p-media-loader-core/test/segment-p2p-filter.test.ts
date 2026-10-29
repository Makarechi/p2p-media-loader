import { describe, expect, it, vi } from "vitest";
import { Core } from "../src/core.js";
import { CoreRequestError, Segment, StreamType } from "../src/types.js";
import {
  SegmentWithStream,
  StreamWithSegments,
} from "../src/internal-types.js";
import { P2PLoader } from "../src/p2p/loader.js";
import { generateQueue } from "../src/utils/queue.js";
import { SegmentMemoryStorage } from "../src/segment-storage/segment-memory-storage.js";

function segment(id: number, isP2PDisabled?: boolean): Segment {
  return {
    runtimeId: `segment-${id}`,
    externalId: id,
    url: `https://example.com/segment-${id}.ts`,
    startTime: id * 4,
    endTime: (id + 1) * 4,
    isP2PDisabled,
  };
}

function registerStream(core: Core, type: StreamType = "main") {
  const runtimeId = `${type}-stream`;
  core.addStreamIfNoneExists({
    runtimeId,
    type,
    properties: { bitrate: 1000 },
  });
  return runtimeId;
}

describe("per-segment P2P exclusion", () => {
  it.each(["main", "secondary"] as const)(
    "keeps excluded %s segments registered but only allows content to load",
    (type) => {
      const core = new Core({ swarmId: "test" });
      const streamId = registerStream(core, type);
      core.updateStream(streamId, [
        segment(0),
        segment(1, true),
        segment(2, false),
      ]);

      expect([...core.getStreamSegmentRuntimeIds(streamId)!]).toEqual([
        "segment-0",
        "segment-1",
        "segment-2",
      ]);
      expect(core.hasSegment("segment-1")).toBe(true);
      expect(core.isSegmentLoadable("segment-0")).toBe(true);
      expect(core.isSegmentLoadable("segment-1")).toBe(false);
      expect(core.isSegmentLoadable("segment-2")).toBe(true);
      core.destroy();
    },
  );

  it.each(["main", "secondary"] as const)(
    "rejects a direct request for an excluded %s segment before initializing storage",
    async (type) => {
      const storageFactory = vi.fn(() => {
        throw new Error("Excluded segments must not initialize storage");
      });
      const core = new Core({
        swarmId: "test",
        customSegmentStorageFactory: storageFactory,
      });
      const streamId = registerStream(core, type);
      core.updateStream(streamId, [segment(1, true)]);
      const callbacks = { onSuccess: vi.fn(), onError: vi.fn() };

      await core.loadSegment("segment-1", callbacks);

      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
        expect.any(CoreRequestError),
      );
      expect(callbacks.onSuccess).not.toHaveBeenCalled();
      expect(storageFactory).not.toHaveBeenCalled();
      core.destroy();
    },
  );

  it("snapshots the exclusion decision until the segment is removed and registered again", () => {
    const core = new Core({ swarmId: "test" });
    const streamId = registerStream(core);
    const input = { ...segment(1), isP2PDisabled: true };
    core.updateStream(streamId, [input]);
    input.isP2PDisabled = false;
    core.updateStream(streamId, [input]);
    expect(core.isSegmentLoadable(input.runtimeId)).toBe(false);

    core.updateStream(streamId, undefined, [input.runtimeId]);
    core.updateStream(streamId, [input]);
    expect(core.isSegmentLoadable(input.runtimeId)).toBe(true);
    core.destroy();
  });

  it.each([false, true])(
    "rejects an obsolete registration after storage initialization (re-register denied: %s)",
    async (reRegister) => {
      const storage = new SegmentMemoryStorage();
      let finishInitialization!: () => void;
      vi.spyOn(storage, "initialize").mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishInitialization = resolve;
          }),
      );
      const read = vi.spyOn(storage, "getSegmentData");
      const core = new Core({
        swarmId: "test",
        customSegmentStorageFactory: () => storage,
      });
      const streamId = registerStream(core);
      core.updateStream(streamId, [segment(1)]);
      const callbacks = { onSuccess: vi.fn(), onError: vi.fn() };
      const loading = core.loadSegment("segment-1", callbacks);

      core.updateStream(streamId, undefined, ["segment-1"]);
      if (reRegister) core.updateStream(streamId, [segment(1, true)]);
      finishInitialization();
      await loading;

      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
        expect.any(CoreRequestError),
      );
      expect(callbacks.onSuccess).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      core.destroy();
    },
  );
});

describe("segment prefetch queue", () => {
  function setup() {
    const core = new Core({ swarmId: "test" });
    const streamId = registerStream(core);
    const stream: StreamWithSegments = {
      ...core.getStream(streamId)!,
      segments: new Map<string, SegmentWithStream>(),
    };
    const segments = [
      segment(0),
      segment(1, true),
      segment(2, true),
      segment(3),
    ];
    for (const value of segments) {
      stream.segments.set(value.runtimeId, { ...value, stream });
    }
    const availability = vi.fn((_segment: SegmentWithStream) => true);
    const loader = {
      isSegmentLoadingOrLoadedBySomeone: availability,
    } as unknown as P2PLoader;
    const windows = {
      highDemandTimeWindow: 0,
      httpDownloadTimeWindow: 30,
      p2pDownloadTimeWindow: 60,
    };
    core.destroy();
    return { stream, loader, availability, windows };
  }

  it("omits ads from HTTP and P2P prefetch without losing content after the break", () => {
    const { stream, loader, availability, windows } = setup();
    const queue = [
      ...generateQueue(
        stream.segments.get("segment-0")!,
        { position: 0, rate: 1 },
        windows,
        loader,
        100,
      ),
    ];

    expect(queue.map(({ segment }) => segment.externalId)).toEqual([0, 3]);
    expect(queue[1].statuses).toEqual({
      isHighDemand: false,
      isHttpDownloadable: true,
      isP2PDownloadable: true,
    });
    expect(availability.mock.calls.map(([value]) => value.externalId)).toEqual([
      0, 3,
    ]);
  });

  it("does not create any prefetch work when directly given an excluded segment", () => {
    const { stream, loader, availability, windows } = setup();
    expect([
      ...generateQueue(
        stream.segments.get("segment-1")!,
        { position: 4, rate: 1 },
        windows,
        loader,
        100,
      ),
    ]).toEqual([]);
    expect(availability).not.toHaveBeenCalled();
  });
});
