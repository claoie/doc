export interface EmbedProvider {
  id: string;
  name: string;
  match: RegExp;
  /** Turns a matched page URL into the URL to put in the iframe. */
  embedUrl: (url: string, m: RegExpMatchArray) => string;
}

export const EMBED_PROVIDERS: EmbedProvider[] = [
  {
    id: "loom",
    name: "Loom",
    match: /^https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([\da-zA-Z]+)/,
    embedUrl: (_u, m) => `https://www.loom.com/embed/${m[1]}`,
  },
  {
    id: "airtable",
    name: "Airtable",
    match: /^https:\/\/(?:www\.)?airtable\.com\/(?:embed\/)?([a-zA-Z0-9]{2,}.*)$/,
    embedUrl: (_u, m) => `https://airtable.com/embed/${m[1]}`,
  },
  {
    id: "figma",
    name: "Figma",
    match: /^https:\/\/[\w.-]*figma\.com\/(file|proto|board|design|slides|deck)\/([0-9a-zA-Z]{22,128})/,
    embedUrl: (u) => `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(u)}`,
  },
  {
    id: "typeform",
    name: "Typeform",
    match: /^https?:\/\/[\w.]+\.typeform\.com\/to\/.+/,
    embedUrl: (u) => u,
  },
  {
    id: "miro",
    name: "Miro",
    match: /^https:\/\/(?:www\.)?miro\.com\/app\/board\/([\w-]+=)/,
    embedUrl: (_u, m) => `https://miro.com/app/live-embed/${m[1]}?embedMode=view_only_without_ui`,
  },
  {
    id: "youtube",
    name: "YouTube",
    match: /^(?:https?:)?\/\/(?:(?:www|m|music)\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/|live\/)?([\w-]{11})/,
    embedUrl: (_u, m) => `https://www.youtube-nocookie.com/embed/${m[1]}`,
  },
  {
    id: "vimeo",
    name: "Vimeo",
    match: /^(?:https:)?\/\/(?:www\.|player\.)?vimeo\.com\/(?:channels\/(?:\w+\/)?|groups\/[^/]*\/videos\/|album\/\d+\/video\/|video\/|)(\d+)(?:\/([\da-zA-Z]+))?/,
    embedUrl: (_u, m) => `https://player.vimeo.com/video/${m[1]}${m[2] ? `?h=${m[2]}` : ""}`,
  },
  {
    id: "framer",
    name: "Framer",
    match: /^https:\/\/(?:www\.)?framer\.com\/embed\/([\w-]+)/,
    embedUrl: (u) => u,
  },
  {
    id: "gdrive",
    name: "Google Drive",
    match: /^(?:https?:)?\/\/(?:(?:www|m)\.)?drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
    embedUrl: (_u, m) => `https://drive.google.com/file/d/${m[1]}/preview`,
  },
  {
    id: "gsheets",
    name: "Google Sheets",
    match: /^(?:https?:)?\/\/(?:(?:www|m)\.)?docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    embedUrl: (u) => u,
  },
];

export const IFRAME_PROVIDER: EmbedProvider = { id: "iframe", name: "Iframe", match: /^https?:\/\//, embedUrl: (u) => u };

export const providerById = (id: string | null | undefined) =>
  EMBED_PROVIDERS.find((p) => p.id === id?.toLowerCase() || p.name.toLowerCase() === id?.toLowerCase()) ??
  (id === "iframe" ? IFRAME_PROVIDER : undefined);

/** Resolves the iframe URL for an embed `src`; only https URLs are ever framed. */
export const embedFor = (src: string): { url: string; provider: EmbedProvider } | null => {
  const s = src.trim();
  for (const p of EMBED_PROVIDERS) {
    const m = s.match(p.match);
    if (m) return { url: p.embedUrl(s, m), provider: p };
  }
  if (/^https:\/\//.test(s)) return { url: s, provider: IFRAME_PROVIDER };
  return null;
};
