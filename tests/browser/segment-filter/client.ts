import Hls from "hls.js";
import { HlsJsP2PEngine } from "p2p-media-loader-hlsjs";
import {
  BinaryCommandChunksJoiner,
  deserializeCommand,
  isCommandChunk,
} from "/wire-protocol";

const role = new URLSearchParams(location.search).get("role") || "seed";
const trackerUrl = new URLSearchParams(location.search).get("tracker")!;
const hashes = await fetch("/media/hashes.json").then((response) =>
  response.json(),
);
const state = {
  role,
  segmentDecisions: [] as any[],
  loaded: [] as any[],
  started: [] as any[],
  fragments: [] as any[],
  wire: [] as any[],
  peers: [] as any[],
  errors: [] as any[],
  uploadedBytes: 0,
  downloadedP2PBytes: 0,
  integrityChecks: [] as any[],
  ended: false,
};
(window as any).validation = state;

// Observe the real commands emitted over RTCDataChannel, without changing
// their serialization, routing, or payloads.
const originalSend = RTCDataChannel.prototype.send;
const joiners = new WeakMap<RTCDataChannel, BinaryCommandChunksJoiner>();
RTCDataChannel.prototype.send = function (data: any) {
  if (typeof data !== "string" && !(data instanceof Blob)) {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (isCommandChunk(bytes)) {
      let joiner = joiners.get(this);
      if (!joiner) {
        joiner = new BinaryCommandChunksJoiner((commandBuffer) => {
          state.wire.push(deserializeCommand(commandBuffer));
          joiners.delete(this);
        });
        joiners.set(this, joiner);
      }
      joiner.addCommandChunk(bytes);
    }
  }
  return originalSend.call(this, data);
};

const HlsWithP2P = HlsJsP2PEngine.injectMixin(Hls);
const hls = new HlsWithP2P({
  enableWorker: false,
  maxBufferLength: 60,
  maxMaxBufferLength: 60,
  p2p: {
    segmentFilter:
      new URLSearchParams(location.search).get("filter") === "off"
        ? undefined
        : (fragment, details) => {
            // Real CUE tags are carried on fragments by hls.js. Compute the range
            // from the complete playlist rather than depending on callback order.
            let inAdBreak = false;
            for (const candidate of details.fragments) {
              if (candidate.tagList.some(([tag]) => tag === "EXT-X-CUE-OUT"))
                inAdBreak = true;
              if (candidate.tagList.some(([tag]) => tag === "EXT-X-CUE-IN"))
                inAdBreak = false;
              if (candidate === fragment) {
                const allowed = !inAdBreak;
                state.segmentDecisions.push({
                  url: fragment.url,
                  allowed,
                  tags: fragment.tagList,
                });
                return allowed;
              }
            }
            return false;
          },
    core: {
      swarmId: "local-mixed-content-segment-filter-validation",
      announceTrackers: [trackerUrl],
      rtcConfig: { iceServers: [] },
      highDemandTimeWindow: role === "seed" ? 60 : 0,
      httpDownloadInitialTimeoutMs: role === "seed" ? 0 : 15000,
      httpDownloadTimeWindow: 60,
      p2pDownloadTimeWindow: 60,
      webRtcOffersCount: 1,
      webRtcIceGatheringTimeoutMs: 3000,
      webRtcConnectionTimeoutMs: 10000,
      p2pNotReceivingBytesTimeoutMs: 5000,
      async validateP2PSegment(url, _range, data) {
        const digest = await crypto.subtle.digest("SHA-256", data);
        const actual = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        const expected = hashes[new URL(url).pathname.split("/").pop()!];
        state.integrityChecks.push({ url, matched: actual === expected });
        return actual === expected;
      },
    },
    onHlsJsCreated(hls) {
      hls.p2pEngine.addEventListener("onSegmentLoaded", (event) =>
        state.loaded.push(event),
      );
      hls.p2pEngine.addEventListener("onSegmentStart", (event) =>
        state.started.push(event),
      );
      hls.p2pEngine.addEventListener("onPeerConnect", (event) =>
        state.peers.push(event),
      );
      hls.p2pEngine.addEventListener("onChunkUploaded", (bytes) => {
        state.uploadedBytes += bytes;
      });
      hls.p2pEngine.addEventListener("onChunkDownloaded", (bytes, source) => {
        if (source === "p2p") state.downloadedP2PBytes += bytes;
      });
      for (const name of [
        "onPeerError",
        "onPeerConnectError",
        "onTrackerError",
        "onSegmentError",
      ] as const) {
        hls.p2pEngine.addEventListener(name, (event) =>
          state.errors.push({ name, event }),
        );
      }
    },
  },
});
const video = document.querySelector("video")!;
(window as any).hls = hls;
(window as any).video = video;
hls.on(Hls.Events.FRAG_LOADED, (_, data) =>
  state.fragments.push({ url: data.frag.url, sn: data.frag.sn }),
);
hls.on(Hls.Events.ERROR, (_, data) => {
  if (data.fatal)
    state.errors.push({
      name: "hls-fatal",
      type: data.type,
      details: data.details,
    });
});
video.addEventListener("ended", () => {
  state.ended = true;
  renderStatus();
});
video.addEventListener("error", () =>
  state.errors.push({ name: "video", message: video.error?.message }),
);
hls.loadSource("/media/playlist.m3u8");
hls.attachMedia(video);
if (role === "leecher") {
  video.playbackRate = 4;
  video
    .play()
    .catch((error) =>
      state.errors.push({ name: "play", message: String(error) }),
    );
}
function renderStatus() {
  document.querySelector("#status")!.textContent = JSON.stringify(
    {
      role,
      peerConnections: state.peers.length,
      contentViaHTTP: state.loaded.filter((x) => x.downloadSource === "http")
        .length,
      contentViaP2P: state.loaded.filter((x) => x.downloadSource === "p2p")
        .length,
      adFragments: state.fragments.filter((x) => x.url.includes("/ad-")).length,
      uploadedBytes: state.uploadedBytes,
      downloadedP2PBytes: state.downloadedP2PBytes,
      playedSeconds: video.currentTime,
      ended: state.ended,
      errors: state.errors,
    },
    null,
    2,
  );
}
setInterval(renderStatus, 200);
