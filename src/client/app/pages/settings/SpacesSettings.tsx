import { useEffect, useState } from "react";
import type { Space } from "common/api-types";
import { api } from "../../api";
import { Link, navigate } from "../../router";
import { useApp } from "../../store";
import { Button, Field, Input, Modal, Spinner, errorMessage, useToast } from "../../components/ui";
import { SettingsSection } from "./SettingsPage";

const slugFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

export const CreateSpaceDialog = ({ onClose }: { onClose: () => void }) => {
  const { refreshSpaces } = useApp();
  const toast = useToast();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const effectiveSlug = slugTouched ? slug : slugFrom(name);
  const submit = async () => {
    setBusy(true);
    try {
      const { space } = await api.createSpace({ name: name.trim(), slug: effectiveSlug, description: description.trim() || undefined });
      await refreshSpaces();
      onClose();
      navigate(`/s/${space.slug}`);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Create space"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!name.trim() || effectiveSlug.length < 2}>
            Create
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} />
      </Field>
      <Field label="URL slug" hint={`Pages will live at /s/${effectiveSlug || "slug"}/…`}>
        <Input
          value={effectiveSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
          }}
          maxLength={50}
        />
      </Field>
      <Field label="Description">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </Field>
    </Modal>
  );
};

export const SpacesSettings = () => {
  const { isAdmin, spaces: mine } = useApp();
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    document.title = "Spaces";
    (isAdmin ? api.allSpaces() : Promise.resolve(mine)).then(setSpaces).catch(() => setSpaces(mine));
  }, [isAdmin, mine]);
  return (
    <SettingsSection title="Spaces" description={isAdmin ? "All spaces in the workspace." : "Spaces you are a member of."} actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New space</Button>}>
      {!spaces && <Spinner />}
      <div className="list">
        {spaces?.map((s) => (
          <Link key={s.id} to={`/s/${s.slug}/settings`} className="list-row clickable">
            {s.iconUrl ? <img src={s.iconUrl} alt="" className="space-icon" /> : <span className="space-icon">{s.name.slice(0, 1)}</span>}
            <div className="list-main">
              <div>{s.name}</div>
              <div className="muted small">
                /{s.slug} · {s.memberCount} {s.memberCount === 1 ? "member" : "members"}
                {!s.role && " · you are not a member"}
              </div>
            </div>
            {s.role && <span className="muted">{s.role}</span>}
          </Link>
        ))}
      </div>
      {creating && <CreateSpaceDialog onClose={() => setCreating(false)} />}
    </SettingsSection>
  );
};
