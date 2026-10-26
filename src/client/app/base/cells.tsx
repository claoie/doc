import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CHOICE_COLORS, type Choice, type FileValue, type Property, type Row, type RowReferences } from "common/bases";
import { isErrorValue } from "common/formula";
import type { UserRef } from "common/api-types";
import { api } from "../api";
import { Icon, type IconName } from "../components/Icon";
import { Avatar, Popover, Spinner, cx, errorMessage, useToast } from "../components/ui";
import { Link, pageUrl } from "../router";
import { choicesOf, dayKey, formatDate, formatNumber, formatTimestamp, listOf, parseDate, readCell } from "./format";

export const TYPE_LABELS: Record<Property["type"], string> = {
  text: "Text",
  longText: "Long text",
  number: "Number",
  select: "Select",
  status: "Status",
  multiSelect: "Multi-select",
  date: "Date",
  checkbox: "Checkbox",
  person: "Person",
  file: "Files",
  page: "Page",
  url: "URL",
  email: "Email",
  formula: "Formula",
  createdAt: "Created time",
  lastEditedAt: "Last edited time",
  lastEditedBy: "Last edited by",
};

export const TYPE_ICONS: Record<Property["type"], IconName> = {
  text: "text",
  longText: "alignLeft",
  number: "hash",
  select: "chevronDown",
  status: "status",
  multiSelect: "list",
  date: "calendar",
  checkbox: "listTask",
  person: "user",
  file: "attach",
  page: "page",
  url: "link",
  email: "at",
  formula: "math",
  createdAt: "clock",
  lastEditedAt: "clock",
  lastEditedBy: "user",
};

/** How a cell is edited: in place, by toggling, in a popover, or not at all. */
export const editMode = (prop: Property): "inline" | "toggle" | "popover" | "none" => {
  switch (prop.type) {
    case "text":
    case "url":
    case "email":
    case "number":
    case "longText":
      return "inline";
    case "checkbox":
      return "toggle";
    case "select":
    case "status":
    case "multiSelect":
    case "date":
    case "person":
    case "page":
    case "file":
      return "popover";
  }
  return "none";
};

export const ChoiceBadge = ({ choice, plain }: { choice: Choice; plain?: boolean }) => (
  <span className={cx("choice", !plain && `choice-${CHOICE_COLORS.includes(choice.color as never) ? choice.color : "gray"}`)}>{choice.name || "Untitled"}</span>
);

const PersonChip = ({ user }: { user: UserRef | undefined }) =>
  user ? (
    <span className="person-chip">
      <Avatar name={user.name} url={user.avatarUrl} size={18} />
      {user.name}
    </span>
  ) : null;

const href = (value: string, type: "url" | "email") => (type === "email" ? `mailto:${value}` : /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);

