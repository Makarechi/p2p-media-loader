import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Core } from "../src/core.js";
import {
  SegmentWithStream,
  StreamWithSegments,
} from "../src/internal-types.js";
import { P2PLoader, EventTargetMap } from "../src/p2p/loader.js";
import { Peer } from "../src/p2p/peer.js";
import { RequestsContainer } from "../src/requests/request-container.js";
import { SegmentStorage } from "../src/segment-storage/index.js";
import { EventTarget } from "../src/utils/event-target.js";
import { WebTorrentSocketPool } from "../src/webtorrent/webtorrent-socket-pool/index.js";

type PeerDouble = {
  id: string;
  handlers: ConstructorParameters<typeof Peer>[3];
  sendSegmentsAnnouncementCommand: ReturnType<typeof vi.fn>;
  sendSegmentAbsentCommand: ReturnType<typeof vi.fn>;
  uploadSegmentData: ReturnType<typeof vi.fn>;
  downloadSegment: ReturnType<typeof vi.fn>;
  getSegmentStatus: ReturnType<typeof vi.fn>;
};

const doubles = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown) => void>(),
  peer: undefined as PeerDouble | undefined,
}));

vi.mock("../src/webtorrent/webtorrent-manager/index.js", () => ({
  WebTorrentManager: class {
    addEventListener(name: string, listener: (event: unknown) => void) {
      doubles.listeners.set(name, listener);
    }
    start() {}
    destroy() {}
  },
}));

vi.mock("../src/p2p/peer.js", () => ({
  Peer: class {
    sendSegmentsAnnouncementCommand = vi.fn();
    sendSegmentAbsentCommand = vi.fn();
    uploadSegmentData = vi.fn();
    downloadSegment = vi.fn();
    getSegmentStatus = vi.fn(() => "loaded");
    destroy = vi.fn();

    constructor(
      public id: string,
      _channel: RTCDataChannel,
      _close: () => void,
      public handlers: ConstructorParameters<typeof Peer>[3],
    ) {
      doubles.peer = this;
    }
  },
}));

const activeLoaders: P2PLoader[] = [];

beforeEach(() => {
  doubles.listeners.clear();
  doubles.peer = undefined;
});

afterEach(() => {
  for (const loader of activeLoaders.splice(0)) loader.destroy();
});

function setup() {
  const core = new Core({ swarmId: "test", announceTrackers: [] });
  core.addStreamIfNoneExists({
    runtimeId: "stream",
    type: "main",
    properties: { bitrate: 1000 },
  });
  const stream: StreamWithSegments = {
    ...core.getStream("stream")!,
    segments: new Map<string, SegmentWithStream>(),
  };
  function addSegment(id: number, isP2PDisabled = false) {
    const segment: SegmentWithStream = {
      runtimeId: `segment-${id}`,
      externalId: id,
      url: `https://example.com/segment-${id}.ts`,
      startTime: id * 4,
      endTime: (id + 1) * 4,
      isP2PDisabled,
      stream,
    };
    stream.segments.set(segment.runtimeId, segment);
    return segment;
  }
  const content = addSegment(0);
  const ad = addSegment(1, true);
  const unknown = { ...content, runtimeId: "unknown", externalId: 99 };
  const bytes = new Uint8Array([10, 20, 30]).buffer;
  const stored = new Map<number, ArrayBuffer>([
    [content.externalId, bytes],
    [ad.externalId, bytes],
    [unknown.externalId, bytes],
  ]);
  const storage = {
    initialize: vi.fn(async () => {}),
    onPlaybackUpdated: vi.fn(),
    onSegmentRequested: vi.fn(),
    storeSegment: vi.fn(async () => {}),
    getSegmentData: vi.fn(async (_swarm: string, _stream: string, id: number) =>
      stored.get(id),
    ),
    getUsage: () => ({ totalCapacity: 1000, usedCapacity: 10 }),
    hasSegment: (_swarm: string, _stream: string, id: number) => stored.has(id),
    getStoredSegmentIds: () => [...stored.keys()],
    setSegmentChangeCallback: vi.fn(),
    destroy: vi.fn(),
  } satisfies SegmentStorage;
  const requests = {
    httpRequests: () => [content, ad, unknown].map((segment) => ({ segment })),
    getOrCreateRequest: vi.fn((segment: SegmentWithStream) => ({ segment })),
  };
  const loader = new P2PLoader(
    stream,
    requests as unknown as RequestsContainer,
    storage,
    core.getConfig().mainStream,
    {} as WebTorrentSocketPool,
    new EventTarget<EventTargetMap>(),
    "local-peer",
    vi.fn(),
  );
  activeLoaders.push(loader);
  doubles.listeners.get("peerConnected")!({
    peerId: "remote-peer",
    channel: {} as RTCDataChannel,
    trackerUrl: "wss://tracker.example.com",
    close: vi.fn(),
  });
  const peer = doubles.peer!;
  core.destroy();
  return {
    loader,
    peer,
    stream,
    content,
    ad,
    unknown,
    storage,
    requests,
    bytes,
    addSegment,
  };
}

