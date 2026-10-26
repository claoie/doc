import type { Attrs } from "common/editor/model";
import type { UploadedFile } from "common/api-types";
import { api } from "../../api";

const DRAWIO_URL = "https://embed.diagrams.net/?embed=1&proto=json&spin=1&libraries=1&saveAndExit=1&noSaveBtn=1&noExitBtn=0";

/** Served from the app origin but loaded in a sandbox without same-origin access. */
const EXCALIDRAW_URL = "/excalidraw.html";

const modal = () => {
  const backdrop = document.createElement("div");
  backdrop.className = "diagram-modal";
  const frame = document.createElement("iframe");
  frame.className = "diagram-frame";
  backdrop.append(frame);
  document.body.append(backdrop);
  document.body.style.overflow = "hidden";
  return {
    frame,
    close: () => {
      backdrop.remove();
      document.body.style.overflow = "";
    },
  };
};

const fetchSvg = async (src: string) => {
  if (!src) return "";
  const res = await fetch(src.split("?")[0]!, { credentials: "same-origin" });
  return res.ok ? res.text() : "";
};

const dataUrlToBlob = (dataUrl: string) => {
  const [head, body] = dataUrl.split(",");
  const mime = head?.match(/data:([^;]+)/)?.[1] ?? "image/svg+xml";
  const binary = head?.includes(";base64") ? atob(body ?? "") : decodeURIComponent(body ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

/**
 * Opens the diagram editor for a drawio/excalidraw node. Diagrams are stored
 * as SVG files with the editable scene embedded, so the image renders
 * anywhere and re-opens for editing.
 */
export const openDiagramEditor = (
  kind: "drawio" | "excalidraw",
  attrs: Attrs,
  pageId: string,
  save: (result: { file: UploadedFile; width?: number; height?: number }) => void,
) => {
  const { frame, close } = modal();
  const existingId = (attrs.attachmentId as string | null) ?? undefined;
  const upload = async (blob: Blob, width?: number, height?: number) => {
    const file = new File([blob], `${kind}.svg`, { type: "image/svg+xml" });
    const uploaded = await api.uploadFile(file, pageId, existingId);
    save({ file: uploaded, width, height });
  };

  if (kind === "drawio") {
    const origin = new URL(DRAWIO_URL).origin;
    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== origin || typeof e.data !== "string") return;
      let msg: { event: string; data?: string; xml?: string };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      const post = (data: Record<string, unknown>) => frame.contentWindow?.postMessage(JSON.stringify(data), origin);
      if (msg.event === "init") {
        const svg = await fetchSvg(String(attrs.src ?? ""));
        post({ action: "load", xml: svg || "", autosave: 0 });
      } else if (msg.event === "save") {
        post({ action: "export", format: "xmlsvg", spinKey: "saving" });
      } else if (msg.event === "export" && msg.data) {
        try {
          await upload(dataUrlToBlob(msg.data));
        } finally {
          window.removeEventListener("message", onMessage);
          close();
        }
      } else if (msg.event === "exit") {
        window.removeEventListener("message", onMessage);
        close();
      }
    };
    window.addEventListener("message", onMessage);
    frame.src = DRAWIO_URL;
    return;
  }

  const onMessage = async (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || e.data?.source !== "excalidraw-frame") return;
    if (e.data.type === "ready") {
      const svg = await fetchSvg(String(attrs.src ?? ""));
      if (svg) frame.contentWindow?.postMessage({ source: "doc-app", type: "load", svg }, "*");
    } else if (e.data.type === "save") {
      try {
        await upload(new Blob([e.data.svg as string], { type: "image/svg+xml" }), e.data.width, e.data.height);
      } finally {
        window.removeEventListener("message", onMessage);
        close();
      }
    } else if (e.data.type === "close") {
      window.removeEventListener("message", onMessage);
      close();
    }
  };
  window.addEventListener("message", onMessage);
  frame.setAttribute("sandbox", "allow-scripts allow-popups allow-downloads");
  frame.src = EXCALIDRAW_URL;
};
