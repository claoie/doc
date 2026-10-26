type Mermaid = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

import { MERMAID_URL } from "common/mermaid";

let loading: Promise<Mermaid> | null = null;

/** Loads the diagram renderer on first use only, so pages without diagrams never pay for it. */
export const loadMermaid = (): Promise<Mermaid> => {
  if (!loading) {
    loading = import(/* @vite-ignore */ MERMAID_URL).then((mod: { default: Mermaid }) => {
      const dark = document.documentElement.getAttribute("data-theme") === "dark" ||
        (!document.documentElement.getAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
      mod.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
      return mod.default;
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
};
