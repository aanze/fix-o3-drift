const manifest = {"name":"Odin 3 Stick Fix"};
const API_VERSION = 2;
const internalAPIConnection = window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit;
if (!internalAPIConnection) {
    throw new Error('[@decky/api]: Failed to connect to the loader as as the loader API was not initialized. This is likely a bug in Decky Loader.');
}
let api;
try {
    api = internalAPIConnection.connect(API_VERSION, manifest.name);
}
catch {
    api = internalAPIConnection.connect(1, manifest.name);
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version 1. Some features may not work.`);
}
if (api._version != API_VERSION) {
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version ${api._version}. Some features may not work.`);
}
const call = api.call;
const definePlugin = (fn) => {
    return (...args) => {
        return fn(...args);
    };
};

const getState = () => call("get_state");
const poll = () => call("poll");
const preview = (params) => call("preview", params);
const revert = () => call("revert");
const applyParams = (params) => call("apply_params", params);
const applyPreset = (id) => call("apply_preset", id);
const savePreset = (name, params) => call("save_preset", name, params);
const deletePreset = (id) => call("delete_preset", id);
const startTest = (seconds) => call("start_test", seconds);
const stopTest = () => call("stop_test");
const measureRest = (params) => call("measure_rest", params);

const LIMITS = {
    centerX: [-300, 300],
    centerY: [-300, 300],
    deadzone: [0, 300],
    left: [200, 1600],
    right: [200, 1600],
    up: [200, 1600],
    down: [200, 1600],
};
const MIRROR = { left: "right", right: "left", up: "down", down: "up" };
const AXES = {
    left: { x: "leftx", y: "lefty" },
    right: { x: "rightx", y: "righty" },
};
const num = (params, name, fallback) => Number.isFinite(params[name]) ? Number(params[name]) : fallback;
// Linux gamepad convention, kept by rsinput: negative X = left, negative Y = up (forward).
function stickFromParams(params, stick) {
    const { x, y } = AXES[stick];
    const edit = {
        centerX: num(params, `axis_${x}_center`, 0),
        centerY: num(params, `axis_${y}_center`, 0),
        deadzone: Math.max(num(params, `axis_${x}_deadzone`, 0), num(params, `axis_${y}_deadzone`, 0)),
        left: Math.abs(num(params, `axis_${x}_min`, -1408)),
        right: num(params, `axis_${x}_max`, 1408),
        up: Math.abs(num(params, `axis_${y}_min`, -1408)),
        down: num(params, `axis_${y}_max`, 1408),
        symmetric: true,
    };
    edit.symmetric = edit.left === edit.right && edit.up === edit.down;
    return edit;
}
function fromParams(params) {
    return { left: stickFromParams(params, "left"), right: stickFromParams(params, "right") };
}
function toParams(edit) {
    const params = {};
    for (const stick of ["left", "right"]) {
        const { x, y } = AXES[stick];
        const s = edit[stick];
        params[`axis_${x}_min`] = -s.left;
        params[`axis_${x}_max`] = s.right;
        params[`axis_${x}_center`] = s.centerX;
        params[`axis_${x}_deadzone`] = s.deadzone;
        params[`axis_${y}_min`] = -s.up;
        params[`axis_${y}_max`] = s.down;
        params[`axis_${y}_center`] = s.centerY;
        params[`axis_${y}_deadzone`] = s.deadzone;
    }
    return params;
}
function clamp(field, value) {
    const [low, high] = LIMITS[field];
    return Math.max(low, Math.min(high, Math.round(value)));
}
function setField(edit, stick, field, value) {
    const next = { ...edit[stick], [field]: clamp(field, value) };
    const mirror = MIRROR[field];
    if (next.symmetric && mirror)
        next[mirror] = next[field];
    return { ...edit, [stick]: next };
}
function setSymmetric(edit, stick, symmetric) {
    const s = { ...edit[stick], symmetric };
    if (symmetric) {
        // Fold onto the weaker side: the stronger side would never be fully reached otherwise.
        s.left = s.right = Math.min(s.left, s.right);
        s.up = s.down = Math.min(s.up, s.down);
    }
    return { ...edit, [stick]: s };
}
// Consumers (InputPlumber, SDL, Steam) take the rest position as (min+max)/2,
// so an asymmetric range moves it off zero by this fraction of the half-range.
function restShift(s) {
    const shift = (neg, pos) => (pos - neg) / (pos + neg);
    return { x: shift(s.left, s.right), y: shift(s.up, s.down) };
}
function normalize(reading) {
    if (!reading)
        return 0;
    const side = reading.value < 0 ? Math.abs(reading.min) : reading.max;
    return side ? reading.value / side : 0;
}
function emptyReach() {
    return { leftx: { neg: 0, pos: 0 }, lefty: { neg: 0, pos: 0 }, rightx: { neg: 0, pos: 0 }, righty: { neg: 0, pos: 0 } };
}
function trackReach(reach, axes) {
    const next = { ...reach };
    for (const axis of Object.keys(next)) {
        const n = normalize(axes[axis]);
        next[axis] = { neg: Math.max(next[axis].neg, -n), pos: Math.max(next[axis].pos, n) };
    }
    return next;
}
// Suggested center/deadzone from a rest measurement: center cancels the mean
// offset, deadzone covers the largest excursion at rest plus a margin.
function applyRest(edit, rest, margin = 20) {
    let next = edit;
    for (const stick of ["left", "right"]) {
        const { x, y } = AXES[stick];
        const rx = rest[x];
        const ry = rest[y];
        if (!rx || !ry)
            continue;
        const noise = Math.max(Math.abs(rx.max - rx.mean), Math.abs(rx.min - rx.mean), Math.abs(ry.max - ry.mean), Math.abs(ry.min - ry.mean));
        const s = { ...next[stick] };
        s.centerX = clamp("centerX", rx.center);
        s.centerY = clamp("centerY", ry.center);
        s.deadzone = clamp("deadzone", Math.max(s.deadzone, Math.ceil(noise) + margin));
        next = { ...next, [stick]: s };
    }
    return next;
}