/** Read-only rendering of a cell value. */
export const CellView = ({ prop, row, refs, plain }: { prop: Property; row: Row; refs: RowReferences; plain?: boolean }) => {
  const value = readCell(prop, row);
  switch (prop.type) {
    case "text":
      return <span className="cell-text">{typeof value === "string" ? value : ""}</span>;
    case "longText":
      return <span className="cell-text cell-long">{typeof value === "string" ? value : ""}</span>;
    case "url":
    case "email":
      return typeof value === "string" && value ? (
        <a className="cell-link" href={href(value, prop.type)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {value}
        </a>
      ) : null;
    case "number":
      if (prop.options.format === "progress" && typeof value === "number") {
        const pct = Math.max(0, Math.min(100, value));
        return (
          <span className="cell-progress">
            <span className="progress-bar">
              <span style={{ width: `${pct}%` }} />
            </span>
            {formatNumber(value, prop)}
          </span>
        );
      }
      return <span className="cell-number">{formatNumber(value, prop)}</span>;
    case "checkbox":
      return <Icon name={value === true ? "checkSquare" : "square"} size={16} className={cx("cell-check", value === true && "checked")} />;
    case "select":
    case "status":
    case "multiSelect": {
      const choices = prop.options.choices ?? [];
      return (
        <span className="cell-choices">
          {listOf(value).map((id) => {
            const choice = choices.find((c) => c.id === id);
            return choice ? <ChoiceBadge key={id} choice={choice} plain={plain || prop.options.disableColors} /> : null;
          })}
        </span>
      );
    }
    case "date":
      return <span className="cell-text">{formatDate(value, prop)}</span>;
    case "createdAt":
    case "lastEditedAt":
      return <span className="cell-text muted">{formatTimestamp(String(value))}</span>;
    case "person":
    case "lastEditedBy":
      return (
        <span className="cell-people">
          {listOf(value).map((id) => (
            <PersonChip key={id} user={refs.users[id]} />
          ))}
        </span>
      );
    case "page": {
      if (typeof value !== "string" || !value) return null;
      const page = refs.pages[value];
      if (!page) return <span className="muted cell-text">Page unavailable</span>;
      return (
        <Link to={pageUrl(page.spaceSlug, page)} className="page-chip" onClick={(e) => e.stopPropagation()}>
          {page.icon ? <span>{page.icon}</span> : <Icon name="page" size={14} />}
          {page.title || "Untitled"}
        </Link>
      );
    }
    case "file":
      return (
        <span className="cell-files">
          {(Array.isArray(value) ? (value as FileValue[]) : []).map((f) => (
            <a key={f.id} className="file-chip" href={f.url ?? `/api/files/${f.id}/${encodeURIComponent(f.fileName)}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              <Icon name="attach" size={13} />
              {f.fileName}
            </a>
          ))}
        </span>
      );
    case "formula": {
      if (isErrorValue(value)) {
        return (
          <span className="cell-error" title={value.message}>
            <Icon name="alert" size={14} /> #ERROR
          </span>
        );
      }
      if (typeof value === "boolean") return <Icon name={value ? "checkSquare" : "square"} size={16} className={cx("cell-check", value && "checked")} />;
      if (prop.options.resultType === "number") return <span className="cell-number">{formatNumber(value, prop)}</span>;
      if (prop.options.resultType === "date") return <span className="cell-text">{formatDate(value, { options: { ...prop.options, includeTime: true } })}</span>;
      return <span className="cell-text">{value === null || value === undefined ? "" : String(value)}</span>;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Inline editors

export const InlineEditor = ({
  prop,
  initial,
  seed,
  onCommit,
  onCancel,
}: {
  prop: Property;
  initial: unknown;
  seed?: string;
  onCommit: (value: unknown, move?: "next" | "prev" | "down") => void;
  onCancel: () => void;
}) => {
  const start = seed ?? (initial === null || initial === undefined ? "" : String(initial));
  const [text, setText] = useState(start);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);
  const parse = (): { ok: boolean; value: unknown } => {
    if (prop.type === "number") {
      const cleaned = text.replace(/[,\s]/g, "").replace(/%$/, "");
      if (!cleaned) return { ok: true, value: null };
      const n = Number(cleaned);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, value: null };
    }
    const value = prop.type === "url" || prop.type === "email" ? text.trim() : text;
    return { ok: true, value: value === "" ? null : value };
  };
  const commit = (move?: "next" | "prev" | "down") => {
    if (done.current) return;
    done.current = true;
    const { ok, value } = parse();
    if (ok) onCommit(value, move);
    else onCancel();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      done.current = true;
      onCancel();
    } else if (e.key === "Enter" && !(prop.type === "longText" && e.shiftKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commit("down");
    } else if (e.key === "Tab") {
      e.preventDefault();
      commit(e.shiftKey ? "prev" : "next");
    }
  };
  if (prop.type === "longText") {
    return (
      <textarea
        ref={ref}
        className="cell-input cell-textarea"
        value={text}
        rows={Math.min(10, Math.max(3, text.split("\n").length))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit()}
      />
    );
  }
  return (
    <input
      ref={ref}
      className={cx("cell-input", prop.type === "number" && "cell-number")}
      value={text}
      inputMode={prop.type === "number" ? "decimal" : prop.type === "email" ? "email" : prop.type === "url" ? "url" : undefined}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => commit()}
    />
  );
};

// ---------------------------------------------------------------------------
// Popover editors

const SearchList = <T,>({
  items,
  render,
  onPick,
  query,
  setQuery,
  placeholder,
  empty,
  footer,
  onEnterNew,
  loading,
}: {
  items: T[];
  render: (item: T, active: boolean) => ReactNode;
  onPick: (item: T) => void;
  query: string;
  setQuery: (q: string) => void;
  placeholder: string;
  empty: string;
  footer?: ReactNode;
  onEnterNew?: () => void;
  loading?: boolean;
}) => {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query, items.length]);
  return (
    <div className="search-list">
      <input
        className="input"
        autoFocus
        data-autofocus
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(items.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            const item = items[active];
            if (item !== undefined) onPick(item);
            else onEnterNew?.();
          }
        }}
      />
      <div className="search-list-items">
        {loading && <Spinner size={14} />}
        {!loading && items.length === 0 && !onEnterNew && <div className="muted pad-sm">{empty}</div>}
        {items.map((item, i) => (
          <button key={i} type="button" className={cx("search-list-item", i === active && "active")} onMouseEnter={() => setActive(i)} onClick={() => onPick(item)}>
            {render(item, i === active)}
          </button>
        ))}
      </div>
      {footer}
    </div>
  );
};

export const ChoiceEditor = ({
  prop,
  value,
  onChange,
  onClose,
  onAddChoice,
}: {
  prop: Property;
  value: unknown;
  onChange: (value: unknown) => void;
  onClose: () => void;
  onAddChoice?: (name: string) => Promise<Choice | null>;
}) => {
  const [query, setQuery] = useState("");
  const multi = prop.type === "multiSelect";
  const selected = listOf(value);
  const choices = choicesOf(prop);
  const q = query.trim().toLowerCase();
  const matches = choices.filter((c) => c.name.toLowerCase().includes(q));
  const exact = choices.some((c) => c.name.trim().toLowerCase() === q);
  const pick = (choice: Choice) => {
    if (multi) {
      const next = selected.includes(choice.id) ? selected.filter((id) => id !== choice.id) : [...selected, choice.id];
      onChange(next.length ? next : null);
      setQuery("");
    } else {
      onChange(choice.id);
      onClose();
    }
  };
  const create = async () => {
    if (!onAddChoice || !q || exact) return;
    const choice = await onAddChoice(query.trim());
    if (choice) {
      if (multi) onChange([...selected, choice.id]);
      else {
        onChange(choice.id);
        onClose();
      }
      setQuery("");
    }
  };
  return (
    <div className="choice-editor">
      {multi && selected.length > 0 && (
        <div className="cell-choices pad-sm">
          {selected.map((id) => {
            const c = choices.find((x) => x.id === id);
            return c ? (
              <button key={id} type="button" className="chip-remove" onClick={() => onChange(selected.filter((x) => x !== id).length ? selected.filter((x) => x !== id) : null)}>
                <ChoiceBadge choice={c} plain={prop.options.disableColors} /> <Icon name="x" size={11} />
              </button>
            ) : null;
          })}
        </div>
      )}
      <SearchList
        items={matches}
        query={query}
        setQuery={setQuery}
        placeholder={onAddChoice ? "Search or create an option" : "Search options"}
        empty={choices.length ? "No matches" : "No options yet"}
        onPick={pick}
        onEnterNew={onAddChoice && q && !exact ? create : undefined}
        render={(c) => (
          <>
            <ChoiceBadge choice={c} plain={prop.options.disableColors} />
            <span className="spacer" />
            {selected.includes(c.id) && <Icon name="check" size={14} />}
          </>
        )}
        footer={
          <>
            {onAddChoice && q && !exact && (
              <button type="button" className="search-list-item" onClick={create}>
                <Icon name="plus" size={14} /> Create <strong>{query.trim()}</strong>
              </button>
            )}
            {!multi && value ? (
              <button type="button" className="search-list-item muted" onClick={() => (onChange(null), onClose())}>
                <Icon name="x" size={14} /> Clear
              </button>
            ) : null}
          </>
        }
      />
    </div>
  );
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const DatePicker = ({ value, includeTime, onChange }: { value: string | null; includeTime: boolean; onChange: (value: string | null, close?: boolean) => void }) => {
  const parsed = parseDate(value);
  const [month, setMonth] = useState(() => {
    const d = parsed?.date ?? new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const selectedKey = parsed ? dayKey(parsed.date) : null;
  const time = parsed && !parsed.dateOnly ? `${String(parsed.date.getHours()).padStart(2, "0")}:${String(parsed.date.getMinutes()).padStart(2, "0")}` : "09:00";
  const days = useMemo(() => {
    const first = new Date(month);
    const offset = (first.getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), 1 - offset + i));
  }, [month]);
  const emit = (day: Date, t = time) => {
    if (!includeTime) return onChange(dayKey(day), true);
    const [h, m] = t.split(":").map(Number);
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h ?? 9, m ?? 0);
    onChange(at.toISOString());
  };
  const todayKey = dayKey(new Date());
  return (
    <div className="date-picker">
      <div className="date-picker-head">
        <button type="button" className="icon-button" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <span>
          {MONTH_NAMES[month.getMonth()]} {month.getFullYear()}
        </span>
        <button type="button" className="icon-button" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
      <div className="date-grid">
        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
          <span key={d} className="date-dow">
            {d}
          </span>
        ))}
        {days.map((d) => {
          const key = dayKey(d);
          return (
            <button
              key={key}
              type="button"
              className={cx("date-day", d.getMonth() !== month.getMonth() && "other", key === selectedKey && "selected", key === todayKey && "today")}
              onClick={() => emit(d)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <div className="date-picker-foot">
        {includeTime && (
          <input type="time" className="input input-sm" value={time} onChange={(e) => parsed && emit(parsed.date, e.target.value)} disabled={!parsed} />
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => emit(new Date())}>
          Today
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null, true)}>
          Clear
        </button>
      </div>
    </div>
  );
};

export const PersonPicker = ({
  value,
  multiple,
  onChange,
  onClose,
  onUsers,
}: {
  value: unknown;
  multiple: boolean;
  onChange: (value: unknown) => void;
  onClose: () => void;
  onUsers?: (users: Record<string, UserRef>) => void;
}) => {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<UserRef[]>([]);
  const [loading, setLoading] = useState(true);
  const selected = listOf(value);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      const load = query.trim()
        ? api.suggest({ q: query.trim(), users: true, pages: false, limit: 15 }).then((r) => r.users)
        : api.members({ limit: 50 }).then((r) => r.items.filter((m) => !m.deactivatedAt));
      load
        .then((list) => {
          if (cancelled) return;
          const refs = list.map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatarUrl ?? null }));
          setUsers(refs);
          onUsers?.(Object.fromEntries(refs.map((u) => [u.id, u])));
        })
        .catch(() => !cancelled && setUsers([]))
        .finally(() => !cancelled && setLoading(false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  return (
    <SearchList
      items={users}
      query={query}
      setQuery={setQuery}
      placeholder="Search people"
      empty="No people found"
      loading={loading}
      onPick={(u) => {
        if (multiple) {
          const next = selected.includes(u.id) ? selected.filter((id) => id !== u.id) : [...selected, u.id];
          onChange(next.length ? next : null);
        } else {
          onChange(u.id === value ? null : u.id);
          onClose();
        }
      }}
      render={(u) => (
        <>
          <Avatar name={u.name} url={u.avatarUrl} size={20} />
          <span>{u.name}</span>
          <span className="spacer" />
          {selected.includes(u.id) && <Icon name="check" size={14} />}
        </>
      )}
      footer={
        selected.length > 0 ? (
          <button type="button" className="search-list-item muted" onClick={() => (onChange(null), onClose())}>
            <Icon name="x" size={14} /> Clear
          </button>
        ) : undefined
      }
    />
  );
};

export const PagePicker = ({ onPick, onClear, hasValue }: { onPick: (page: { id: string; title: string | null; icon: string | null; slugId: string; spaceSlug: string }) => void; onClear: () => void; hasValue: boolean }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; title: string | null; icon: string | null; slugId: string; spaceSlug: string; spaceName: string }[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .search({ q: query.trim(), titleOnly: true, limit: 15 })
        .then((list) => !cancelled && setResults(list.map((p) => ({ id: p.id, title: p.title, icon: p.icon, slugId: p.slugId, spaceSlug: p.space.slug, spaceName: p.space.name }))))
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setLoading(false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);
  return (
    <SearchList
      items={results}
      query={query}
      setQuery={setQuery}
      placeholder="Type to search pages"
      empty={query.trim() ? "No pages found" : "Type to search pages"}
      loading={loading}
      onPick={onPick}
      render={(p) => (
        <>
          {p.icon ? <span>{p.icon}</span> : <Icon name="page" size={14} />}
          <span className="ellipsis">{p.title || "Untitled"}</span>
          <span className="spacer" />
          <span className="muted small">{p.spaceName}</span>
        </>
      )}
      footer={
        hasValue ? (
          <button type="button" className="search-list-item muted" onClick={onClear}>
            <Icon name="x" size={14} /> Clear
          </button>
        ) : undefined
      }
    />
  );
};

export const FileEditor = ({ pageId, value, onChange }: { pageId: string; value: unknown; onChange: (value: unknown) => void }) => {
  const toast = useToast();
  const files = Array.isArray(value) ? (value as FileValue[]) : [];
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    const added: FileValue[] = [];
    try {
      for (const file of Array.from(list)) {
        const up = await api.uploadFile(file, pageId);
        added.push({ id: up.id, fileName: up.name, mimeType: up.mime, fileSize: up.size, url: up.url });
      }
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setUploading(false);
      if (added.length) onChange([...files, ...added]);
    }
  };
  return (
    <div className="file-editor">
      {files.length === 0 && <div className="muted pad-sm">No files</div>}
      {files.map((f) => (
        <div key={f.id} className="file-row">
          <Icon name="attach" size={14} />
          <a href={f.url ?? `/api/files/${f.id}/${encodeURIComponent(f.fileName)}`} target="_blank" rel="noopener noreferrer" className="ellipsis">
            {f.fileName}
          </a>
          <span className="spacer" />
          <button type="button" className="icon-button" aria-label={`Remove ${f.fileName}`} onClick={() => {
            const next = files.filter((x) => x.id !== f.id);
            onChange(next.length ? next : null);
          }}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
      <button type="button" className="btn btn-ghost btn-sm" disabled={uploading} onClick={() => input.current?.click()}>
        {uploading ? <Spinner size={14} /> : <Icon name="upload" size={14} />} Upload file
      </button>
    </div>
  );
};

/** Popover editor for a cell, chosen by property type. */
export const CellPopover = ({
  anchor,
  prop,
  row,
  pageId,
  onChange,
  onClose,
  onAddChoice,
  onReferences,
}: {
  anchor: HTMLElement;
  prop: Property;
  row: Row;
  pageId: string;
  onChange: (value: unknown) => void;
  onClose: () => void;
  onAddChoice?: (prop: Property, name: string) => Promise<Choice | null>;
  onReferences: (refs: Partial<RowReferences>) => void;
}) => {
  const value = row.cells[prop.id];
  let body: ReactNode = null;
  switch (prop.type) {
    case "select":
    case "status":
    case "multiSelect":
      body = <ChoiceEditor prop={prop} value={value} onChange={onChange} onClose={onClose} onAddChoice={onAddChoice ? (name) => onAddChoice(prop, name) : undefined} />;
      break;
    case "date":
      body = (
        <DatePicker
          value={typeof value === "string" ? value : null}
          includeTime={!!prop.options.includeTime}
          onChange={(v, close) => {
            onChange(v);
            if (close) onClose();
          }}
        />
      );
      break;
    case "person":
      body = <PersonPicker value={value} multiple={!!prop.options.allowMultiple} onChange={onChange} onClose={onClose} onUsers={(users) => onReferences({ users })} />;
      break;
    case "page":
      body = (
        <PagePicker
          hasValue={!!value}
          onClear={() => (onChange(null), onClose())}
          onPick={(p) => {
            onReferences({ pages: { [p.id]: { id: p.id, title: p.title, icon: p.icon, slugId: p.slugId, spaceSlug: p.spaceSlug } } });
            onChange(p.id);
            onClose();
          }}
        />
      );
      break;
    case "file":
      body = <FileEditor pageId={pageId} value={value} onChange={onChange} />;
      break;
  }
  return (
    <Popover anchor={anchor} onClose={onClose} width={prop.type === "date" ? 270 : 280} className="cell-popover">
      {body}
    </Popover>
  );
};

export const nextColor = (choices: Choice[]) => {
  const palette = CHOICE_COLORS.filter((c) => c !== "gray");
  return palette[choices.length % palette.length]!;
};
