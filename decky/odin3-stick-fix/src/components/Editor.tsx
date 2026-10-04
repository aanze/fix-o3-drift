import { DialogBody, DialogButton, DialogFooter, Focusable, ModalRoot, TextField, showModal } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { applyParams, measureRest, poll, preview, revert, savePreset, startTest, stopTest } from "../backend";
import type { Field, EditState, StickKey } from "../lib/model";
import { AXES, applyRest, emptyReach, fromParams, restShift, setField, setSymmetric, toParams, trackReach } from "../lib/model";
import type { Params, PollResult, RestStats } from "../types";
import { StickPreview } from "./StickPreview";

const TEST_SECONDS = 30;

const small = { minWidth: 0, width: "auto", padding: "2px 8px", height: "28px", lineHeight: "24px", fontSize: "13px" } as const;

const ROWS: { field: Field; label: string; steps: [number, number] }[] = [
  { field: "centerX", label: "Centre X", steps: [1, 5] },
  { field: "centerY", label: "Centre Y", steps: [1, 5] },
  { field: "deadzone", label: "Zone morte", steps: [1, 5] },
  { field: "left", label: "Portée ←", steps: [5, 25] },
  { field: "right", label: "Portée →", steps: [5, 25] },
  { field: "up", label: "Portée ↑ (avant)", steps: [5, 25] },
  { field: "down", label: "Portée ↓ (arrière)", steps: [5, 25] },
];

function NumberRow({ label, value, steps, onChange }: { label: string; value: number; steps: [number, number]; onChange: (v: number) => void }) {
  const [a, b] = steps;
  return (
    <Focusable flow-children="horizontal" style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "4px" }}>
      <div style={{ flex: 1, fontSize: "13px", whiteSpace: "nowrap" }}>{label}</div>
      <DialogButton style={small} onClick={() => onChange(value - b)}>−{b}</DialogButton>
      <DialogButton style={small} onClick={() => onChange(value - a)}>−{a}</DialogButton>
      <div style={{ width: "48px", textAlign: "center", fontVariantNumeric: "tabular-nums", fontSize: "14px" }}>{value}</div>
      <DialogButton style={small} onClick={() => onChange(value + a)}>+{a}</DialogButton>
      <DialogButton style={small} onClick={() => onChange(value + b)}>+{b}</DialogButton>
    </Focusable>
  );
}

function StickColumn({ stick, edit, onChange, onSymmetric }: {
  stick: StickKey;
  edit: EditState;
  onChange: (stick: StickKey, field: Field, value: number) => void;
  onSymmetric: (stick: StickKey, on: boolean) => void;
}) {
  const s = edit[stick];
  const shift = restShift(s);
  const shifted = Math.abs(shift.x) > 0.005 || Math.abs(shift.y) > 0.005;
  return (
    <div style={{ minWidth: 0 }}>
      {ROWS.map((row) => (
        <NumberRow key={row.field} label={row.label} value={s[row.field]} steps={row.steps} onChange={(v) => onChange(stick, row.field, v)} />
      ))}
      <DialogButton style={{ ...small, width: "100%", marginTop: "2px" }} onClick={() => onSymmetric(stick, !s.symmetric)}>
        {s.symmetric ? "☑ Portées symétriques" : "☐ Portées symétriques"}
      </DialogButton>
      {shifted && (
        <div style={{ fontSize: "11px", color: "#ff9f43", marginTop: "4px" }}>
          Portées asymétriques : Steam placera le repos à X {Math.round(shift.x * 100)} %, Y {Math.round(shift.y * 100)} %.
        </div>
      )}
    </div>
  );
}

function restText(rest: RestStats): string {
  const part = (label: string, axis: keyof RestStats) => {
    const r = rest[axis];
    return r ? `${label} ${r.mean > 0 ? "+" : ""}${r.mean} (±${r.noise})` : `${label} –`;
  };
  return `Repos brut — gauche : ${part("X", "leftx")}, ${part("Y", "lefty")} · droit : ${part("X", "rightx")}, ${part("Y", "righty")}`;
}

function NameModal({ closeModal, onSave }: { closeModal?: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <ModalRoot onCancel={closeModal}>
      <DialogBody>
        <div style={{ marginBottom: "8px" }}>Nom du preset</div>
        <TextField value={name} onChange={(event) => setName(event.target.value)} />
      </DialogBody>
      <DialogFooter>
        <Focusable flow-children="horizontal" style={{ display: "flex", gap: "8px" }}>
          <DialogButton onClick={() => { onSave(name); closeModal?.(); }}>Enregistrer</DialogButton>
          <DialogButton onClick={closeModal}>Annuler</DialogButton>
        </Focusable>
      </DialogFooter>
    </ModalRoot>
  );
}

