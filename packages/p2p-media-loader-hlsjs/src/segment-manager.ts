import * as Utils from "./utils.js";
import type {
  ManifestLoadedData,
  LevelUpdatedData,
  AudioTrackLoadedData,
  Fragment,
  LevelDetails,
} from "hls.js";
import {
  Core,
  Segment,
  StreamRegistration,
  debug,
} from "p2p-media-loader-core";
import type { HlsJsSegmentFilter } from "./engine.js";
import {
  getAudioStreamProperties,
  getVideoStreamProperties,
} from "./stream-properties.js";

export class SegmentManager {
  core: Core;
  private readonly logger = debug("p2pml-hlsjs:segment-manager");

  constructor(
    core: Core,
    private readonly segmentFilter?: HlsJsSegmentFilter,
  ) {
    this.core = core;
  }

  processMainManifest(data: ManifestLoadedData) {
    const { levels, audioTracks } = data;
    // in the case of audio only stream it is stored in levels

    for (const level of levels) {
      const { url } = level;
      this.addStream({
        runtimeId: Array.isArray(url) ? (url as string[])[0] : url,
        type: "main",
        properties: getVideoStreamProperties(level),
      });
    }

    for (const track of audioTracks) {
      const { url } = track;
      this.addStream({
        runtimeId: Array.isArray(url) ? (url as string[])[0] : url,
        type: "secondary",
        properties: getAudioStreamProperties(track),
      });
    }
  }

  private addStream(stream: StreamRegistration) {
    // Registration never throws: the core reports failures via its
    // onStreamRegistrationError event, and a failed stream's segments load
    // through the default hls.js loader without P2P.
    this.core.addStreamIfNoneExists(stream);
  }

  updatePlaylist(data: LevelUpdatedData | AudioTrackLoadedData) {
    const { details } = data;
    const { url, fragments, live } = details;

    const registeredSegmentIds = this.core.getStreamSegmentRuntimeIds(url);
    if (!registeredSegmentIds) return;

    const segmentToRemoveIds = new Set(registeredSegmentIds);
    const newSegments: Segment[] = [];
    fragments.forEach((fragment, index) => {
      const {
        url: responseUrl,
        byteRange: fragByteRange,
        sn,
        start: startTime,
        end: endTime,
      } = fragment;

      const [start, end] = fragByteRange;
      const byteRange = Utils.getByteRange(
        start,
        end !== undefined ? end - 1 : undefined,
      );
      const runtimeId = Utils.getSegmentRuntimeId(responseUrl, byteRange);
      segmentToRemoveIds.delete(runtimeId);

      if (registeredSegmentIds.has(runtimeId)) return;
      newSegments.push({
        runtimeId,
        url: responseUrl,
        externalId: live ? sn : index,
        byteRange,
        startTime,
        endTime,
        isP2PDisabled: !this.isSegmentP2PAllowed(fragment, details),
      });
    });

    if (!newSegments.length && !segmentToRemoveIds.size) return;
    this.core.updateStream(url, newSegments, segmentToRemoveIds.values());
  }

  private isSegmentP2PAllowed(fragment: Fragment, details: LevelDetails) {
    if (!this.segmentFilter) return true;
    try {
      const result: unknown = this.segmentFilter(fragment, details);
      if (typeof result !== "boolean") {
        this.logger("segmentFilter must return a boolean");
        // A mistakenly async filter must neither enable P2P nor leave a rejected
        // promise unhandled. Its eventual result does not change the decision.
        void Promise.resolve(result).catch((error: unknown) => {
          this.logger("segmentFilter failed: %O", error);
        });
        return false;
      }
      return result;
    } catch (error) {
      this.logger("segmentFilter failed: %O", error);
      return false;
    }
  }
}