const SIZE = 150;
const HALF = SIZE / 2;
const SCALE = 58; // px for a full deflection (|1.0|); leaves room for overshoot
const pct = (v) => `${Math.round(v * 100)}%`;
// Below 98 % the edge is not reached: the declared range on that side is too large.
const reachColor = (v) => (v === 0 ? "rgba(255,255,255,0.45)" : v < 0.98 ? "#ff9f43" : "#4cd964");
function StickPreview({ title, x, y, reachX, reachY, deadzone }) {
    const nx = normalize(x);
    const ny = normalize(y);
    const dot = (v) => HALF + Math.max(-1.2, Math.min(1.2, v)) * SCALE;
    // The driver zeroes |raw| < deadzone per axis: show it as a cross-shaped band.
    const bandX = x && x.max ? (deadzone / x.max) * SCALE : 0;
    const bandY = y && y.max ? (deadzone / y.max) * SCALE : 0;
    const label = { fontSize: "11px", fontWeight: 600 };
    return (SP_JSX.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", minWidth: 0 }, children: [SP_JSX.jsx("div", { style: { fontSize: "14px", fontWeight: 600, marginBottom: "4px" }, children: title }), SP_JSX.jsxs("div", { style: { position: "relative", width: `${SIZE}px`, height: `${SIZE + 28}px` }, children: [SP_JSX.jsxs("div", { style: { ...label, position: "absolute", top: 0, width: "100%", textAlign: "center", color: reachColor(reachY.neg) }, children: ["\u2191 ", pct(reachY.neg)] }), SP_JSX.jsxs("svg", { width: SIZE, height: SIZE, style: { position: "absolute", top: "14px", left: 0 }, children: [SP_JSX.jsx("rect", { x: HALF - SCALE, y: HALF - SCALE, width: SCALE * 2, height: SCALE * 2, fill: "rgba(255,255,255,0.05)", stroke: "rgba(255,255,255,0.3)" }), SP_JSX.jsx("circle", { cx: HALF, cy: HALF, r: SCALE, fill: "none", stroke: "rgba(255,255,255,0.35)", strokeDasharray: "4 3" }), SP_JSX.jsx("rect", { x: HALF - bandX, y: HALF - SCALE, width: bandX * 2, height: SCALE * 2, fill: "rgba(255,80,80,0.18)" }), SP_JSX.jsx("rect", { x: HALF - SCALE, y: HALF - bandY, width: SCALE * 2, height: bandY * 2, fill: "rgba(255,80,80,0.18)" }), SP_JSX.jsx("line", { x1: HALF, y1: HALF - SCALE, x2: HALF, y2: HALF + SCALE, stroke: "rgba(255,255,255,0.2)" }), SP_JSX.jsx("line", { x1: HALF - SCALE, y1: HALF, x2: HALF + SCALE, y2: HALF, stroke: "rgba(255,255,255,0.2)" }), SP_JSX.jsx("circle", { cx: dot(nx), cy: dot(ny), r: 7, fill: "#1a9fff", stroke: "#fff", strokeWidth: 2 })] }), SP_JSX.jsxs("div", { style: { ...label, position: "absolute", top: `${14 + HALF - 7}px`, left: "-34px", color: reachColor(reachX.neg) }, children: ["\u2190 ", pct(reachX.neg)] }), SP_JSX.jsxs("div", { style: { ...label, position: "absolute", top: `${14 + HALF - 7}px`, right: "-38px", color: reachColor(reachX.pos) }, children: [pct(reachX.pos), " \u2192"] }), SP_JSX.jsxs("div", { style: { ...label, position: "absolute", bottom: 0, width: "100%", textAlign: "center", color: reachColor(reachY.pos) }, children: ["\u2193 ", pct(reachY.pos)] })] }), SP_JSX.jsxs("div", { style: { fontSize: "12px", opacity: 0.8, marginTop: "4px", fontVariantNumeric: "tabular-nums" }, children: ["X ", pct(nx), " (", x?.value ?? "–", ") \u00B7 Y ", pct(ny), " (", y?.value ?? "–", ")"] })] }));
}

const TEST_SECONDS = 30;
const small = { minWidth: 0, width: "auto", padding: "2px 8px", height: "28px", lineHeight: "24px", fontSize: "13px" };
const ROWS = [
    { field: "centerX", label: "Centre X", steps: [1, 5] },
    { field: "centerY", label: "Centre Y", steps: [1, 5] },
    { field: "deadzone", label: "Zone morte", steps: [1, 5] },
    { field: "left", label: "Portée ←", steps: [5, 25] },
    { field: "right", label: "Portée →", steps: [5, 25] },
    { field: "up", label: "Portée ↑ (avant)", steps: [5, 25] },
    { field: "down", label: "Portée ↓ (arrière)", steps: [5, 25] },
];
function NumberRow({ label, value, steps, onChange }) {
    const [a, b] = steps;
    return (SP_JSX.jsxs(DFL.Focusable, { "flow-children": "horizontal", style: { display: "flex", alignItems: "center", gap: "4px", marginBottom: "4px" }, children: [SP_JSX.jsx("div", { style: { flex: 1, fontSize: "13px", whiteSpace: "nowrap" }, children: label }), SP_JSX.jsxs(DFL.DialogButton, { style: small, onClick: () => onChange(value - b), children: ["\u2212", b] }), SP_JSX.jsxs(DFL.DialogButton, { style: small, onClick: () => onChange(value - a), children: ["\u2212", a] }), SP_JSX.jsx("div", { style: { width: "48px", textAlign: "center", fontVariantNumeric: "tabular-nums", fontSize: "14px" }, children: value }), SP_JSX.jsxs(DFL.DialogButton, { style: small, onClick: () => onChange(value + a), children: ["+", a] }), SP_JSX.jsxs(DFL.DialogButton, { style: small, onClick: () => onChange(value + b), children: ["+", b] })] }));
}
function StickColumn({ stick, edit, onChange, onSymmetric }) {
    const s = edit[stick];
    const shift = restShift(s);
    const shifted = Math.abs(shift.x) > 0.005 || Math.abs(shift.y) > 0.005;
    return (SP_JSX.jsxs("div", { style: { minWidth: 0 }, children: [ROWS.map((row) => (SP_JSX.jsx(NumberRow, { label: row.label, value: s[row.field], steps: row.steps, onChange: (v) => onChange(stick, row.field, v) }, row.field))), SP_JSX.jsx(DFL.DialogButton, { style: { ...small, width: "100%", marginTop: "2px" }, onClick: () => onSymmetric(stick, !s.symmetric), children: s.symmetric ? "☑ Portées symétriques" : "☐ Portées symétriques" }), shifted && (SP_JSX.jsxs("div", { style: { fontSize: "11px", color: "#ff9f43", marginTop: "4px" }, children: ["Port\u00E9es asym\u00E9triques : Steam placera le repos \u00E0 X ", Math.round(shift.x * 100), " %, Y ", Math.round(shift.y * 100), " %."] }))] }));
}
function restText(rest) {
    const part = (label, axis) => {
        const r = rest[axis];
        return r ? `${label} ${r.mean > 0 ? "+" : ""}${r.mean} (±${r.noise})` : `${label} –`;
    };
    return `Repos brut — gauche : ${part("X", "leftx")}, ${part("Y", "lefty")} · droit : ${part("X", "rightx")}, ${part("Y", "righty")}`;
}
function NameModal({ closeModal, onSave }) {
    const [name, setName] = SP_REACT.useState("");
    return (SP_JSX.jsxs(DFL.ModalRoot, { onCancel: closeModal, children: [SP_JSX.jsxs(DFL.DialogBody, { children: [SP_JSX.jsx("div", { style: { marginBottom: "8px" }, children: "Nom du preset" }), SP_JSX.jsx(DFL.TextField, { value: name, onChange: (event) => setName(event.target.value) })] }), SP_JSX.jsx(DFL.DialogFooter, { children: SP_JSX.jsxs(DFL.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "8px" }, children: [SP_JSX.jsx(DFL.DialogButton, { onClick: () => { onSave(name); closeModal?.(); }, children: "Enregistrer" }), SP_JSX.jsx(DFL.DialogButton, { onClick: closeModal, children: "Annuler" })] }) })] }));
}
function EditorModal({ initial, closeModal, onDone }) {
    const [edit, setEdit] = SP_REACT.useState(() => fromParams(initial));
    const [reading, setReading] = SP_REACT.useState(null);
    const [reach, setReach] = SP_REACT.useState(emptyReach);
    const [rest, setRest] = SP_REACT.useState(null);
    const [busy, setBusy] = SP_REACT.useState("");
    const [message, setMessage] = SP_REACT.useState("");
    const dirty = SP_REACT.useRef(false);
    const applied = SP_REACT.useRef(false);
    // Live readout (~20 Hz). Each poll is also the heartbeat that keeps a test alive.
    SP_REACT.useEffect(() => {
        let cancelled = false;
        let inflight = false;
        const timer = window.setInterval(async () => {
            if (inflight)
                return;
            inflight = true;
            try {
                const next = await poll();
                if (cancelled)
                    return;
                setReading(next);
                if (next.axes)
                    setReach((r) => trackReach(r, next.axes));
            }
            catch {
                // keep the last reading
            }
            finally {
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
    SP_REACT.useEffect(() => {
        if (!dirty.current)
            return;
        const timer = window.setTimeout(() => {
            preview(toParams(edit)).catch((error) => setMessage(String(error)));
            setReach(emptyReach());
        }, 150);
        return () => window.clearTimeout(timer);
    }, [edit]);
    SP_REACT.useEffect(() => () => {
        stopTest().catch(() => { });
        if (!applied.current)
            revert().catch(() => { });
    }, []);
    const change = (next) => {
        dirty.current = true;
        setEdit(next);
    };
    const testing = !!reading?.testing;
    const toggleTest = async () => {
        try {
            if (testing)
                await stopTest();
            else {
                setReach(emptyReach());
                await startTest(TEST_SECONDS);
            }
        }
        catch (error) {
            setMessage(String(error));
        }
    };
    const doMeasure = async () => {
        setBusy("Mesure… ne touchez pas les sticks");
        try {
            setRest(await measureRest(toParams(edit)));
        }
        catch (error) {
            setMessage(String(error));
        }
        finally {
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
        }
        catch (error) {
            setMessage(String(error));
            setBusy("");
        }
    };
    const doSave = () => {
        DFL.showModal(SP_JSX.jsx(NameModal, { onSave: async (name) => {
                try {
                    await savePreset(name, toParams(edit));
                    setMessage(`Preset « ${name || "Preset perso"} » enregistré (pas encore appliqué).`);
                    onDone();
                }
                catch (error) {
                    setMessage(String(error));
                }
            } }));
    };
    const axes = reading?.axes ?? undefined;
    return (SP_JSX.jsxs(DFL.ModalRoot, { onCancel: closeModal, children: [SP_JSX.jsxs(DFL.DialogBody, { style: { overflowY: "auto" }, children: [testing && (SP_JSX.jsxs("div", { style: { background: "#1a9fff33", border: "1px solid #1a9fff", padding: "6px", marginBottom: "8px", fontSize: "13px", textAlign: "center" }, children: ["Test en cours : Steam ne re\u00E7oit plus la manette (", reading?.testRemaining ?? 0, " s). Bougez les sticks \u00E0 fond dans chaque direction. Touchez \u00AB Arr\u00EAter le test \u00BB pour reprendre la main plus t\u00F4t."] })), SP_JSX.jsx("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }, children: ["left", "right"].map((stick) => (SP_JSX.jsxs("div", { children: [SP_JSX.jsx(StickPreview, { title: stick === "left" ? "Stick gauche" : "Stick droit", x: axes?.[AXES[stick].x], y: axes?.[AXES[stick].y], reachX: reach[AXES[stick].x], reachY: reach[AXES[stick].y], deadzone: edit[stick].deadzone }), SP_JSX.jsx("div", { style: { marginTop: "8px" }, children: SP_JSX.jsx(StickColumn, { stick: stick, edit: edit, onChange: (st, field, value) => change(setField(edit, st, field, value)), onSymmetric: (st, on) => change(setSymmetric(edit, st, on)) }) })] }, stick))) }), SP_JSX.jsx("div", { style: { fontSize: "12px", opacity: 0.75, marginTop: "8px" }, children: "Les % autour de chaque carr\u00E9 = d\u00E9viation maximale atteinte depuis le dernier changement. Orange (< 98 %) : le bord n'est pas atteint, r\u00E9duisez la port\u00E9e de ce c\u00F4t\u00E9. Bande rouge : zone morte. Point au repos hors du centre : corrigez Centre X / Y." }), rest && (SP_JSX.jsxs("div", { style: { fontSize: "12px", marginTop: "6px" }, children: [restText(rest), SP_JSX.jsx(DFL.DialogButton, { style: { ...small, marginLeft: "8px", display: "inline-block" }, onClick: () => change(applyRest(edit, rest)), children: "Utiliser comme centre + zone morte" })] })), (busy || message) && SP_JSX.jsx("div", { style: { fontSize: "12px", marginTop: "6px", color: busy ? undefined : "#ff9f43" }, children: busy || message })] }), SP_JSX.jsx(DFL.DialogFooter, { children: SP_JSX.jsxs(DFL.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "8px", flexWrap: "wrap" }, children: [SP_JSX.jsx(DFL.DialogButton, { style: { flex: 1 }, onClick: toggleTest, disabled: !!busy, children: testing ? "Arrêter le test" : `Tester (${TEST_SECONDS} s)` }), SP_JSX.jsx(DFL.DialogButton, { style: { flex: 1 }, onClick: doMeasure, disabled: !!busy || testing, children: "Mesurer le repos" }), SP_JSX.jsx(DFL.DialogButton, { style: { flex: 1 }, onClick: () => setReach(emptyReach()), children: "Remettre les % \u00E0 z\u00E9ro" }), SP_JSX.jsx(DFL.DialogButton, { style: { flex: 1 }, onClick: doSave, disabled: !!busy, children: "Enregistrer en preset" }), SP_JSX.jsx(DFL.DialogButton, { style: { flex: 1 }, onClick: doApply, disabled: !!busy, children: "Appliquer" }), SP_JSX.jsx(DFL.DialogButton, { style: { flex: 1 }, onClick: closeModal, children: "Fermer" })] }) })] }));
}
function openEditor(initial, onDone) {
    DFL.showModal(SP_JSX.jsx(EditorModal, { initial: initial, onDone: onDone }));
}

const summary = (p) => p ? `G ←${-p.axis_leftx_min} →${p.axis_leftx_max} ↑${-p.axis_lefty_min} ↓${p.axis_lefty_max} · D ←${-p.axis_rightx_min} →${p.axis_rightx_max} ↑${-p.axis_righty_min} ↓${p.axis_righty_max} · ZM ${p.axis_leftx_deadzone}/${p.axis_rightx_deadzone}` : "aucune";
function Content() {
    const [state, setState] = SP_REACT.useState(null);
    const [selected, setSelected] = SP_REACT.useState("aanze-odin3");
    const [busy, setBusy] = SP_REACT.useState(false);
    const [error, setError] = SP_REACT.useState("");
    const refresh = () => getState().then(setState).catch((e) => setError(String(e)));
    SP_REACT.useEffect(() => {
        refresh();
    }, []);
    const run = async (action) => {
        setBusy(true);
        setError("");
        try {
            setState(await action());
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            setBusy(false);
        }
    };
    if (!state)
        return SP_JSX.jsx(DFL.PanelSection, { children: SP_JSX.jsx(DFL.PanelSectionRow, { children: error || "Chargement…" }) });
    const preset = state.presets.find((p) => p.id === selected);
    const active = state.presets.find((p) => p.id === state.active);
    const ready = state.moduleLoaded && state.deviceFound;
    return (SP_JSX.jsxs(SP_JSX.Fragment, { children: [SP_JSX.jsxs(DFL.PanelSection, { title: "\u00C9tat", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.Field, { label: "Manette", childrenLayout: "below", children: ready ? "rsinput détectée" : "rsinput introuvable" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs(DFL.Field, { label: "Calibration active", childrenLayout: "below", children: [active ? active.name : state.stored ? "personnalisée / externe" : "défauts du driver", SP_JSX.jsx("div", { style: { fontSize: "11px", opacity: 0.7 }, children: summary(state.stored ?? state.live) })] }) }), !state.armada && (SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { fontSize: "12px", color: "#ff9f43" }, children: "Armada OS non d\u00E9tect\u00E9 : les r\u00E9glages ne seront pas r\u00E9appliqu\u00E9s au d\u00E9marrage." }) }))] }), SP_JSX.jsxs(DFL.PanelSection, { title: "Presets", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.Dropdown, { rgOptions: state.presets.map((p) => ({ data: p.id, label: p.builtin ? p.name : `★ ${p.name}` })), selectedOption: selected, onChange: (o) => setSelected(o.data) }) }), preset && (SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { fontSize: "11px", opacity: 0.7 }, children: summary(preset.params) }) })), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy || !preset || !ready, onClick: () => run(() => applyPreset(selected)), children: "Appliquer ce preset" }) }), preset && !preset.builtin && (SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy, onClick: () => run(() => deletePreset(selected)).then(() => setSelected("aanze-odin3")), children: "Supprimer ce preset" }) }))] }), SP_JSX.jsxs(DFL.PanelSection, { title: "R\u00E9glage anti-drift", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy || !ready, onClick: () => openEditor({ ...state.live, ...(state.stored ?? {}) }, refresh), children: "Ouvrir l'\u00E9diteur" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy || !preset || !ready, onClick: () => preset && openEditor(preset.params, refresh), children: "\u00C9diter \u00E0 partir du preset choisi" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { fontSize: "11px", opacity: 0.7 }, children: "Ne relancez pas la calibration d'Armada Control ensuite : elle remplace ces valeurs." }) })] }), error && (SP_JSX.jsx(DFL.PanelSection, { children: SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { fontSize: "12px", color: "#ff6b6b" }, children: error }) }) }))] }));
}

var index = definePlugin(() => ({
    name: "Odin 3 Stick Fix",
    content: SP_JSX.jsx(Content, {}),
    icon: (SP_JSX.jsxs("svg", { xmlns: "http://www.w3.org/2000/svg", width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", children: [SP_JSX.jsx("circle", { cx: "12", cy: "12", r: "9" }), SP_JSX.jsx("circle", { cx: "12", cy: "12", r: "3" }), SP_JSX.jsx("path", { d: "M12 3v3M12 18v3M3 12h3M18 12h3" })] })),
}));

export { index as default };
//# sourceMappingURL=index.js.map
