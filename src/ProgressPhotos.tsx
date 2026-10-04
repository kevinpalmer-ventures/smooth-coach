import { useState, type ChangeEvent, type FormEvent } from "react";
import type { AccountUser, ProgressPhoto } from "./types";

type ProgressPhotosProps = {
  user: AccountUser | null;
  loading: boolean;
  photos: ProgressPhoto[];
  onLogin: () => void;
  onUpload: (input: { file: File; capturedAt: string; caption: string }) => Promise<void>;
};

const acceptedTypes = ["image/jpeg", "image/png", "image/webp"];
const maxBytes = 8 * 1024 * 1024;
const today = () => new Date().toISOString().slice(0, 10);

export default function ProgressPhotos({ user, loading, photos, onLogin, onUpload }: ProgressPhotosProps) {
  const [file, setFile] = useState<File | null>(null);
  const [capturedAt, setCapturedAt] = useState(today());
  const [caption, setCaption] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    if (!selected) return;
    if (!acceptedTypes.includes(selected.type) || selected.size > maxBytes) {
      setFile(null);
      setMessage("Choose a JPEG, PNG, or WebP image smaller than 8 MB.");
      event.target.value = "";
      return;
    }
    setFile(selected);
    setMessage("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) { setMessage("Choose a picture before saving your timeline moment."); return; }
    setSaving(true);
    setMessage("");
    try {
      await onUpload({ file, capturedAt, caption: caption.trim() });
      setFile(null);
      setCaption("");
      setMessage("Picture added privately to your timeline.");
      const input = document.getElementById("progress-photo-file") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to add this picture right now.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <section className="photo-card photo-loading"><p className="eyebrow">Private photo timeline</p><h3>Loading your picture moments…</h3></section>;
  if (!user) return <section className="photo-card photo-locked"><div><p className="eyebrow">Private photo timeline</p><h3>Add a visual check-in when you’re ready.</h3><p>Sign in to keep dated progression pictures and captions visible only to your own account.</p></div><button onClick={onLogin}>Sign in to add pictures <span>→</span></button></section>;

  return <section className="photo-card" aria-labelledby="photo-timeline-title">
    <div className="photo-card-heading"><div><p className="eyebrow">Private photo timeline</p><h3 id="photo-timeline-title">Your visual progression</h3><p>Optional moments alongside your weight graph. JPEG, PNG, or WebP up to 8 MB.</p></div><span className="private-badge">⌁ private</span></div>
    <form className="photo-form" onSubmit={(event) => void submit(event)}>
      <label className="file-picker" htmlFor="progress-photo-file"><span>+</span><b>{file ? file.name : "Choose a picture"}</b><small>Browse files</small></label>
      <input id="progress-photo-file" type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseFile} hidden />
      <label><span>Date</span><input type="date" value={capturedAt} max={today()} onChange={(event) => setCapturedAt(event.target.value)} required /></label>
      <label className="caption-field"><span>Caption (optional)</span><input value={caption} maxLength={160} onChange={(event) => setCaption(event.target.value)} placeholder="A small note for this moment" /></label>
      <button type="submit" disabled={saving}>{saving ? "Adding picture…" : "Add to timeline"}</button>
      {message && <p className="photo-message" role="status">{message}</p>}
    </form>
    {photos.length ? <div className="photo-gallery">{photos.map((photo) => <figure key={photo.id}><img src={photo.imageUrl} alt={photo.caption ? `Progress photo from ${photo.capturedAt}: ${photo.caption}` : `Progress photo from ${photo.capturedAt}`} /><figcaption><b>{photo.capturedAt}</b>{photo.caption && <span>{photo.caption}</span>}</figcaption></figure>)}</div> : <div className="photo-empty"><span>◫</span><p>Your first picture will create a private visual timeline here.</p></div>}
  </section>;
}
