import { useEffect, useState } from "react";
import type { PageFile } from "common/api-types";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Modal, Spinner, timeAgo } from "../components/ui";

const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const AttachmentsDialog = ({ pageId, onClose }: { pageId: string; onClose: () => void }) => {
  const [files, setFiles] = useState<PageFile[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    api
      .pageFiles(pageId)
      .then(setFiles)
      .catch(() => setFiles([]));
  }, [pageId]);
  const visible = files?.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <Modal title="Attachments" onClose={onClose} width={560}>
      <input className="input" placeholder="Search files" value={query} onChange={(e) => setQuery(e.target.value)} />
      {!visible && <Spinner />}
      {visible?.length === 0 && <div className="muted pad">No files uploaded to this page.</div>}
      <div className="list">
        {visible?.map((f) => (
          <a key={f.id} className="list-row clickable" href={f.url} target="_blank" rel="noopener">
            <Icon name={f.mime.startsWith("image/") ? "image" : f.mime.startsWith("video/") ? "video" : "file"} size={18} />
            <span className="list-main">
              <span>{f.name}</span>
              <span className="muted small" style={{ display: "block" }}>
                {formatSize(f.size)} · {f.uploader ? `uploaded by ${f.uploader.name} ` : ""}
                {timeAgo(f.createdAt)}
              </span>
            </span>
            <Icon name="download" size={16} />
          </a>
        ))}
      </div>
    </Modal>
  );
};