function requestSegment(peer: PeerDouble, id: number, requestId = 42) {
  peer.handlers.onSegmentRequested(peer as unknown as Peer, id, requestId);
}

describe("P2P segment exclusion", () => {
  it("announces only registered, allowed cached and HTTP-loading segments", async () => {
    const { loader, peer } = setup();
    expect(
      peer.sendSegmentsAnnouncementCommand,
    ).toHaveBeenCalledExactlyOnceWith([0], [0]);
    peer.sendSegmentsAnnouncementCommand.mockClear();

    loader.broadcastAnnouncement();
    await Promise.resolve();

    expect(
      peer.sendSegmentsAnnouncementCommand,
    ).toHaveBeenCalledExactlyOnceWith([0], [0]);
  });

  it("ignores attempts to download excluded segments even when a peer has them", () => {
    const { loader, peer, ad, requests } = setup();

    loader.downloadSegment(ad);
    expect(loader.isSegmentLoadedBySomeone(ad)).toBe(false);
    expect(loader.isSegmentLoadingOrLoadedBySomeone(ad)).toBe(false);

    expect(peer.getSegmentStatus).not.toHaveBeenCalled();
    expect(requests.getOrCreateRequest).not.toHaveBeenCalled();
    expect(peer.downloadSegment).not.toHaveBeenCalled();
  });

  it.each([1, 99])(
    "refuses a request for excluded or unregistered cached segment %s",
    async (id) => {
      const { peer, storage } = setup();

      requestSegment(peer, id);
      await Promise.resolve();

      expect(peer.sendSegmentAbsentCommand).toHaveBeenCalledExactlyOnceWith(
        id,
        42,
      );
      expect(storage.getSegmentData).not.toHaveBeenCalled();
      expect(peer.uploadSegmentData).not.toHaveBeenCalled();
    },
  );

  it("still downloads and uploads allowed content cached from HTTP", async () => {
    const { loader, peer, content, requests, bytes } = setup();

    loader.downloadSegment(content);
    expect(requests.getOrCreateRequest).toHaveBeenCalledExactlyOnceWith(
      content,
    );
    expect(peer.downloadSegment).toHaveBeenCalledExactlyOnceWith({
      segment: content,
    });
    requestSegment(peer, content.externalId);
    await Promise.resolve();

    expect(peer.uploadSegmentData).toHaveBeenCalledExactlyOnceWith(
      content,
      42,
      bytes,
    );
    expect(peer.sendSegmentAbsentCommand).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not upload stale storage data after removal (re-register denied: %s)",
    async (reRegister) => {
      const { peer, content, stream, storage, bytes, addSegment } = setup();
      let resolveRead!: (value: ArrayBuffer) => void;
      storage.getSegmentData.mockImplementationOnce(
        () =>
          new Promise<ArrayBuffer>((resolve) => {
            resolveRead = resolve;
          }),
      );
      requestSegment(peer, content.externalId);
      expect(storage.getSegmentData).toHaveBeenCalledTimes(1);

      stream.segments.delete(content.runtimeId);
      if (reRegister) addSegment(content.externalId, true);
      resolveRead(bytes);
      await Promise.resolve();

      expect(peer.sendSegmentAbsentCommand).toHaveBeenCalledExactlyOnceWith(
        content.externalId,
        42,
      );
      expect(peer.uploadSegmentData).not.toHaveBeenCalled();
    },
  );
});
