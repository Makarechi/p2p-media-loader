import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const root = dirname(fileURLToPath(import.meta.url));
const upstream = process.env.UPSTREAM_DIR || resolve(root, "../../..");
const libraryDir = process.env.USE_SOURCE === "1" ? "src" : "lib";
const libraryExtension = process.env.USE_SOURCE === "1" ? "ts" : "js";
const requireUpstream = createRequire(`${upstream}/package.json`);
const { createServer } = await import(
  pathToFileURL(requireUpstream.resolve("vite"))
);
const requireLocal = createRequire(import.meta.url);
const playwrightPath =
  process.env.PLAYWRIGHT_MODULE || requireLocal.resolve("playwright");
const playwright = await import(pathToFileURL(playwrightPath));
const { chromium } = playwright.default ?? playwright;
const output = resolve(root, process.env.OUTPUT_DIR || "results");
mkdirSync(output, { recursive: true });

const httpRequests = [];
const trackerEvents = [];
const browserErrors = [];
const sockets = new Map();
const tracker = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((resolve) => tracker.once("listening", resolve));
const trackerUrl = `ws://127.0.0.1:${tracker.address().port}`;
const send = (socket, message) => {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
};
tracker.on("connection", (socket) => {
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    const {
      info_hash,
      peer_id,
      offers = [],
      answer,
      offer_id,
      to_peer_id,
    } = message;
    if (message.action !== "announce") return;
    if (message.event === "stopped") {
      sockets.delete(`${info_hash}:${peer_id}`);
      return;
    }
    sockets.set(`${info_hash}:${peer_id}`, { socket, info_hash, peer_id });
    if (answer) {
      const receiver = sockets.get(`${info_hash}:${to_peer_id}`);
      if (receiver)
        send(receiver.socket, {
          action: "announce",
          info_hash,
          peer_id,
          answer,
          offer_id,
        });
      trackerEvents.push({ kind: "answer", info_hash, peer_id, to_peer_id });
      return;
    }
    const others = [...sockets.values()].filter(
      (p) => p.info_hash === info_hash && p.peer_id !== peer_id,
    );
    send(socket, {
      action: "announce",
      info_hash,
      interval: 3,
      complete: 0,
      incomplete: others.length + 1,
    });
    for (
      let index = 0;
      index < Math.min(offers.length, others.length);
      index++
    ) {
      send(others[index].socket, {
        action: "announce",
        info_hash,
        peer_id,
        ...offers[index],
      });
      trackerEvents.push({
        kind: "offer",
        info_hash,
        peer_id,
        to_peer_id: others[index].peer_id,
      });
    }
  });
  socket.on("close", () => {
    for (const [key, peer] of sockets)
      if (peer.socket === socket) sockets.delete(key);
  });
});

