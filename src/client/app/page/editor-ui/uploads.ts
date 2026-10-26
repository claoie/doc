import type { Node } from "common/editor/model";
import { schema } from "common/editor/doc-schema";
import { insertBlocks } from "common/editor/commands";
import type { UploadedFile } from "common/api-types";
import type { Editor } from "../../../editor/editor";
import { api } from "../../api";

const imageSize = (file: File) =>
  new Promise<{ width: number; height: number } | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });

export const nodeForFile = async (file: File, uploaded: UploadedFile): Promise<Node> => {
  const mime = uploaded.mime || file.type;
  if (mime.startsWith("image/")) {
    const size = await imageSize(file);
    return schema.node("image", {
      src: uploaded.url,
      attachmentId: uploaded.id,
      size: uploaded.size,
      alt: null,
      aspectRatio: size ? size.width / size.height : null,
      width: size && size.width < 720 ? size.width : null,
    });
  }
  if (mime.startsWith("video/")) return schema.node("video", { src: uploaded.url, attachmentId: uploaded.id, size: uploaded.size });
  if (mime.startsWith("audio/")) return schema.node("audio", { src: uploaded.url, attachmentId: uploaded.id, size: uploaded.size });
  if (mime === "application/pdf") return schema.node("pdf", { src: uploaded.url, attachmentId: uploaded.id, size: uploaded.size, name: uploaded.name });
  return schema.node("attachment", { url: uploaded.url, name: uploaded.name, mime, size: uploaded.size, attachmentId: uploaded.id });
};

/** Uploads files one by one and inserts a node for each at the cursor. */
export const insertUploadedFiles = async (editor: Editor, files: File[], pageId: string, onError: (message: string) => void) => {
  for (const file of files) {
    const notice = document.createElement("div");
    notice.className = "upload-notice";
    notice.textContent = `Uploading ${file.name}…`;
    document.body.append(notice);
    try {
      const uploaded = await api.uploadFile(file, pageId);
      const node = await nodeForFile(file, uploaded);
      editor.run(insertBlocks([node], false));
    } catch (e) {
      onError(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
    } finally {
      notice.remove();
    }
  }
};

/** Opens the OS file picker. */
export const pickFiles = (accept: string, multiple: boolean): Promise<File[]> =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
