import { useEffect, useState } from "react";
import type { Label, LabelWithCount } from "common/api-types";
import { api } from "../api";
import { Link } from "../router";
import { Icon } from "../components/Icon";
import { errorMessage, useToast } from "../components/ui";

export const LabelsBar = ({ pageId, editable }: { pageId: string; editable: boolean }) => {
  const toast = useToast();
  const [labels, setLabels] = useState<Label[]>([]);
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<LabelWithCount[]>([]);

  useEffect(() => {
    api
      .pageLabels(pageId)
      .then(setLabels)
      .catch(() => undefined);
  }, [pageId]);

  useEffect(() => {
    if (!adding) return;
    const t = setTimeout(() => {
      api
        .labels(value.trim() || undefined)
        .then((all) => setSuggestions(all.filter((l) => !labels.some((x) => x.id === l.id)).slice(0, 6)))
        .catch(() => undefined);
    }, 120);
    return () => clearTimeout(t);
  }, [value, adding, labels]);

  const add = async (name: string) => {
    const clean = name.trim();
    if (!clean) return;
    try {
      setLabels(await api.addLabels(pageId, [clean]));
      setValue("");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const remove = async (label: Label) => {
    try {
      await api.removeLabel(pageId, label.id);
      setLabels((l) => l.filter((x) => x.id !== label.id));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  if (!labels.length && !editable) return null;
  return (
    <div className="labels-bar">
      {labels.map((l) => (
        <span key={l.id} className="label-chip">
          <Link to={`/labels/${l.id}`}>#{l.name}</Link>
          {editable && (
            <button type="button" aria-label={`Remove ${l.name}`} onClick={() => remove(l)}>
              <Icon name="x" size={11} />
            </button>
          )}
        </span>
      ))}
      {editable &&
        (adding ? (
          <span className="label-input-wrap">
            <input
              className="label-input"
              autoFocus
              value={value}
              placeholder="Add label"
              maxLength={60}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => setTimeout(() => setAdding(false), 150)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add(value);
                } else if (e.key === "Escape") setAdding(false);
              }}
            />
            {suggestions.length > 0 && (
              <span className="label-suggestions">
                {suggestions.map((s) => (
                  <button key={s.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(s.name)}>
                    #{s.name}
                  </button>
                ))}
              </span>
            )}
          </span>
        ) : (
          <button type="button" className="ghost-tool small" onClick={() => setAdding(true)}>
            <Icon name="label" size={13} /> {labels.length ? "" : "Add label"}
          </button>
        ))}
    </div>
  );
};
