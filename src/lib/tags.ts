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

/** Downscales a cover so a large image does not bloat local storage. */
export async function shrinkCover(image: Blob, max = 800): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(image);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && image.size < 300_000) { bitmap.close(); return image; }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b ?? image), "image/jpeg", 0.88));
  } catch { return image; }
}
