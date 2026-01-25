import React, { useEffect, useMemo, useState } from "react";
import { Power, RefreshCcw, Lightbulb, Settings2, Loader2 } from "lucide-react";


// Mobile-first, black & red palette with white text (TailwindCSS expected in host app)
// This component is wired directly to your Yeelight REST API.
// API endpoints expected (relative to API base):
//   GET  /bulbs      -> mapping name -> { ip, id }
//   GET  /groups     -> mapping group -> [names]
//   GET  /state      -> mapping name -> { power, bright, ct, rgb, ... }
//   POST /power/:target/:on|off
//   POST /bright/:target?level=NN
//   POST /ct/:target?k=1700..6500
//   POST /rgb/:target?r=0..255&g=0..255&b=0..255
//   POST /toggle/:target
//   POST /scene/:name (optional)
//   GET  /presence   -> { config, status }
//   POST /presence   -> update presence config
//   GET  /routines   -> { config, status }
//   POST /routines   -> update routine config
//   POST /routine/:name/start

// If your Express proxy serves API at http://pi:5005/api, set base to that.
// You can also leave it as just "http://pi:5005" — the join() helper below will DTRT.
const DEFAULT_BASE = "http://192.168.0.7:5005/api";

// --- fetch helpers ---------------------------------------------------------
function join(base, path) {
  if (!base) return path;
  if (base.endsWith("/") && path.startsWith("/")) return base + path.slice(1);
  return base + path;
}

async function jpost(base, path) {
  const url = join(base, path);
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json().catch(() => ({}));
}

async function jpostJson(base, path, data) {
  const url = join(base, path);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data || {})
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json().catch(() => ({}));
}

