import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALIASMODE_CHROMIUM_VERSION, aliasmodeChromiumArchive, cloakBrowserExecutableSha256,
  ensurePinnedRuntime, supportsChromium155Host,
} from "./aliasmode-chromium.ts";
import { CLOAKBROWSER_MACOS_VERSION, CLOAKBROWSER_VERSION, sha256File } from "./browser-install.ts";

// Verified Chrome for Testing binaries. Match the managed browser's major/minor/build.
const assets: Record<string, readonly [size: number, archive: string, executable: string]> = {
  "155.0.8059.84/win64": [11602185, "0e629a3ef7f2be8562b857253053ebb0f871f55240f80124cd31974380ad1f3a", "2d9a190089ec8546e955479b4ba6866eaea5d63e1afb050b5b97662f4dbad41b"],
  "155.0.8059.84/linux64": [11896800, "4fe2433044363e5233d642e70fa50278b471bda08032d922402c8bd7c6d743fd", "404dd1be5119d3c00b01251d0532fc3d8df1762b6e6835e2bf387b613577494e"],
  "155.0.8059.84/mac-arm64": [9379049, "6db09f1272851bdcd5137d04797b5506993291e8499e8fa8153ab1c571bba20c", "a4b7c249af91e8e31e44e36bbd0afd76b02e0d85ce53b2ad31900fea57c8ce13"],
  "146.0.7680.165/win64": [10254309, "76b20caf99bcc2d459856d287919105999c747e7b120b60f12941bfc6bc49323", "661ca75757d2bc881453df2ecd821effa829a907fe230295b9f3b922259988f3"],
  "146.0.7680.165/linux64": [9872214, "5187f6b7ba22348feabb03d6976f5d6c1bd40b3c6692b515896b4f7334fbd912", "51df048171813deb307f7bd26baf49db030032f9332cedce8ce2797e03b86be1"],
  "145.0.7632.117/mac-x64": [9408029, "fea60867b12a3cc4206ba4c9dea49d9ab6ef271653a450675526cc9afc09f0d4", "a35db0c3ee6e0d47da48ac135d072a270cea4c08b2a8436466abc14fd7aeedcf"],
  "145.0.7632.117/mac-arm64": [8457072, "25d09ebbca90628b480e95e0d1541818f8e7646d0b77fa81c6258fc13c0613d0", "9a9c1a8c0fbc8f1db2c884dfd55d1c504aa845807ba05fdd90393627c164f52e"],
};
const platforms: Record<string, string> = {
  "win32:x64": "win64", "linux:x64": "linux64", "darwin:arm64": "mac-arm64", "darwin:x64": "mac-x64",
};
const versionsByBuild: Record<string, string> = {
  "155.0.8059": "155.0.8059.84", "146.0.7680": "146.0.7680.165", "145.0.7632": "145.0.7632.117",
};
const checked = new Map<string, string>();
const failedAt = new Map<string, number>();

function identity(path: string): string | undefined {
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (file?.isFile()) return [file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs].join(":");
}

export async function managedChromeDriver(
  browserSha256: string, root: string, platform: NodeJS.Platform, arch: string, download: boolean,
): Promise<string | undefined> {
  const host = platforms[platform + ":" + arch];
  if (!host || !browserSha256) return undefined;
  const browserVersion = supportsChromium155Host(platform, arch) && browserSha256 === aliasmodeChromiumArchive(platform).executableSha256
    ? ALIASMODE_CHROMIUM_VERSION
    : browserSha256 === cloakBrowserExecutableSha256(platform, arch)
      ? (platform === "darwin" ? CLOAKBROWSER_MACOS_VERSION : CLOAKBROWSER_VERSION) : undefined;
  const version = browserVersion && versionsByBuild[browserVersion.split(".").slice(0, 3).join(".")];
  if (!version) return undefined;
  const asset = assets[version + "/" + host];
  if (!asset) return undefined;
  const [size, archiveSha256, executableSha256] = asset;
  const archiveRoot = "chromedriver-" + host;
  const dir = "chromedriver-" + version + "-" + host;
  const executable = platform === "win32" ? "chromedriver.exe" : "chromedriver";
  const cacheRoot = resolve(root);
  const path = resolve(cacheRoot, dir, executable);
  try {
    const before = identity(path);
    if (before && (checked.get(path) === before || await sha256File(path) === executableSha256 && identity(path) === before)) {
      checked.set(path, before);
      return path;
    }
    if (!download || (failedAt.get(path) ?? 0) + 10000 > Date.now()) return undefined;
    const installed = await ensurePinnedRuntime({
      label: "ChromeDriver", dir, size, archiveRoot, executable, archiveSha256, executableSha256,
      url: "https://storage.googleapis.com/chrome-for-testing-public/" + version + "/" + host + "/" + archiveRoot + ".zip",
    }, cacheRoot, {}, platform);
    const stamp = identity(installed);
    if (stamp) {
      checked.set(path, stamp);
      failedAt.delete(path);
      return installed;
    }
  } catch {
    // A start still has a working CDP endpoint while the optional driver is unavailable.
    if (download) failedAt.set(path, Date.now());
  }
}
