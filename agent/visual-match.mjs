const MAX_REGION = 640;
const MAX_TEMPLATE = 192;
const MAX_IMAGE_BYTES = 512 * 1024;

function pngBytes(base64) {
  if (typeof base64 !== "string" || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new Error("Provide a base64 PNG up to 512 KiB");
  }
  const png = Buffer.from(base64, "base64");
  if (png.length < 33 || png.length > MAX_IMAGE_BYTES || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    || png.subarray(12, 16).toString("ascii") !== "IHDR") throw new Error("Invalid PNG template");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (width < 4 || height < 4 || width > MAX_TEMPLATE || height > MAX_TEMPLATE) {
    throw new Error("The template must be between 4 and 192 pixels on each side");
  }
  return png;
}

function checkedRegion(region, viewport, max, min) {
  const { x, y, width, height } = region ?? {};
  if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < min || height < min
    || width > max || height > max || x + width > viewport.width || y + height > viewport.height) {
    throw new Error("Choose a " + min + " to " + max + " pixel region inside the visible viewport");
  }
  return { x, y, width, height };
}

/** A bounded RGB match. Transparency masks pixels in the supplied reference. */
export function matchPixels(image, template, tolerance) {
  const { width, height, data } = template;
  const pixels = [];
  for (let at = 0; at < width * height; at++) {
    if (data[at * 4 + 3] >= 128) pixels.push(at);
  }
  if (pixels.length < 12) throw new Error("The template needs at least 12 opaque pixels");
  const samples = count => {
    const length = Math.min(count, pixels.length);
    return Array.from({ length }, (_, index) => {
      const pixel = pixels[Math.floor(index * pixels.length / length)];
      const at = pixel * 4;
      return { x: pixel % width, y: Math.floor(pixel / width), r: data[at], g: data[at + 1], b: data[at + 2] };
    });
  };
  const sketch = samples(16), detail = samples(160);
  if (new Set(detail.map(pixel => pixel.r * 65536 + pixel.g * 256 + pixel.b)).size < 4) {
    throw new Error("Choose a template with more visible detail");
  }
  const candidates = [];
  let checked = 0;
  const score = (offset, points, limit) => {
    let error = 0;
    const budget = limit * points.length * 765;
    for (const pixel of points) {
      const at = offset + (image.width * pixel.y + pixel.x) * 4;
      error += Math.abs(image.data[at] - pixel.r) + Math.abs(image.data[at + 1] - pixel.g) + Math.abs(image.data[at + 2] - pixel.b);
      if (error > budget) return Infinity;
    }
    return error / (points.length * 765);
  };
  for (let y = 0; y <= image.height - height; y++) {
    for (let x = 0; x <= image.width - width; x++) {
      const at = (image.width * y + x) * 4;
      if (score(at, sketch, tolerance + 0.03) === Infinity) continue;
      if (++checked > 4096) return { status: "ambiguous", candidates, truncated: true };
      const error = score(at, detail, tolerance);
      if (error === Infinity) continue;
      const overlapping = candidates.findIndex(other => Math.abs(other.x - x) < width / 2 && Math.abs(other.y - y) < height / 2);
      const candidate = { x, y, width, height, similarity: 1 - error };
      if (overlapping >= 0) {
        if (candidates[overlapping].similarity < candidate.similarity) candidates[overlapping] = candidate;
      } else candidates.push(candidate);
      if (candidates.length > 16) return { status: "ambiguous", candidates: candidates.slice(0, 16), truncated: true };
    }
  }
  candidates.sort((a, b) => b.similarity - a.similarity);
  return { status: candidates.length === 1 ? "unique" : candidates.length > 1 ? "ambiguous" : "missing", candidates };
}

export async function matchVisibleRegion(page, { region, reference, templatePng, tolerance = 0.04, timeout }) {
  if ((reference === undefined) === (templatePng === undefined)) throw new Error("Choose a visible reference region or a template PNG");
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.15) throw new Error("Tolerance must be between 0 and 0.15");
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const clip = checkedRegion(region, viewport, MAX_REGION, 4);
  const referenceClip = reference === undefined ? undefined : checkedRegion(reference, viewport, MAX_TEMPLATE, 4);
  const take = clip => page.screenshot({ type: "png", scale: "css", clip, timeout });
  const [target, template] = await Promise.all([take(clip), referenceClip ? take(referenceClip) : pngBytes(templatePng)]);
  const { PNG } = await import("playwright-core/lib/utilsBundle");
  const found = matchPixels(PNG.sync.read(target), PNG.sync.read(template), tolerance);
  return { ...found, region: clip, candidates: found.candidates.map(candidate => ({
    ...candidate, x: candidate.x + clip.x, y: candidate.y + clip.y,
    center: { x: clip.x + candidate.x + candidate.width / 2, y: clip.y + candidate.y + candidate.height / 2 },
  })) };
}
