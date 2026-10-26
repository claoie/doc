import { useEffect, useMemo, useRef, useState } from "react";
import { CHOICE_COLORS, DEFAULT_STATUS_CHOICES, isChoiceType, isSystemType, type Choice, type Property, type PropertyOptions, type PropertyType, type StatusGroup } from "common/bases";
import { compileFormula, FUNCTIONS, functionSignature, FormulaSyntaxError } from "common/formula";
import { shortId } from "common/ids";
import { Icon } from "../components/Icon";
import { Button, Field, Input, Modal, Popover, cx, useConfirm } from "../components/ui";
import { ChoiceBadge, nextColor, TYPE_ICONS, TYPE_LABELS } from "./cells";
import { DATE_FORMATS, formatPattern } from "./format";

const GROUPS: { label: string; types: PropertyType[] }[] = [
  { label: "Basic", types: ["text", "longText", "number", "select", "status", "multiSelect", "date", "checkbox"] },
  { label: "Advanced", types: ["person", "file", "page", "url", "email", "formula"] },
  { label: "System", types: ["createdAt", "lastEditedAt", "lastEditedBy"] },
];

export const defaultOptions = (type: PropertyType): PropertyOptions => {
  switch (type) {
    case "select":
    case "multiSelect":
      return { choices: [], choiceOrder: [] };
    case "status":
      return { choices: DEFAULT_STATUS_CHOICES, choiceOrder: DEFAULT_STATUS_CHOICES.map((c) => c.id), defaultValue: DEFAULT_STATUS_CHOICES[0]!.id };
    case "number":
      return { format: "plain" };
    case "date":
      return { includeTime: false };
    case "person":
      return { allowMultiple: false };
    case "formula":
      return { source: "" };
  }
  return {};
};

const TEXTUAL: PropertyType[] = ["text", "longText", "url", "email"];

/** What happens to existing values when converting, or null when nothing is lost. */
export const conversionWarning = (from: PropertyType, to: PropertyType): string | null => {
  if (from === to) return null;
  if (TEXTUAL.includes(from) && (to === "text" || to === "longText")) return null;
  if (isChoiceType(from) && to === "multiSelect") return null;
  if ((from === "select" && to === "status") || (from === "status" && to === "select")) return null;
  switch (to) {
    case "text":
    case "longText":
      return "Existing values will be converted to their text form.";
    case "url":
      return "Values that are not valid URLs will be cleared.";
    case "email":
      return "Values that are not valid email addresses will be cleared.";
    case "select":
    case "status":
      return from === "multiSelect" ? "Only the first option of each cell will be kept." : "Existing values cannot become options and will be cleared.";
    case "multiSelect":
      return "Existing values cannot become options and will be cleared.";
    case "number":
      return "Values that cannot be read as a number will be cleared.";
    case "date":
      return "Values that cannot be read as a date will be cleared.";
    case "checkbox":
      return "Values will become checked when they read as true, yes or a non-zero number.";
    case "person":
    case "page":
    case "file":
      return "Existing values will be cleared.";
  }
  return "Existing values may be changed or cleared.";
};

