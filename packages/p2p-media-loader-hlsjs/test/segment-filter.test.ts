import { describe, expect, it, vi } from "vitest";
import type {
  MediaFragment,
  FragmentLoaderContext,
  HlsConfig,
  LevelDetails,
  LevelUpdatedData,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
} from "hls.js";
import { Core } from "p2p-media-loader-core";
import { HlsJsP2PEngine, HlsJsSegmentFilter } from "../src/engine.js";
import { FragmentLoaderBase } from "../src/fragment-loader.js";
import { SegmentManager } from "../src/segment-manager.js";

const PLAYLIST_URL = "https://example.com/playlist.m3u8";

function makeFragment(index: number, overrides: Partial<MediaFragment> = {}) {
  return {
    url: `https://example.com/segment-${index}.ts`,
    byteRange: [],
    sn: 100 + index,
    start: index * 4,
    end: (index + 1) * 4,
    tagList: [],
    ...overrides,
  } as MediaFragment;
}

function setup(
  filter?: HlsJsSegmentFilter,
  type: "main" | "secondary" = "main",
) {
  const core = new Core({ swarmId: "filter-test" });
  core.addStreamIfNoneExists({
    runtimeId: PLAYLIST_URL,
    type,
    properties: {},
  });
  const manager = new SegmentManager(core, filter);
  const details = {
    url: PLAYLIST_URL,
    live: false,
    fragments: [makeFragment(0), makeFragment(1), makeFragment(2)],
  } as LevelDetails;
  const update = () => manager.updatePlaylist({ details } as LevelUpdatedData);
  return { core, details, update };
}

describe("hls.js segment filter", () => {
  it("keeps all segments loadable when no filter is configured", () => {
    const { core, details, update } = setup();
    update();
    for (const fragment of details.fragments) {
      expect(core.isSegmentLoadable(fragment.url)).toBe(true);
    }
  });

  it.each(["main", "secondary"] as const)(
    "filters %s segments before registration without renumbering VOD segments",
    (type) => {
      const filter = vi.fn<HlsJsSegmentFilter>(
        (fragment) => fragment.sn !== 101,
      );
      const { core, details, update } = setup(filter, type);
      const register = vi.spyOn(core, "updateStream");
      update();

      expect(filter).toHaveBeenCalledTimes(3);
      expect(filter).toHaveBeenCalledWith(details.fragments[1], details);
      expect(core.isSegmentLoadable(details.fragments[0].url)).toBe(true);
      expect(core.isSegmentLoadable(details.fragments[1].url)).toBe(false);
      expect(core.isSegmentLoadable(details.fragments[2].url)).toBe(true);
      // Keep excluded descriptors so manifest order and live-window accounting
      // remain intact, while the player loader can recognize the HTTP-only path.
      expect(core.getStreamSegmentRuntimeIds(PLAYLIST_URL)?.size).toBe(3);
      expect(register.mock.calls[0][1]).toEqual([
        expect.objectContaining({ externalId: 0, isP2PDisabled: false }),
        expect.objectContaining({ externalId: 1, isP2PDisabled: true }),
        expect.objectContaining({ externalId: 2, isP2PDisabled: false }),
      ]);
    },
  );

  it("exposes playlist metadata to classify every segment in an ad break", () => {
    const { core, details, update } = setup((fragment, playlist) => {
      let isAd = false;
      for (const candidate of playlist.fragments) {
        if (candidate.tagList.some(([tag]) => tag === "EXT-X-CUE-OUT"))
          isAd = true;
        if (candidate.tagList.some(([tag]) => tag === "EXT-X-CUE-IN"))
          isAd = false;
        if (candidate === fragment) return !isAd;
      }
      return false;
    });
    details.fragments[0].tagList = [["EXT-X-CUE-OUT", "8"]];
    details.fragments[2].tagList = [["EXT-X-CUE-IN"]];
    update();
    expect(core.isSegmentLoadable(details.fragments[0].url)).toBe(false);
    expect(core.isSegmentLoadable(details.fragments[1].url)).toBe(false);
    expect(core.isSegmentLoadable(details.fragments[2].url)).toBe(true);
  });

  it("preserves live sequence numbers and fixes decisions until registration ends", () => {
    let allowed = false;
    const filter = vi.fn(() => allowed);
    const { core, details, update } = setup(filter);
    details.live = true;
    const register = vi.spyOn(core, "updateStream");
    update();
    expect(register.mock.calls[0][1]).toEqual([
      expect.objectContaining({ externalId: 100 }),
      expect.objectContaining({ externalId: 101 }),
      expect.objectContaining({ externalId: 102 }),
    ]);

    allowed = true;
    update();
    expect(filter).toHaveBeenCalledTimes(3);
    expect(core.isSegmentLoadable(details.fragments[0].url)).toBe(false);

    const removed = details.fragments.shift()!;
    details.fragments.push(makeFragment(3));
    update();
    expect(core.hasSegment(removed.url)).toBe(false);
    expect(core.isSegmentLoadable(details.fragments[2].url)).toBe(true);

    details.fragments.unshift(removed);
    update();
    expect(core.isSegmentLoadable(removed.url)).toBe(true);
  });

  it("can distinguish byte ranges that share a URL", () => {
    const { core, details, update } = setup(
      (fragment) => fragment.byteRange[0] !== 100,
    );
    details.fragments = [
      makeFragment(0, {
        url: "https://example.com/media.mp4",
        byteRange: [0, 100],
      }),
      makeFragment(1, {
        url: "https://example.com/media.mp4",
        byteRange: [100, 200],
      }),
    ];
    update();
    expect(core.isSegmentLoadable("https://example.com/media.mp4|0-99")).toBe(
      true,
    );
    expect(
      core.isSegmentLoadable("https://example.com/media.mp4|100-199"),
    ).toBe(false);
  });

  it("keeps exceptions and invalid or asynchronous results out of P2P", async () => {
    const filter = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("classification failed");
      })
      .mockReturnValueOnce("true")
      .mockReturnValueOnce(Promise.reject(new Error("async filter")))
      .mockReturnValueOnce(true);
    const { core, details, update } = setup(filter);
    details.fragments.push(makeFragment(3));
    expect(update).not.toThrow();
    await Promise.resolve();
    expect(
      details.fragments.map((fragment) => core.isSegmentLoadable(fragment.url)),
    ).toEqual([false, false, false, true]);
  });

  it("exposes the constructor filter through getConfig", () => {
    const filter = () => false;
    const engine = new HlsJsP2PEngine({ segmentFilter: filter });
    expect(engine.getConfig().segmentFilter).toBe(filter);
  });

  it("loads excluded segments with the original player loader", () => {
    const { core, details, update } = setup(() => false);
    update();
    const load = vi.fn();
    const loadThroughCore = vi.spyOn(core, "loadSegment");
    class DefaultLoader {
      load = load;
    }
    const loader = new FragmentLoaderBase(
      { loader: DefaultLoader } as unknown as HlsConfig,
      core,
    );
    const context = { url: details.fragments[0].url } as FragmentLoaderContext;
    const config = {} as LoaderConfiguration;
    const callbacks = {} as LoaderCallbacks<LoaderContext>;

    loader.load(context, config, callbacks);

    expect(load).toHaveBeenCalledWith(context, config, callbacks);
    expect(loadThroughCore).not.toHaveBeenCalled();
  });
});