const server = await createServer({
  root,
  configFile: false,
  resolve: {
    alias: [
      {
        find: "p2p-media-loader-hlsjs",
        replacement: `${upstream}/packages/p2p-media-loader-hlsjs/${libraryDir}/index.${libraryExtension}`,
      },
      {
        find: "p2p-media-loader-core",
        replacement: `${upstream}/packages/p2p-media-loader-core/${libraryDir}/index.${libraryExtension}`,
      },
      {
        find: "hls.js",
        replacement: `${upstream}/packages/p2p-media-loader-hlsjs/node_modules/hls.js/dist/hls.mjs`,
      },
      {
        find: "/wire-protocol",
        replacement: `${upstream}/packages/p2p-media-loader-core/${libraryDir}/p2p/commands/index.${libraryExtension}`,
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 0,
    hmr: false,
    watch: null,
    fs: { allow: [root, upstream] },
  },
  plugins: [
    {
      name: "capture-media-requests",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith("/media/"))
            httpRequests.push({
              peer: req.headers["x-validation-peer"],
              url: req.url,
              range: req.headers.range,
            });
          next();
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
const pages = {};
let failure;
let summary;
try {
  browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const newPeer = async (role) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 900 },
      extraHTTPHeaders: { "x-validation-peer": role },
    });
    const page = await context.newPage();
    pages[role] = page;
    page.on("pageerror", (error) =>
      browserErrors.push({ role, message: error.message }),
    );
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!["127.0.0.1", "localhost"].includes(url.hostname))
        browserErrors.push({ role, externalRequest: request.url() });
    });
    await page.goto(
      `${origin}/?role=${role}&tracker=${encodeURIComponent(trackerUrl)}&filter=${process.env.DISABLE_FILTER === "1" ? "off" : "on"}`,
    );
    return page;
  };
  console.log(
    "Loading the seed peer and warming six allowed segments from HTTP…",
  );
  const seed = await newPeer("seed");
  await seed.waitForFunction(
    () =>
      window.validation?.loaded.filter((x) => x.downloadSource === "http")
        .length >= 6,
    null,
    { timeout: 20000 },
  );
  await seed.waitForFunction(
    () => window.validation?.fragments.length === 8,
    null,
    { timeout: 10000 },
  );
  console.log(
    "Connecting the second peer through the local WebSocket tracker…",
  );
  const leecher = await newPeer("leecher");
  await leecher.waitForFunction(
    () =>
      window.validation?.loaded.filter((x) => x.downloadSource === "p2p")
        .length >= 6,
    null,
    { timeout: 14000 },
  );
  await leecher.waitForFunction(() => window.validation?.ended, null, {
    timeout: 20000,
  });
  const seedState = await seed.evaluate(() => window.validation);
  const leecherState = await leecher.evaluate(() => window.validation);
  const adIds = [2, 6];
  const contentIds = [0, 1, 3, 4, 5, 7];
  assert.deepEqual(
    browserErrors,
    [],
    "browser page errors or unexpected external requests",
  );
  for (const state of [seedState, leecherState]) {
    assert.deepEqual(
      state.errors,
      [],
      `${state.role}: library/playback errors`,
    );
    assert.equal(
      state.segmentDecisions.filter((x) => !x.allowed).length,
      2,
      `${state.role}: marker filtering excludes both ads`,
    );
    assert.equal(
      state.fragments.length,
      8,
      `${state.role}: hls.js obtained all fragments`,
    );
    assert.equal(
      state.loaded.some((x) => x.segment.url.includes("/ad-")),
      false,
      `${state.role}: no ads entered the hybrid loader`,
    );
    const adRequests = httpRequests.filter(
      (x) => x.peer === state.role && /\/ad-\d+\.ts$/.test(x.url),
    );
    assert.equal(
      adRequests.length,
      2,
      `${state.role}: both ad fragments loaded over HTTP`,
    );
    for (const command of state.wire) {
      if (command.c === 0) {
        assert.equal(
          [...(command.l || []), ...(command.p || [])].some((id) =>
            adIds.includes(id),
          ),
          false,
          `${state.role}: ads must never be announced`,
        );
      }
      if (command.c === 1 || command.c === 2) {
        assert.equal(
          adIds.includes(command.i),
          false,
          `${state.role}: ads must never be requested/uploaded over RTCDataChannel`,
        );
      }
    }
  }
  assert.deepEqual(
    leecherState.loaded.map((x) => x.segment.externalId).sort((a, b) => a - b),
    contentIds,
  );
  assert.equal(
    leecherState.loaded.every((x) => x.downloadSource === "p2p"),
    true,
    "all six content fragments downloaded from the real peer",
  );
  assert.equal(
    leecherState.integrityChecks.length,
    6,
    "all peer-downloaded fragments checked against original CDN fixture hashes",
  );
  assert.equal(
    leecherState.integrityChecks.every((x) => x.matched),
    true,
    "peer bytes equal original CDN fixture bytes",
  );
  assert.equal(
    httpRequests.some(
      (x) => x.peer === "leecher" && /\/content-\d+\.ts$/.test(x.url),
    ),
    false,
    "leecher must not fetch content from HTTP in this test",
  );
  assert.equal(
    seedState.uploadedBytes,
    leecherState.downloadedP2PBytes,
    "all uploaded bytes accounted for on the receiver",
  );
  assert(seedState.uploadedBytes > 0, "real WebRTC data was uploaded");
  summary = {
    passed: true,
    browser: browser.version(),
    libraryFiles:
      libraryDir === "lib" ? "compiled JavaScript" : "TypeScript source",
    independentBrowserContexts: 2,
    actualVideoPlaybackCompleted: leecherState.ended,
    playlistFragments: 8,
    contentFragmentsViaP2P: leecherState.loaded.length,
    adFragmentsViaHTTPPerPeer: 2,
    p2pBytes: leecherState.downloadedP2PBytes,
    sha256Matches: leecherState.integrityChecks.length,
    adAnnouncements: 0,
    adPeerRequests: 0,
    adUploads: 0,
    externalNetworkRequests: 0,
  };
  await leecher.screenshot({
    path: resolve(output, "leecher-playback.png"),
    fullPage: true,
  });
  await seed.screenshot({
    path: resolve(output, "seed-upload.png"),
    fullPage: true,
  });
  writeFileSync(
    resolve(output, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  const states = {};
  for (const [role, page] of Object.entries(pages)) {
    states[role] = await page
      .evaluate(() => ({
        state: window.validation,
        video: {
          currentTime: document.querySelector("video").currentTime,
          readyState: document.querySelector("video").readyState,
          error: document.querySelector("video").error?.message,
        },
      }))
      .catch(() => undefined);
    if (failure)
      await page
        .screenshot({
          path: resolve(output, `${role}-failure.png`),
          fullPage: true,
        })
        .catch(() => {});
  }
  writeFileSync(
    resolve(output, "details.json"),
    JSON.stringify(
      {
        summary,
        failure: failure?.message,
        states,
        httpRequests,
        trackerEvents,
        browserErrors,
      },
      null,
      2,
    ),
  );
  await browser?.close();
  await server.close();
  for (const client of tracker.clients) client.terminate();
  await new Promise((resolve) => tracker.close(resolve));
}
if (failure) process.exitCode = 1;