const TypePicker = ({ value, allowed, onChange, disabled }: { value: PropertyType; allowed: PropertyType[]; onChange: (t: PropertyType) => void; disabled: boolean }) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button type="button" className="input type-picker" disabled={disabled} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <Icon name={TYPE_ICONS[value]} size={15} /> {TYPE_LABELS[value]}
        <span className="spacer" />
        {!disabled && <Icon name="chevronDown" size={14} />}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={260} className="type-menu">
          {GROUPS.map((g) => {
            const types = g.types.filter((t) => allowed.includes(t));
            if (!types.length) return null;
            return (
              <div key={g.label}>
                <div className="type-menu-group">{g.label}</div>
                {types.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={cx("search-list-item", t === value && "active")}
                    onClick={() => {
                      onChange(t);
                      setAnchor(null);
                    }}
                  >
                    <Icon name={TYPE_ICONS[t]} size={15} /> {TYPE_LABELS[t]}
                    {t === "file" && <span className="muted small">not sortable</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </Popover>
      )}
    </>
  );
};

const ColorSwatches = ({ value, onPick }: { value: string; onPick: (c: string) => void }) => (
  <div className="swatches">
    {CHOICE_COLORS.map((c) => (
      <button key={c} type="button" className={cx("swatch", `choice-${c}`, c === value && "active")} aria-label={c} title={c} onClick={() => onPick(c)} />
    ))}
  </div>
);

const ChoicesEditor = ({ type, options, setOptions }: { type: PropertyType; options: PropertyOptions; setOptions: (o: PropertyOptions) => void }) => {
  const choices = options.choices ?? [];
  const [name, setName] = useState("");
  const [colorFor, setColorFor] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const set = (next: Choice[], extra: Partial<PropertyOptions> = {}) => setOptions({ ...options, choices: next, choiceOrder: next.map((c) => c.id), ...extra });
  const add = () => {
    const trimmed = name.trim();
    if (!trimmed || choices.some((c) => c.name.trim().toLowerCase() === trimmed.toLowerCase())) return setName("");
    set([...choices, { id: shortId("opt"), name: trimmed, color: nextColor(choices), ...(type === "status" ? { category: "todo" as StatusGroup } : {}) }]);
    setName("");
  };
  const update = (id: string, patch: Partial<Choice>) => set(choices.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const remove = (id: string) => {
    const def = options.defaultValue;
    const nextDefault = Array.isArray(def) ? def.filter((d) => d !== id) : def === id ? null : def;
    set(
      choices.filter((c) => c.id !== id),
      { defaultValue: nextDefault },
    );
  };
  const ordered = [...choices].sort((a, b) => (options.choiceOrder ?? []).indexOf(a.id) - (options.choiceOrder ?? []).indexOf(b.id));
  return (
    <div className="field">
      <span className="field-label">Options</span>
      <div className="choices-editor">
        {ordered.map((c) => (
          <div
            key={c.id}
            className={cx("choice-row", drag === c.id && "dragging")}
            onDragOver={(e) => drag && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!drag || drag === c.id) return;
              const list = ordered.filter((x) => x.id !== drag);
              list.splice(list.findIndex((x) => x.id === c.id), 0, ordered.find((x) => x.id === drag)!);
              set(list);
              setDrag(null);
            }}
          >
            <span className="row-grip" draggable onDragStart={() => setDrag(c.id)} onDragEnd={() => setDrag(null)}>
              <Icon name="drag" size={14} />
            </span>
            <button type="button" className={cx("swatch", `choice-${c.color}`)} disabled={options.disableColors} aria-label="Change color" onClick={(e) => setColorFor({ id: c.id, anchor: e.currentTarget })} />
            <input className="input input-sm" value={c.name} maxLength={200} onChange={(e) => update(c.id, { name: e.target.value })} aria-label="Option name" />
            {type === "status" && (
              <select className="input input-sm" value={c.category ?? "todo"} onChange={(e) => update(c.id, { category: e.target.value as StatusGroup })} aria-label="Group">
                <option value="todo">To do</option>
                <option value="inProgress">In progress</option>
                <option value="complete">Complete</option>
              </select>
            )}
            <button type="button" className="icon-button" aria-label={`Remove ${c.name}`} onClick={() => remove(c.id)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
        <div className="choice-row">
          <input
            className="input input-sm"
            placeholder="Add an option"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="icon-button" aria-label="Add option" onClick={add}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={!options.disableColors} onChange={(e) => setOptions({ ...options, disableColors: !e.target.checked })} />
          <span>Show colors</span>
        </label>
        <label className="field-inline">
          <span>Default</span>
          {type === "multiSelect" ? (
            <span className="cell-choices">
              {ordered.map((c) => {
                const list = Array.isArray(options.defaultValue) ? (options.defaultValue as string[]) : [];
                const on = list.includes(c.id);
                return (
                  <button key={c.id} type="button" className={cx("chip-toggle", on && "on")} onClick={() => setOptions({ ...options, defaultValue: on ? list.filter((x) => x !== c.id) : [...list, c.id] })}>
                    <ChoiceBadge choice={c} plain={options.disableColors} />
                  </button>
                );
              })}
            </span>
          ) : (
            <select className="input input-sm" value={typeof options.defaultValue === "string" ? options.defaultValue : ""} onChange={(e) => setOptions({ ...options, defaultValue: e.target.value || null })}>
              <option value="">None</option>
              {ordered.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </label>
      </div>
      {colorFor && (
        <Popover anchor={colorFor.anchor} onClose={() => setColorFor(null)}>
          <ColorSwatches
            value={choices.find((c) => c.id === colorFor.id)?.color ?? "gray"}
            onPick={(color) => {
              update(colorFor.id, { color });
              setColorFor(null);
            }}
          />
        </Popover>
      )}
    </div>
  );
};

const CATEGORY_LABELS = { logic: "Logic", math: "Math", text: "Text", date: "Date", conversion: "Conversion" } as const;

const FormulaEditor = ({ source, setSource, props, selfId, result }: { source: string; setSource: (s: string) => void; props: Property[]; selfId: string | null; result: { error: string | null; type: string | null } }) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [search, setSearch] = useState("");
  const insert = (text: string) => {
    const el = ref.current;
    if (!el) return setSource(source + text);
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = source.slice(0, start) + text + source.slice(end);
    setSource(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  };
  const q = search.trim().toUpperCase();
  const fns = Object.entries(FUNCTIONS).filter(([name]) => !q || name.includes(q));
  const others = props.filter((p) => p.id !== selfId);
  return (
    <div className="formula-editor">
      <textarea ref={ref} className="input formula-input" rows={3} spellCheck={false} value={source} placeholder={'prop("Price") * prop("Quantity")'} onChange={(e) => setSource(e.target.value)} />
      <div className={cx("formula-status", result.error && "danger")}>
        {result.error ?? (result.type ? `Returns ${result.type === "string" ? "text" : result.type === "null" ? "empty" : result.type}` : "")}
      </div>
      <div className="formula-palette">
        <div className="formula-props">
          {others.map((p) => (
            <button key={p.id} type="button" className="chip" onClick={() => insert(`prop("${p.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`)}>
              <Icon name={TYPE_ICONS[p.type]} size={12} /> {p.name}
            </button>
          ))}
        </div>
        <input className="input input-sm" placeholder="Search functions" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="formula-fns">
          {(Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]).map((cat) => {
            const list = fns.filter(([, def]) => def.category === cat);
            if (!list.length) return null;
            return (
              <div key={cat}>
                <div className="type-menu-group">{CATEGORY_LABELS[cat]}</div>
                {list.map(([name, def]) => (
                  <button key={name} type="button" className="formula-fn" onClick={() => insert(`${name}(`)} title={def.doc}>
                    <code>{functionSignature(name)}</code>
                    <span className="muted small">{def.doc}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const PropertyEditor = ({
  property,
  properties,
  onSave,
  onDelete,
  onClose,
}: {
  property: Property | null;
  properties: Property[];
  onSave: (body: { name: string; type: PropertyType; options: PropertyOptions }) => Promise<boolean>;
  onDelete?: () => void;
  onClose: () => void;
}) => {
  const confirm = useConfirm();
  const [name, setName] = useState(property?.name ?? "");
  const [type, setType] = useState<PropertyType>(property?.type ?? "text");
  const [options, setOptions] = useState<PropertyOptions>(property?.options ?? defaultOptions("text"));
  const [saving, setSaving] = useState(false);
  const [formula, setFormula] = useState<{ error: string | null; type: string | null }>({ error: null, type: null });

  const locked = !!property && (property.isPrimary || property.type === "formula" || isSystemType(property.type));
  const allowed: PropertyType[] = property
    ? GROUPS.flatMap((g) => g.types).filter((t) => t === property.type || (!isSystemType(t) && t !== "formula"))
    : GROUPS.flatMap((g) => g.types);
  const duplicate = properties.some((p) => p.id !== property?.id && p.name.trim().toLowerCase() === name.trim().toLowerCase());

  useEffect(() => {
    if (type !== "formula") return;
    const t = setTimeout(() => {
      try {
        const compiled = compileFormula(options.source ?? "", properties, property?.id ?? null);
        setFormula({ error: null, type: compiled.resultType });
      } catch (e) {
        setFormula({ error: e instanceof FormulaSyntaxError ? e.message : "Invalid formula", type: null });
      }
    }, 150);
    return () => clearTimeout(t);
  }, [type, options.source, properties, property?.id]);

  const changeType = (next: PropertyType) => {
    setType(next);
    setOptions(property && next === property.type ? property.options : isChoiceType(next) && isChoiceType(type) ? { ...defaultOptions(next), choices: options.choices, choiceOrder: options.choiceOrder } : defaultOptions(next));
  };

  const warning = property ? conversionWarning(property.type, type) : null;
  const unchanged = !!property && name === property.name && type === property.type && JSON.stringify(options) === JSON.stringify(property.options);
  const invalid = !name.trim() || duplicate || (type === "formula" && !!formula.error);

  const save = async () => {
    if (invalid || saving) return;
    if (unchanged) return onClose();
    if (warning) {
      const ok = await confirm({ title: `Change type to ${TYPE_LABELS[type]}?`, message: warning, confirmLabel: "Change type" });
      if (!ok) return;
    }
    setSaving(true);
    const ok = await onSave({ name: name.trim(), type, options });
    setSaving(false);
    if (ok) onClose();
  };

  const sample = useMemo(() => new Date(2026, 0, 31), []);

  return (
    <Modal
      title={property ? "Edit property" : "New property"}
      onClose={onClose}
      width={type === "formula" ? 560 : 400}
      footer={
        <>
          {property && !property.isPrimary && onDelete && (
            <Button variant="ghost" className="danger" onClick={onDelete}>
              Delete
            </Button>
          )}
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={invalid || saving} onClick={save}>
            {property ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <div className="property-editor">
        <Field label="Name" error={duplicate ? "A property with this name already exists" : null}>
          <Input
            autoFocus={!property}
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && type !== "formula" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void save();
              }
            }}
          />
        </Field>
        <Field label="Type" hint={property?.isPrimary ? "The title property is always text." : undefined}>
          <TypePicker value={type} allowed={allowed} onChange={changeType} disabled={locked} />
        </Field>
        {warning && <div className="banner banner-warn small">{warning}</div>}
        {isChoiceType(type) && <ChoicesEditor type={type} options={options} setOptions={setOptions} />}
        {type === "number" && (
          <>
            <Field label="Format">
              <select className="input" value={options.format ?? "plain"} onChange={(e) => setOptions({ ...options, format: e.target.value as PropertyOptions["format"] })}>
                <option value="plain">Number</option>
                <option value="currency">Currency</option>
                <option value="percent">Percent</option>
                <option value="progress">Progress bar</option>
              </select>
            </Field>
            {options.format === "currency" && (
              <Field label="Currency code">
                <Input value={options.currencyCode ?? ""} maxLength={8} placeholder="USD" onChange={(e) => setOptions({ ...options, currencyCode: e.target.value.toUpperCase() })} />
              </Field>
            )}
            <Field label="Decimal places">
              <Input
                type="number"
                min={0}
                max={10}
                placeholder="Auto"
                value={typeof options.precision === "number" ? options.precision : ""}
                onChange={(e) => setOptions({ ...options, precision: e.target.value === "" ? undefined : Math.max(0, Math.min(10, Math.trunc(Number(e.target.value)))) })}
              />
            </Field>
            <Field label="Default value">
              <Input type="number" value={typeof options.defaultValue === "number" ? options.defaultValue : ""} onChange={(e) => setOptions({ ...options, defaultValue: e.target.value === "" ? null : Number(e.target.value) })} />
            </Field>
          </>
        )}
        {type === "date" && (
          <>
            <Field label="Date format">
              <select className="input" value={options.dateFormat ?? DATE_FORMATS[0]} onChange={(e) => setOptions({ ...options, dateFormat: e.target.value })}>
                {DATE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {formatPattern(sample, f)}
                  </option>
                ))}
              </select>
            </Field>
            <label className="check-row">
              <input type="checkbox" checked={!!options.includeTime} onChange={(e) => setOptions({ ...options, includeTime: e.target.checked })} />
              <span>Include time</span>
            </label>
            {options.includeTime && (
              <div className="segmented">
                {(["12h", "24h"] as const).map((f) => (
                  <button key={f} type="button" className={cx((options.timeFormat ?? "12h") === f && "active")} onClick={() => setOptions({ ...options, timeFormat: f })}>
                    {f === "12h" ? "12 hour" : "24 hour"}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {type === "person" && (
          <label className="check-row">
            <input type="checkbox" checked={!!options.allowMultiple} onChange={(e) => setOptions({ ...options, allowMultiple: e.target.checked })} />
            <span>Allow multiple people</span>
          </label>
        )}
        {type === "checkbox" && (
          <label className="check-row">
            <input type="checkbox" checked={options.defaultValue === true} onChange={(e) => setOptions({ ...options, defaultValue: e.target.checked })} />
            <span>Checked by default</span>
          </label>
        )}
        {TEXTUAL.includes(type) && (
          <Field label="Default value">
            <Input value={typeof options.defaultValue === "string" ? options.defaultValue : ""} onChange={(e) => setOptions({ ...options, defaultValue: e.target.value || null })} />
          </Field>
        )}
        {type === "formula" && <FormulaEditor source={options.source ?? ""} setSource={(source) => setOptions({ ...options, source })} props={properties} selfId={property?.id ?? null} result={formula} />}
      </div>
    </Modal>
  );
};
