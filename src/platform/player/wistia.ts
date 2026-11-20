// Wistia links play as Wistia's own iframe player, not through Video.js (its
// web component brings a build toolchain along as a runtime dependency). The
// frame is the player's root, so it has the same box and shape as the others.

const WISTIA_HOST = /(^|\.)(wistia\.com|wistia\.net|wi\.st)$/i;
const MEDIA_ID = /^[a-z0-9]{6,20}$/i;

// wistiaEmbedUrl is the https://fast.wistia.net/embed/iframe/<id> address for a
// Wistia link (a share, media page or embed URL), or null for anything else.
export function wistiaEmbedUrl(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !WISTIA_HOST.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const at = parts.findIndex((p) => p === 'medias' || p === 'iframe');
  const id = (at >= 0 ? parts[at + 1] : parts.at(-1))?.replace(/\.(jsonp?|js)$/i, '');
  return id && MEDIA_ID.test(id) ? `https://fast.wistia.net/embed/iframe/${id}` : null;
}
