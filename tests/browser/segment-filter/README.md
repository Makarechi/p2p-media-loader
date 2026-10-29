# Segment filter: real browser validation

This optional integration test runs two independent Chromium browser contexts
against the locally built library. It uses a local WebSocket signaling tracker,
real WebRTC data channels, hls.js, and a generated H.264 HLS playlist. No public
tracker, STUN service, or remote media is used during the test.

The fixture contains eight two-second fragments. Two are marked as ad breaks
using `EXT-X-CUE-OUT` / `EXT-X-CUE-IN`; their video is red. The example
`segmentFilter` derives eligibility from the parsed tags and playlist, not the
filenames. It scans the complete fixture playlist so it does not depend on the
order in which the filter is called. Production live playlists need a complete
and trustworthy classification of each fragment, including breaks that began
before the current playlist window.

## Run

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
cd tests/browser/segment-filter
npm ci
npx playwright install chromium
npm test
```

The fixture generator uses the isolated `ffmpeg-static` dependency. If the
package manager blocks its install script, run
`node node_modules/ffmpeg-static/install.js` before `npm test`. No system FFmpeg
installation is required. These dependencies are deliberately separate from
the library workspace and its normal unit-test run.

`npm test` generates the media, starts the local servers, and runs the test.
It closes browser and server processes on success or failure. Generated media,
screenshots and results are ignored by Git.

## What it verifies

1. The first browser obtains all six allowed content fragments through HTTP.
2. The second browser connects to it over a real WebRTC data channel and gets
   all six content fragments from that peer. Their SHA-256 hashes must match
   the original HTTP fixture files.
3. Both browsers obtain both advertisement fragments through HTTP. Ads never
   enter the hybrid loader.
4. Actual outgoing data-channel commands contain no ad IDs in cached/loading
   announcements, segment requests, or segment upload headers.
5. The second browser plays the complete mixed-content video through `ended`.
   There are no fatal playback, peer, tracker, or segment errors, and no external
   network requests from either page.

For determinism the seed is warmed first and the second browser has an initial
15-second HTTP delay for content. This is a test setting that forces the peer
path to be exercised; it is **not a recommended production configuration**.
Ads use hls.js's normal HTTP loader and are not subject to that artificial
delay. The test requires peer content to arrive before the delay expires.

`results/summary.json` contains the concise result. `results/details.json`
contains segment decisions, load events, captured wire commands, HTTP requests,
and signaling events. Successful runs also save screenshots of both peers.

## Development and negative control

The default test imports compiled JavaScript from the two packages' `lib/`
directories. To exercise current TypeScript sources while developing:

```sh
USE_SOURCE=1 npm test
```

The same test must fail if the filter is omitted. This negative control leaves
the playlist unchanged and exposes the default behavior, including ads being
eligible for peer exchange:

```sh
DISABLE_FILTER=1 OUTPUT_DIR=results-without-filter npm test
```

The exit status is expected to be nonzero for that command. Its detailed
capture is written separately from the successful run.

`UPSTREAM_DIR` can select a different repository checkout and
`PLAYWRIGHT_MODULE` can select an existing Playwright module. The default
requires neither override.

This checks the HLS adapter and core in Chromium on one machine. It does not
claim to test cross-network NAT traversal, Smart TV players, every SSAI tag
format, or arbitrary third-party segment storage implementations.