function EditorModal({ initial, closeModal, onDone }: { initial: Params; closeModal?: () => void; onDone: () => void }) {
  const [edit, setEdit] = useState<EditState>(() => fromParams(initial));
  const [reading, setReading] = useState<PollResult | null>(null);
  const [reach, setReach] = useState(emptyReach);
  const [rest, setRest] = useState<RestStats | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const dirty = useRef(false);
  const applied = useRef(false);

  // Live readout (~20 Hz). Each poll is also the heartbeat that keeps a test alive.
  useEffect(() => {
    let cancelled = false;
    let inflight = false;
    const timer = window.setInterval(async () => {
      if (inflight) return;
      inflight = true;
      try {
        const next = await poll();
        if (cancelled) return;
        setReading(next);
        if (next.axes) setReach((r) => trackReach(r, next.axes!));
      } catch {
        // keep the last reading
      } finally {
        inflight = false;
      }
    }, 50);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Every edit goes to the driver at once (debounced), so the preview shows
  // exactly what the new values produce. Nothing is saved until "Appliquer".
  useEffect(() => {
    if (!dirty.current) return;
    const timer = window.setTimeout(() => {
      preview(toParams(edit)).catch((error) => setMessage(String(error)));
      setReach(emptyReach());
    }, 150);
    return () => window.clearTimeout(timer);
  }, [edit]);

  useEffect(() => () => {
    stopTest().catch(() => {});
    if (!applied.current) revert().catch(() => {});
  }, []);

  const change = (next: EditState) => {
    dirty.current = true;
    setEdit(next);
  };

  const testing = !!reading?.testing;
  const toggleTest = async () => {
    try {
      if (testing) await stopTest();
      else {
        setReach(emptyReach());
        await startTest(TEST_SECONDS);
      }
    } catch (error) {
      setMessage(String(error));
    }
  };

  const doMeasure = async () => {
    setBusy("Mesure… ne touchez pas les sticks");
    try {
      setRest(await measureRest(toParams(edit)));
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy("");
    }
  };

  const doApply = async () => {
    setBusy("Application…");
    try {
      await applyParams(toParams(edit));
      applied.current = true;
      onDone();
      closeModal?.();
    } catch (error) {
      setMessage(String(error));
      setBusy("");
    }
  };

  const doSave = () => {
    showModal(
      <NameModal
        onSave={async (name) => {
          try {
            await savePreset(name, toParams(edit));
            setMessage(`Preset « ${name || "Preset perso"} » enregistré (pas encore appliqué).`);
            onDone();
          } catch (error) {
            setMessage(String(error));
          }
        }}
      />,
    );
  };

  const axes = reading?.axes ?? undefined;
  return (
    <ModalRoot onCancel={closeModal}>
      <DialogBody style={{ overflowY: "auto" }}>
        {testing && (
          <div style={{ background: "#1a9fff33", border: "1px solid #1a9fff", padding: "6px", marginBottom: "8px", fontSize: "13px", textAlign: "center" }}>
            Test en cours : Steam ne reçoit plus la manette ({reading?.testRemaining ?? 0} s). Bougez les sticks à fond dans chaque direction.
            Touchez « Arrêter le test » pour reprendre la main plus tôt.
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
          {(["left", "right"] as StickKey[]).map((stick) => (
            <div key={stick}>
              <StickPreview
                title={stick === "left" ? "Stick gauche" : "Stick droit"}
                x={axes?.[AXES[stick].x]}
                y={axes?.[AXES[stick].y]}
                reachX={reach[AXES[stick].x]}
                reachY={reach[AXES[stick].y]}
                deadzone={edit[stick].deadzone}
              />
              <div style={{ marginTop: "8px" }}>
                <StickColumn
                  stick={stick}
                  edit={edit}
                  onChange={(st, field, value) => change(setField(edit, st, field, value))}
                  onSymmetric={(st, on) => change(setSymmetric(edit, st, on))}
                />
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: "12px", opacity: 0.75, marginTop: "8px" }}>
          Les % autour de chaque carré = déviation maximale atteinte depuis le dernier changement. Orange (&lt; 98 %) : le bord n'est pas
          atteint, réduisez la portée de ce côté. Bande rouge : zone morte. Point au repos hors du centre : corrigez Centre X / Y.
        </div>
        {rest && (
          <div style={{ fontSize: "12px", marginTop: "6px" }}>
            {restText(rest)}
            <DialogButton style={{ ...small, marginLeft: "8px", display: "inline-block" }} onClick={() => change(applyRest(edit, rest))}>
              Utiliser comme centre + zone morte
            </DialogButton>
          </div>
        )}
        {(busy || message) && <div style={{ fontSize: "12px", marginTop: "6px", color: busy ? undefined : "#ff9f43" }}>{busy || message}</div>}
      </DialogBody>
      <DialogFooter>
        <Focusable flow-children="horizontal" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <DialogButton style={{ flex: 1 }} onClick={toggleTest} disabled={!!busy}>{testing ? "Arrêter le test" : `Tester (${TEST_SECONDS} s)`}</DialogButton>
          <DialogButton style={{ flex: 1 }} onClick={doMeasure} disabled={!!busy || testing}>Mesurer le repos</DialogButton>
          <DialogButton style={{ flex: 1 }} onClick={() => setReach(emptyReach())}>Remettre les % à zéro</DialogButton>
          <DialogButton style={{ flex: 1 }} onClick={doSave} disabled={!!busy}>Enregistrer en preset</DialogButton>
          <DialogButton style={{ flex: 1 }} onClick={doApply} disabled={!!busy}>Appliquer</DialogButton>
          <DialogButton style={{ flex: 1 }} onClick={closeModal}>Fermer</DialogButton>
        </Focusable>
      </DialogFooter>
    </ModalRoot>
  );
}

export function openEditor(initial: Params, onDone: () => void) {
  showModal(<EditorModal initial={initial} onDone={onDone} />);
}
