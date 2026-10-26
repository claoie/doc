import { useState } from "react";
import type { Page } from "common/api-types";
import { api } from "../api";
import { Button, Modal } from "../components/ui";

export const ExportDialog = ({ page, onClose }: { page: Pick<Page, "id" | "hasChildren">; onClose: () => void }) => {
  const [format, setFormat] = useState<"markdown" | "html">("markdown");
  const [children, setChildren] = useState(false);
  const [files, setFiles] = useState(false);
  const url = api.pageExportUrl(page.id, format, children, files);
  return (
    <Modal
      title="Export page"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <a className="btn btn-primary" href={url} download onClick={() => setTimeout(onClose, 300)}>
            Export
          </a>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Format</span>
        <select className="input" value={format} onChange={(e) => setFormat(e.target.value as "markdown" | "html")}>
          <option value="markdown">Markdown</option>
          <option value="html">HTML</option>
        </select>
      </label>
      {page.hasChildren && (
        <label className="check-row">
          <input type="checkbox" checked={children} onChange={(e) => setChildren(e.target.checked)} />
          <span>Include subpages</span>
        </label>
      )}
      <label className="check-row">
        <input type="checkbox" checked={files} onChange={(e) => setFiles(e.target.checked)} />
        <span>Include attachments and images</span>
      </label>
      <p className="muted small">{children || files ? "Downloads a zip file." : `Downloads a single .${format === "markdown" ? "md" : "html"} file.`}</p>
    </Modal>
  );
};
