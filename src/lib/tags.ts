import { parseBlob, selectCover } from "music-metadata";

export type Tags = { title?: string; artist?: string; album?: string; year?: string; genre?: string; cover?: Blob };

/** Reads embedded tags and cover art. Returns {} for a file with no tags or one the parser cannot read. */
export async function readTags(file: Blob): Promise<Tags> {
  try {
    const { common } = await parseBlob(file, { skipPostHeaders: true });
    const picture = selectCover(common.picture);
    const clean = (value?: string) => value?.trim() || undefined;
    return {
      title: clean(common.title), artist: clean(common.artist), album: clean(common.album),
      year: common.year ? String(common.year) : undefined, genre: clean(common.genre?.[0]),
      cover: picture ? new Blob([new Uint8Array(picture.data)], { type: picture.format || "image/jpeg" }) : undefined,
    };
  } catch { return {}; }
}

/** Cover size cap, in pixels on the long side: covers show at most a few hundred CSS pixels, so this stays sharp at 2x. */
const COVER_MAX = 640;
/** WebP quality for covers: no visible loss on artwork at this size, about a third lighter than JPEG at 0.88. */
const COVER_QUALITY = 0.86;

/** Whether a stored cover is worth re-encoding: a WebP is already done, and a small file has little left to save. */
export const coverNeedsShrink = (image: Blob) => image.type !== "image/webp" && image.size > 40_000;

/** Downscales a cover and re-encodes it as WebP, so a large embedded image does not bloat local storage or decode slowly.
    A browser that cannot encode WebP gets JPEG. The original comes back when re-encoding would not make it smaller. */
export async function shrinkCover(image: Blob, max = COVER_MAX): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(image);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && !coverNeedsShrink(image)) { bitmap.close(); return image; }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) { bitmap.close(); return image; }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const encode = (type: string, quality: number) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
    // toBlob falls back to PNG for a type the browser cannot write, so the result's type says whether WebP worked.
    let out = await encode("image/webp", COVER_QUALITY);
    if (!out || out.type !== "image/webp") out = await encode("image/jpeg", 0.88);
    return out && (out.size < image.size || scale < 1) ? out : image;
  } catch { return image; }
}
