import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ffmpeg from "ffmpeg-static";

const media = fileURLToPath(new URL("./public/media/", import.meta.url));
mkdirSync(media, { recursive: true });
const result = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24",
    "-t",
    "16",
    "-vf",
    "drawbox=x=0:y=0:w=iw:h=ih:color=red:t=fill:enable='between(t,4,6)+between(t,12,14)'",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
    "-an",
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_list_size",
    "0",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    `${media}/segment-%02d.ts`,
    `${media}/playlist.m3u8`,
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) throw new Error("ffmpeg fixture generation failed");
let playlist = readFileSync(`${media}/playlist.m3u8`, "utf8");
const hashes = {};
for (let index = 0; index < 8; index++) {
  const oldName = `segment-${String(index).padStart(2, "0")}.ts`;
  const isAd = index === 2 || index === 6;
  const newName = `${isAd ? "ad" : "content"}-${String(index).padStart(2, "0")}.ts`;
  renameSync(`${media}/${oldName}`, `${media}/${newName}`);
  hashes[newName] = createHash("sha256")
    .update(readFileSync(`${media}/${newName}`))
    .digest("hex");
  playlist = playlist.replace(oldName, newName);
}
// Each ad break contains one two-second fragment. The filter reads the parsed
// CUE-OUT/CUE-IN tags and allows only fragments outside those ranges.
playlist = playlist.replace(
  /(#EXTINF:[^\n]*\nad-\d+\.ts)/g,
  "#EXT-X-CUE-OUT:2\n$1\n#EXT-X-CUE-IN",
);
writeFileSync(`${media}/playlist.m3u8`, playlist);
writeFileSync(`${media}/hashes.json`, JSON.stringify(hashes, null, 2));
console.log(
  "Generated eight real H.264 HLS fragments: six content and two ads.",
);