async function jget(base, path) {
  const url = join(base, path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const rgbFromValue = (value) => {
  if (Array.isArray(value) && value.length === 3) {
    return value.map((v) => clamp(Number(v) || 0, 0, 255));
  }
  const intVal = toNumber(value);
  if (intVal === undefined) return undefined;
  return [(intVal >> 16) & 255, (intVal >> 8) & 255, intVal & 255];
};

const normalizeState = (state) => {
  if (!state) return {};
  return {
    bright: toNumber(state.bright),
    ct: toNumber(state.ct),
    rgb: rgbFromValue(state.rgb),
  };
};

const formatTimestamp = (ts) => {
  if (!ts) return "—";
  const date = new Date(ts * 1000);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

const COLOR_SWATCHES = [
  "#ff3200", "#ff4600", "#ff5a00", "#ff7000", "#ff8c1a", "#ffb347",
  "#ffd166", "#ffe4b5", "#ff0000", "#ff2d2d", "#ff6b6b", "#ff9b9b",
  "#f97316", "#fb923c", "#fdba74", "#fed7aa", "#f59e0b", "#d97706",
  "#b45309", "#92400e", "#ffffff", "#f3f4f6", "#e5e7eb", "#d1d5db",
];

const hexToRgb = (hex) => {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return [255, 255, 255];
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
};

const ctToRgb = (ct) => {
  const min = 1700;
  const max = 6500;
  const t = clamp((ct - min) / (max - min), 0, 1);
  const warm = [255, 90, 0];
  const cool = [225, 242, 255];
  return warm.map((w, i) => Math.round(w + (cool[i] - w) * t));
};

const rgbToHex = (rgb) => {
  if (!Array.isArray(rgb) || rgb.length !== 3) return "#ffffff";
  return `#${rgb.map((v) => clamp(v, 0, 255).toString(16).padStart(2, "0")).join("")}`;
};

// --- UI primitives ---------------------------------------------------------
function Section({ title, right, children }) {
  return (
    <section className="my-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-white/90">{title}</h2>
        <div className="text-sm">{right}</div>
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function Card({ children }) {
  return (
    <div className="rounded-2xl bg-zinc-900/70 border border-red-700/30 shadow-lg p-4">
      {children}
    </div>
  );
}

function Slider({ min, max, step = 1, value, onChange, label }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-24 text-sm text-white/70">{label}</div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-red-600"
      />
      <div className="w-12 text-right text-white/70 text-sm">{value}</div>
    </div>
  );
}

function ColorRow({ rgb, onChange }) {
  const [r, g, b] = rgb;
  const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="w-24 text-sm text-white/70">Color</div>
        <div className="flex items-center gap-2 ml-auto text-xs text-white/60">
          <span className="px-2 py-0.5 rounded-full bg-red-700/20 border border-red-600/40 text-red-300 text-xs">
            {hex.toUpperCase()}
          </span>
          <span className="h-4 w-4 rounded-full border border-zinc-700" style={{ backgroundColor: hex }} />
        </div>
      </div>
      <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
        {COLOR_SWATCHES.map((swatch) => {
          const selected = swatch.toLowerCase() === hex.toLowerCase();
          return (
            <button
              key={swatch}
              type="button"
              onClick={() => onChange(hexToRgb(swatch))}
              className={`h-9 w-full rounded-lg border ${selected ? "border-red-400 ring-2 ring-red-500/50" : "border-zinc-700"} active:scale-[.98]`}
              style={{ backgroundColor: swatch }}
              aria-label={`Set color ${swatch}`}
            />
          );
        })}
      </div>
    </div>
  );
}

function Button({ onClick, children, variant = "solid", active = false, disabled, className = "" }) {
  const base =
    "px-3 py-2 rounded-xl text-sm font-medium transition active:scale-[.98] disabled:opacity-50";
  let styles;
  if (variant === "solid") {
    styles = active ? "bg-red-600 hover:bg-red-500 text-white" : "bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700";
  } else {
    styles = "bg-transparent text-white/80 hover:text-white";
  }
  return (
    <button onClick={onClick} className={`${base} ${styles} ${className}`} disabled={disabled}>
      {children}
    </button>
  );
}

// --- API hook --------------------------------------------------------------
function useApi(baseUrl) {
  const [bulbs, setBulbs] = useState({});
  const [groups, setGroups] = useState({});
  const [states, setStates] = useState({}); // name -> { power, bright, ct, rgb, ... }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [presence, setPresence] = useState(null);
  const [presenceStatus, setPresenceStatus] = useState(null);
  const [presenceLoading, setPresenceLoading] = useState(false);
  const [presenceError, setPresenceError] = useState("");
  const [routines, setRoutines] = useState(null);
  const [routinesStatus, setRoutinesStatus] = useState(null);
  const [routinesLoading, setRoutinesLoading] = useState(false);
  const [routinesError, setRoutinesError] = useState("");

  const reload = async () => {
    setLoading(true);
    setError("");
    try {
      const [b, g, s] = await Promise.all([
        jget(baseUrl, "/bulbs"),
        jget(baseUrl, "/groups"),
        jget(baseUrl, "/state"),
      ]);
      setBulbs(b || {});
      setGroups(g || {});
      setStates(s || {});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    const t = setInterval(reload, 10000); // light polling
    return () => clearInterval(t);
  }, [baseUrl]);

  const loadPresence = async () => {
    setPresenceLoading(true);
    setPresenceError("");
    try {
      const data = await jget(baseUrl, "/presence");
      setPresence(data?.config || null);
      setPresenceStatus(data?.status || null);
    } catch (e) {
      setPresenceError(String(e));
    } finally {
      setPresenceLoading(false);
    }
  };

  const savePresence = async (next) => {
    setPresenceLoading(true);
    setPresenceError("");
    try {
      const res = await jpostJson(baseUrl, "/presence", next);
      if (res?.config) {
        setPresence(res.config);
      }
      return res;
    } catch (e) {
      setPresenceError(String(e));
      throw e;
    } finally {
      setPresenceLoading(false);
    }
  };

  useEffect(() => {
    loadPresence();
  }, [baseUrl]);

  const loadRoutines = async () => {
    setRoutinesLoading(true);
    setRoutinesError("");
    try {
      const data = await jget(baseUrl, "/routines");
      setRoutines(data?.config || null);
      setRoutinesStatus(data?.status || null);
    } catch (e) {
      setRoutinesError(String(e));
    } finally {
      setRoutinesLoading(false);
    }
  };

  const saveRoutines = async (next) => {
    setRoutinesLoading(true);
    setRoutinesError("");
    try {
      const res = await jpostJson(baseUrl, "/routines", next);
      if (res?.config) {
        setRoutines(res.config);
      }
      return res;
    } catch (e) {
      setRoutinesError(String(e));
      throw e;
    } finally {
      setRoutinesLoading(false);
    }
  };

  const runRoutine = (name, target) => {
    const qp = target ? `?target=${encodeURIComponent(target)}` : "";
    return jpost(baseUrl, `/routine/${encodeURIComponent(name)}/start${qp}`);
  };

  useEffect(() => {
    loadRoutines();
  }, [baseUrl]);

  const api = {
    power: (target, on) => jpost(baseUrl, `/power/${encodeURIComponent(target)}/${on ? "on" : "off"}`),
    toggle: (target) => jpost(baseUrl, `/toggle/${encodeURIComponent(target)}`),
    bright: (target, level) => jpost(baseUrl, `/bright/${encodeURIComponent(target)}?level=${level}`),
    ct: (target, k) => jpost(baseUrl, `/ct/${encodeURIComponent(target)}?k=${k}`),
    rgb: (target, r, g, b) => jpost(baseUrl, `/rgb/${encodeURIComponent(target)}?r=${r}&g=${g}&b=${b}`),
    scene: (name) => jpost(baseUrl, `/scene/${encodeURIComponent(name)}`),
  };

  return {
    bulbs,
    groups,
    states,
    loading,
    error,
    reload,
    api,
    presence,
    presenceStatus,
    presenceLoading,
    presenceError,
    loadPresence,
    savePresence,
    routines,
    routinesStatus,
    routinesLoading,
    routinesError,
    loadRoutines,
    saveRoutines,
    runRoutine,
  };
}

// --- Card ------------------------------------------------------------------
function TargetCard({ title, target, onPower, onToggle, onBright, onCT, onRGB, currentOn, currentState, quickRoutines, onRunRoutine, routinesStatus }) {
  const [level, setLevel] = useState(50);
  const [ct, setCt] = useState(4000);
  const [rgb, setRgb] = useState([255, 120, 30]);
  const [busy, setBusy] = useState(false);
  const [isOn, setIsOn] = useState(currentOn ?? false);

  useEffect(() => { if (currentOn !== undefined) setIsOn(!!currentOn); }, [currentOn]);
  useEffect(() => {
    const next = normalizeState(currentState);
    if (next.bright !== undefined) setLevel(next.bright);
    if (next.ct !== undefined) setCt(next.ct);
    if (next.rgb && next.rgb.length === 3) setRgb(next.rgb);
  }, [currentState]);

  const exec = async (fn, after) => {
    try { setBusy(true); await fn(); if (after) after(); } finally { setBusy(false); }
  };

  const ctHex = rgbToHex(ctToRgb(ct));
  const ctPct = `${clamp(((ct - 1700) / (6500 - 1700)) * 100, 0, 100)}%`;

  return (
    <Card>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Lightbulb className="h-5 w-5 text-red-400" />
          <h3 className="font-semibold text-white truncate max-w-[70vw]">{title}</h3>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="solid" onClick={() => exec(() => onPower(target, true), () => setIsOn(true))} active={!!isOn} disabled={busy}>On</Button>
          <Button variant="solid" onClick={() => exec(() => onPower(target, false), () => setIsOn(false))} active={!isOn} disabled={busy}>Off</Button>
          <Button variant="ghost" onClick={() => exec(() => onToggle(target), () => setIsOn(v => !v))} disabled={busy}>
            <Power className="h-4 w-4 mr-1" /> Toggle
          </Button>
        </div>
      </div>

      {quickRoutines && onRunRoutine && (
        <div className="flex flex-wrap gap-2 mb-3">
          {quickRoutines.map((routine) => {
            const running = !!routinesStatus?.[routine.name];
            return (
              <Button
                key={routine.name}
                variant="solid"
                className="px-2 py-1 text-xs"
                disabled={busy || running}
                onClick={() => exec(() => onRunRoutine(routine.name, target))}
              >
                {running ? `${routine.label}…` : routine.label}
              </Button>
            );
          })}
        </div>
      )}

      <div className="space-y-3">
        <Slider label="Brightness" min={1} max={100} value={level} onChange={(v) => { setLevel(v); onBright(target, v); }} />
        <div>
          <Slider label="Color Temp" min={1700} max={6500} step={100} value={ct} onChange={(v) => { setCt(v); onCT(target, v); }} />
          <div className="relative mt-2 h-2 rounded-full border border-zinc-800"
               style={{ background: "linear-gradient(90deg, #ff5a00 0%, #ffd1a3 50%, #e1f0ff 100%)" }}>
            <div
              className="absolute -top-1 h-4 w-4 rounded-full border border-zinc-700"
              style={{ left: `calc(${ctPct} - 8px)`, backgroundColor: ctHex }}
              title={ctHex.toUpperCase()}
            />
          </div>
        </div>
        <ColorRow rgb={rgb} onChange={(c) => { setRgb(c); onRGB(target, c[0], c[1], c[2]); }} />
      </div>
    </Card>
  );
}

function RoutineCard({ name, label, config, targets, onChange, onRun, running, lastRun }) {
  const update = (field, value) => {
    onChange(name, { ...config, [field]: value });
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-white font-semibold">{label}</h3>
          <p className="text-xs text-white/60">Duration ramps brightness + color temp.</p>
        </div>
        <div className="text-xs text-white/60">
          {running ? "Running…" : lastRun ? `Last: ${formatTimestamp(lastRun)}` : "Idle"}
        </div>
      </div>

      <div className="grid gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-white/60">Target</label>
          <select
            value={config.target || "all"}
            onChange={(e) => update("target", e.target.value)}
            className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
          >
            {targets.map((opt) => (
              <option key={opt.key || opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-white/60">Duration (min)</label>
            <input
              type="number"
              min={1}
              value={config.duration_min ?? 30}
              onChange={(e) => update("duration_min", Number(e.target.value) || 1)}
              className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-white/60">Start bright</label>
            <input
              type="number"
              min={1}
              max={100}
              value={config.start_bright ?? 10}
              onChange={(e) => update("start_bright", Number(e.target.value) || 1)}
              className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-white/60">End bright</label>
            <input
              type="number"
              min={1}
              max={100}
              value={config.end_bright ?? 100}
              onChange={(e) => update("end_bright", Number(e.target.value) || 1)}
              className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-white/60">Start temp (K)</label>
            <input
              type="number"
              min={1700}
              max={6500}
              value={config.start_ct ?? 2200}
              onChange={(e) => update("start_ct", Number(e.target.value) || 1700)}
              className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-white/60">End temp (K)</label>
            <input
              type="number"
              min={1700}
              max={6500}
              value={config.end_ct ?? 5000}
              onChange={(e) => update("end_ct", Number(e.target.value) || 1700)}
              className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="solid" onClick={() => onRun(name)} disabled={running}>
            Run {label}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// --- Main ------------------------------------------------------------------
export default function YeelightControlApp() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE);
  const {
    bulbs,
    groups,
    states,
    loading,
    error,
    reload,
    api,
    presence,
    presenceStatus,
    presenceLoading,
    presenceError,
    loadPresence,
    savePresence,
    routines,
    routinesStatus,
    routinesLoading,
    routinesError,
    loadRoutines,
    saveRoutines,
    runRoutine,
  } = useApi(baseUrl);

  const bulbNames = useMemo(() => Object.keys(bulbs).sort(), [bulbs]);
  const groupNames = useMemo(() => Object.keys(groups).sort(), [groups]);
  const presenceOptions = useMemo(() => {
    const opts = [{ value: "all", label: "All bulbs", key: "all" }];
    groupNames.forEach((name) => opts.push({ value: name, label: `Group: ${name}`, key: `group:${name}` }));
    bulbNames.forEach((name) => opts.push({ value: name, label: `Bulb: ${name}`, key: `bulb:${name}` }));
    return opts;
  }, [groupNames, bulbNames]);

  const quickRoutineButtons = useMemo(() => ([
    { name: "boost", label: "Boost" },
    { name: "wake", label: "Wake" },
    { name: "sleep", label: "Sleep" },
  ]), []);

  const presenceDefaults = useMemo(() => {
    const base = {
      enabled: false,
      device_name: "Andrei-s-S25",
      start_time: "19:00",
      end_time: "06:00",
      target: "all",
      poll_interval_sec: 30,
      cooldown_sec: 0,
    };
    const merged = { ...base, ...(presence || {}) };
    if (!merged.device_name) merged.device_name = base.device_name;
    if (!merged.target) merged.target = "all";
    return merged;
  }, [presence]);

  const [presenceDraft, setPresenceDraft] = useState(presenceDefaults);

  useEffect(() => {
    setPresenceDraft(presenceDefaults);
  }, [presenceDefaults]);

  const savePresenceConfig = async () => {
    await savePresence(presenceDraft);
    await loadPresence();
  };

  const routinesDefaults = useMemo(() => {
    const base = {
      sleep: {
        target: "all",
        duration_min: 30,
        start_bright: 80,
        end_bright: 10,
        start_ct: 3500,
        end_ct: 2200,
      },
      wake: {
        target: "all",
        duration_min: 30,
        start_bright: 10,
        end_bright: 100,
        start_ct: 2200,
        end_ct: 5000,
      },
      boost: {
        target: "all",
        duration_min: 2,
        start_bright: 20,
        end_bright: 100,
        start_ct: 2700,
        end_ct: 6000,
      },
    };
    return { ...base, ...(routines || {}) };
  }, [routines]);

  const [routinesDraft, setRoutinesDraft] = useState(routinesDefaults);

  useEffect(() => {
    setRoutinesDraft(routinesDefaults);
  }, [routinesDefaults]);

  const updateRoutine = (name, next) => {
    setRoutinesDraft((prev) => ({ ...prev, [name]: next }));
  };

  const saveRoutinesConfig = async () => {
    await saveRoutines(routinesDraft);
    await loadRoutines();
  };

  return (
    <div className="min-h-screen bg-black text-white">
      <header className="sticky top-0 z-10 backdrop-blur bg-black/70 border-b border-red-900/40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-xl bg-red-700 grid place-items-center"><Settings2 className="h-5 w-5" /></div>
            <div>
              <h1 className="text-base font-semibold">Yeelight Control</h1>
              <p className="text-xs text-white/60">Local LAN • Black & Red Theme</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="w-56 sm:w-72 rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
            />
            <Button variant="ghost" onClick={reload}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin"/> : <RefreshCcw className="h-4 w-4"/>}
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-4">
        {error && (
          <div className="mb-4 p-3 rounded-xl bg-red-900/30 border border-red-800 text-red-200 text-sm">
            {String(error)}
          </div>
        )}

        <Section
          title={`Groups (${groupNames.length})`}
          right={<span className="text-white/60 text-sm">Tap a group to control all bulbs inside</span>}
        >
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {groupNames.length === 0 && (
              <Card>
                <p className="text-white/60 text-sm">No groups configured. Define them in your server's groups.json.</p>
              </Card>
            )}
            {groupNames.map((g) => {
              const members = groups[g] || [];
              const values = members.map((m) => (states[m]?.power === 'on' ? true : states[m]?.power === 'off' ? false : null));
              const known = values.filter(v => v !== null);
              const allOn = known.length > 0 && known.every(Boolean);
              const allOff = known.length > 0 && known.every(v => v === false);
              const tri = allOn ? true : allOff ? false : undefined; // undefined = mixed/unknown
              return (
                <TargetCard
                  key={g}
                  title={`Group: ${g}`}
                  target={g}
                  currentOn={tri}
                  quickRoutines={quickRoutineButtons}
                  onRunRoutine={runRoutine}
                  routinesStatus={routinesStatus?.running}
                  onPower={api.power}
                  onToggle={api.toggle}
                  onBright={api.bright}
                  onCT={api.ct}
                  onRGB={api.rgb}
                />
              );
            })}
          </div>
        </Section>

        <Section title={`Bulbs (${bulbNames.length})`} right={<span className="text-white/60 text-sm">All discovered / configured bulbs</span>}>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {bulbNames.map((name) => (
              <TargetCard
                key={name}
                title={name}
                target={name}
                currentOn={states[name]?.power === 'on'}
                currentState={states[name]}
                onPower={api.power}
                onToggle={api.toggle}
                onBright={api.bright}
                onCT={api.ct}
                onRGB={api.rgb}
              />
            ))}
          </div>
        </Section>

        <Section
          title="Routines"
          right={<span className="text-white/60 text-sm">Sleep dims warmer • Wake brightens cooler</span>}
        >
          {routinesError && (
            <div className="mb-3 p-2 rounded-lg bg-red-900/30 border border-red-800 text-red-200 text-sm">
              {String(routinesError)}
            </div>
          )}
          <div className="grid lg:grid-cols-3 gap-3">
            <RoutineCard
              name="sleep"
              label="Sleep"
              config={routinesDraft.sleep || {}}
              targets={presenceOptions}
              onChange={updateRoutine}
              onRun={runRoutine}
              running={!!routinesStatus?.running?.sleep}
              lastRun={routinesStatus?.last_run?.sleep}
            />
            <RoutineCard
              name="wake"
              label="Wake"
              config={routinesDraft.wake || {}}
              targets={presenceOptions}
              onChange={updateRoutine}
              onRun={runRoutine}
              running={!!routinesStatus?.running?.wake}
              lastRun={routinesStatus?.last_run?.wake}
            />
            <RoutineCard
              name="boost"
              label="Boost"
              config={routinesDraft.boost || {}}
              targets={presenceOptions}
              onChange={updateRoutine}
              onRun={runRoutine}
              running={!!routinesStatus?.running?.boost}
              lastRun={routinesStatus?.last_run?.boost}
            />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="solid" onClick={saveRoutinesConfig} disabled={routinesLoading}>
              {routinesLoading ? "Saving..." : "Save routines"}
            </Button>
            <Button variant="ghost" onClick={loadRoutines} disabled={routinesLoading}>
              Refresh
            </Button>
          </div>
        </Section>

        <Section
          title="Presence Automation"
          right={<span className="text-white/60 text-sm">Turn lights on when your phone joins Wi-Fi</span>}
        >
          <Card>
            {presenceError && (
              <div className="mb-3 p-2 rounded-lg bg-red-900/30 border border-red-800 text-red-200 text-sm">
                {String(presenceError)}
              </div>
            )}
            <div className="grid gap-3">
              <div className="flex items-center gap-3">
                <input
                  id="presence-enabled"
                  type="checkbox"
                  checked={!!presenceDraft.enabled}
                  onChange={(e) => setPresenceDraft((prev) => ({ ...prev, enabled: e.target.checked }))}
                  className="h-4 w-4 accent-red-600"
                />
                <label htmlFor="presence-enabled" className="text-sm text-white/80">
                  Enable presence automation
                </label>
                <div className="ml-auto text-xs text-white/60">
                  {presenceStatus?.present ? "Present" : "Not present"}
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-white/60">Device name</label>
                  <input
                    value={presenceDraft.device_name || ""}
                    onChange={(e) => setPresenceDraft((prev) => ({ ...prev, device_name: e.target.value }))}
                    className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
                    placeholder="Andrei-s-S25"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-white/60">Target</label>
                  <select
                    value={presenceDraft.target || "all"}
                    onChange={(e) => setPresenceDraft((prev) => ({ ...prev, target: e.target.value }))}
                    className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
                  >
                    {presenceOptions.map((opt) => (
                      <option key={opt.key || opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-white/60">Start time</label>
                  <input
                    type="time"
                    value={presenceDraft.start_time || "19:00"}
                    onChange={(e) => setPresenceDraft((prev) => ({ ...prev, start_time: e.target.value }))}
                    className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-white/60">End time</label>
                  <input
                    type="time"
                    value={presenceDraft.end_time || "06:00"}
                    onChange={(e) => setPresenceDraft((prev) => ({ ...prev, end_time: e.target.value }))}
                    className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-white/60">Poll interval (sec)</label>
                  <input
                    type="number"
                    min={10}
                    value={presenceDraft.poll_interval_sec ?? 30}
                    onChange={(e) => setPresenceDraft((prev) => ({ ...prev, poll_interval_sec: Number(e.target.value) || 0 }))}
                    className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-white/60">Trigger rule</label>
                  <div className="rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-white/70">
                    Triggers only when the device reconnects
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button variant="solid" onClick={savePresenceConfig} disabled={presenceLoading}>
                  {presenceLoading ? "Saving..." : "Save"}
                </Button>
                <Button variant="ghost" onClick={loadPresence} disabled={presenceLoading}>
                  Refresh
                </Button>
                <div className="ml-auto text-xs text-white/60">
                  Last seen: {formatTimestamp(presenceStatus?.last_seen)} | Last trigger: {formatTimestamp(presenceStatus?.last_trigger)}
                </div>
              </div>
              {presenceStatus?.last_error && (
                <div className="text-xs text-red-300">
                  Status: {presenceStatus.last_error}
                </div>
              )}
            </div>
          </Card>
        </Section>
      </main>

      <footer className="max-w-5xl mx-auto px-4 py-6 text-center text-xs text-white/50">
        Built for LAN control • Works great on mobile • Theme: black / red / white
      </footer>
    </div>
  );
}
