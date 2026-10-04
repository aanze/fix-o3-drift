import { ButtonItem, Dropdown, Field, PanelSection, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";
import { applyPreset, deletePreset, getState } from "./backend";
import { openEditor } from "./components/Editor";
import type { Params, PluginState } from "./types";

const summary = (p: Params | null | undefined) =>
  p ? `G ←${-p.axis_leftx_min} →${p.axis_leftx_max} ↑${-p.axis_lefty_min} ↓${p.axis_lefty_max} · D ←${-p.axis_rightx_min} →${p.axis_rightx_max} ↑${-p.axis_righty_min} ↓${p.axis_righty_max} · ZM ${p.axis_leftx_deadzone}/${p.axis_rightx_deadzone}` : "aucune";

export function Content() {
  const [state, setState] = useState<PluginState | null>(null);
  const [selected, setSelected] = useState<string>("aanze-odin3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = () => getState().then(setState).catch((e) => setError(String(e)));
  useEffect(() => {
    refresh();
  }, []);

  const run = async (action: () => Promise<PluginState>) => {
    setBusy(true);
    setError("");
    try {
      setState(await action());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <PanelSection><PanelSectionRow>{error || "Chargement…"}</PanelSectionRow></PanelSection>;

  const preset = state.presets.find((p) => p.id === selected);
  const active = state.presets.find((p) => p.id === state.active);
  const ready = state.moduleLoaded && state.deviceFound;

  return (
    <>
      <PanelSection title="État">
        <PanelSectionRow>
          <Field label="Manette" childrenLayout="below">{ready ? "rsinput détectée" : "rsinput introuvable"}</Field>
        </PanelSectionRow>
        <PanelSectionRow>
          <Field label="Calibration active" childrenLayout="below">
            {active ? active.name : state.stored ? "personnalisée / externe" : "défauts du driver"}
            <div style={{ fontSize: "11px", opacity: 0.7 }}>{summary(state.stored ?? state.live)}</div>
          </Field>
        </PanelSectionRow>
        {!state.armada && (
          <PanelSectionRow>
            <div style={{ fontSize: "12px", color: "#ff9f43" }}>Armada OS non détecté : les réglages ne seront pas réappliqués au démarrage.</div>
          </PanelSectionRow>
        )}
      </PanelSection>
      <PanelSection title="Presets">
        <PanelSectionRow>
          <Dropdown
            rgOptions={state.presets.map((p) => ({ data: p.id, label: p.builtin ? p.name : `★ ${p.name}` }))}
            selectedOption={selected}
            onChange={(o) => setSelected(o.data)}
          />
        </PanelSectionRow>
        {preset && (
          <PanelSectionRow>
            <div style={{ fontSize: "11px", opacity: 0.7 }}>{summary(preset.params)}</div>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy || !preset || !ready} onClick={() => run(() => applyPreset(selected))}>
            Appliquer ce preset
          </ButtonItem>
        </PanelSectionRow>
        {preset && !preset.builtin && (
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => run(() => deletePreset(selected)).then(() => setSelected("aanze-odin3"))}>
              Supprimer ce preset
            </ButtonItem>
          </PanelSectionRow>
        )}
      </PanelSection>
      <PanelSection title="Réglage anti-drift">
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy || !ready} onClick={() => openEditor({ ...state.live, ...(state.stored ?? {}) }, refresh)}>
            Ouvrir l'éditeur
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy || !preset || !ready} onClick={() => preset && openEditor(preset.params, refresh)}>
            Éditer à partir du preset choisi
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ fontSize: "11px", opacity: 0.7 }}>
            Ne relancez pas la calibration d'Armada Control ensuite : elle remplace ces valeurs.
          </div>
        </PanelSectionRow>
      </PanelSection>
      {error && (
        <PanelSection>
          <PanelSectionRow>
            <div style={{ fontSize: "12px", color: "#ff6b6b" }}>{error}</div>
          </PanelSectionRow>
        </PanelSection>
      )}
    </>
  );
}
