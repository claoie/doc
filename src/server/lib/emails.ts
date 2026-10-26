import { escapeHtml } from "common/editor/html";
import type { Mail } from "./mail";

interface Template {
  to: string;
  subject: string;
  paragraphs: string[];
  action?: { label: string; url: string };
}

/** Renders a short transactional email as plain text and minimal inline-styled HTML. */
export const renderMail = ({ to, subject, paragraphs, action }: Template): Mail => {
  const text = [...paragraphs, ...(action ? [`${action.label}: ${action.url}`] : [])].join("\n\n");
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join("");
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(action.label)}</a></p><p style="color:#666;font-size:12px">${escapeHtml(action.url)}</p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#222;line-height:1.5"><div style="max-width:560px;margin:0 auto;padding:24px">${body}${button}</div></body></html>`;
  return { to, subject, text, html };
};
