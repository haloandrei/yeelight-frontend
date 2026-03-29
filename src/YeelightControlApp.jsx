import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Power, RefreshCcw, Wifi, WifiOff } from "lucide-react";

const API_BASE = "/api";
const REQUEST_DEDUP = new Map();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const rgbToHex = (rgb) => {
  if (!Array.isArray(rgb) || rgb.length !== 3) return "#ffffff";
  return `#${rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("")}`;
};

const rgbToHsv = (rgb) => {
  const [r, g, b] = rgb.map((v) => clamp(v, 0, 255) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;

  const s = max === 0 ? 0 : (delta / max) * 100;
  const v = max * 100;
  return { h, s, v };
};

const hsvToRgb = ({ h, s, v }) => {
  const sat = clamp(s, 0, 100) / 100;
  const val = clamp(v, 0, 100) / 100;
  const c = val * sat;
  const hh = (h % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hh >= 0 && hh < 1) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hh >= 1 && hh < 2) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hh >= 2 && hh < 3) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hh >= 3 && hh < 4) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hh >= 4 && hh < 5) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  const m = val - c;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
};

function useThrottledAction(action, intervalMs = 120) {
  const lastRunRef = useRef(0);
  const timeoutRef = useRef(null);
  const queuedArgsRef = useRef(null);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  return useCallback((...args) => {
    const now = Date.now();
    const elapsed = now - lastRunRef.current;
    queuedArgsRef.current = args;

    const run = () => {
      lastRunRef.current = Date.now();
      const queued = queuedArgsRef.current;
      queuedArgsRef.current = null;
      action(...queued);
    };

    if (elapsed >= intervalMs) {
      clearTimeout(timeoutRef.current);
      run();
      return;
    }

    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(run, intervalMs - elapsed);
  }, [action, intervalMs]);
}

async function request(path, options = {}, timeoutMs = 9000, dedupeKey = "") {
  if (dedupeKey) {
    const previous = REQUEST_DEDUP.get(dedupeKey);
    previous?.abort(`superseded:${dedupeKey}`);
  }
  const controller = new AbortController();
  if (dedupeKey) {
    REQUEST_DEDUP.set(dedupeKey, controller);
  }
  const timeout = setTimeout(() => controller.abort(`timeout:${path}`), Math.max(1000, timeoutMs));
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && String(controller.signal.reason || "").startsWith("superseded:")) {
      throw new Error("superseded");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (dedupeKey && REQUEST_DEDUP.get(dedupeKey) === controller) {
      REQUEST_DEDUP.delete(dedupeKey);
    }
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json().catch(() => ({}));
}

function useYeelight() {
  const [bulbs, setBulbs] = useState({});
  const [groups, setGroups] = useState({});
  const [music, setMusic] = useState({});
  const [states, setStates] = useState({});
  const [presence, setPresence] = useState({ config: {}, status: {} });
  const [routines, setRoutines] = useState({ config: {}, status: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastSyncAt, setLastSyncAt] = useState(0);
  const [liveMode, setLiveMode] = useState("poll");
  const [pendingTargets, setPendingTargets] = useState({});
  const stateInFlightRef = useRef(false);
  const lockedBulbsRef = useRef({});

  const applyRemoteStates = useCallback((incoming, stamp = Date.now()) => {
    const normalized = incoming && typeof incoming === "object" ? incoming : {};
    setStates((prev) => {
      const next = { ...prev };
      for (const [name, remote] of Object.entries(normalized)) {
        if ((lockedBulbsRef.current[name] || 0) > 0) continue;
        next[name] = remote;
      }
      return next;
    });
    setLastSyncAt(stamp);
    return normalized;
  }, []);

  const fetchStateSnapshot = useCallback(async () => {
    const nextState = await request("/state");
    return applyRemoteStates(nextState, Date.now());
  }, [applyRemoteStates]);

  const loadTopology = useCallback(async () => {
    const [nextBulbs, nextGroups, nextMusic] = await Promise.all([
      request("/bulbs"),
      request("/groups"),
      request("/music"),
    ]);
    setBulbs(nextBulbs || {});
    setGroups(nextGroups || {});
    setMusic(nextMusic?.enabled || {});
  }, []);

  const loadState = useCallback(async () => {
    if (stateInFlightRef.current) return;
    stateInFlightRef.current = true;
    try {
      await fetchStateSnapshot();
    } finally {
      stateInFlightRef.current = false;
    }
  }, [fetchStateSnapshot]);

  const loadAutomation = useCallback(async () => {
    const [nextPresence, nextRoutines] = await Promise.all([
      request("/presence"),
      request("/routines"),
    ]);
    setPresence(nextPresence || { config: {}, status: {} });
    setRoutines(nextRoutines || { config: {}, status: {} });
  }, []);

  const refreshAll = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      await Promise.all([loadTopology(), loadState(), loadAutomation()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [loadAutomation, loadState, loadTopology]);

  useEffect(() => {
    refreshAll().catch(() => undefined);
    const topologyTimer = setInterval(() => {
      Promise.all([loadTopology(), loadAutomation()]).catch(() => undefined);
    }, 30000);
    return () => {
      clearInterval(topologyTimer);
    };
  }, [loadAutomation, loadState, loadTopology, refreshAll]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        loadState().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadState]);

  useEffect(() => {
    if (typeof window === "undefined" || !("EventSource" in window)) return undefined;
    const es = new EventSource("/events/state");

    const onState = (event) => {
      try {
        const payload = JSON.parse(event.data || "{}");
        if (payload?.states && typeof payload.states === "object") {
          applyRemoteStates(payload.states, payload.at || Date.now());
          setLiveMode("stream");
        }
      } catch {
        setLiveMode("poll");
      }
    };

    const onError = () => {
      setLiveMode("poll");
    };

    es.addEventListener("state", onState);
    es.addEventListener("error", onError);
    es.onmessage = onState;
    es.onopen = () => {
      setLiveMode("stream");
    };
    es.onerror = onError;

    return () => {
      es.close();
    };
  }, [applyRemoteStates]);

  const resolveTargets = useCallback((target) => {
    if (target === "all") return Object.keys(bulbs);
    if (groups[target]) return groups[target];
    return [target];
  }, [bulbs, groups]);

  const patchTargets = useCallback((target, patch) => {
    const names = resolveTargets(target);
    setStates((prev) => {
      const next = { ...prev };
      names.forEach((name) => {
        next[name] = { ...(next[name] || {}), ...patch };
      });
      return next;
    });
  }, [resolveTargets]);

  const lockBulbNames = useCallback((names, delta) => {
    if (!Array.isArray(names) || names.length === 0) return;
    const next = { ...lockedBulbsRef.current };
    names.forEach((name) => {
      const count = (next[name] || 0) + delta;
      if (count <= 0) {
        delete next[name];
      } else {
        next[name] = count;
      }
    });
    lockedBulbsRef.current = next;
  }, []);

  const withTargetLock = useCallback(async (target, run) => {
    const names = resolveTargets(target);
    lockBulbNames(names, 1);
    try {
      return await run();
    } finally {
      lockBulbNames(names, -1);
    }
  }, [lockBulbNames, resolveTargets]);

  const setPending = useCallback((target, delta) => {
    setPendingTargets((prev) => {
      const next = { ...prev };
      const count = (next[target] || 0) + delta;
      if (count <= 0) {
        delete next[target];
      } else {
        next[target] = count;
      }
      return next;
    });
  }, []);

  const withPending = useCallback(async (target, run) => {
    setPending(target, 1);
    try {
      return await run();
    } finally {
      setPending(target, -1);
    }
  }, [setPending]);

  const safeAction = useCallback(async (run, fallbackRefresh = true) => {
    setError("");
    try {
      const result = await run();
      setLastSyncAt(Date.now());
      return result;
    } catch (err) {
      if (err instanceof Error && err.message === "superseded") {
        return null;
      }
      setError(err instanceof Error ? err.message : String(err));
      if (fallbackRefresh) {
        loadState().catch(() => undefined);
      }
      return null;
    }
  }, [loadState]);

  const actions = useMemo(() => ({
    refresh: refreshAll,
    power: async (target, on) => {
      patchTargets(target, { power: on ? "on" : "off" });
      await withPending(target, async () => {
        const retries = on ? 2 : 4;
        const res = await withTargetLock(
          target,
          () => safeAction(() => request(`/power/${encodeURIComponent(target)}/${on ? "on" : "off"}?burst=2&retries=${retries}`, { method: "POST" }, 12000)),
        );
        if (res?.ok === false && res?.failed) {
          if (!on) {
            try {
              await new Promise((resolve) => setTimeout(resolve, 180));
              const freshState = await fetchStateSnapshot();
              const names = resolveTargets(target);
              const allOff = names.length > 0 && names.every((name) => freshState?.[name]?.power === "off");
              if (allOff) {
                setError("");
                return;
              }
            } catch {
              // keep partial failure message when state check fails
            }
          }
          setError(`Power ${on ? "on" : "off"} partial failure: ${res.failed} bulb(s) unreachable after retries.`);
        }
      });
    },
    toggle: async (target) => {
      await withPending(target, async () => {
        const res = await withTargetLock(target, () => safeAction(() => request(`/toggle/${encodeURIComponent(target)}`, { method: "POST" }, 12000)));
        if (res?.ok === false && res?.failed) {
          setError(`Toggle partial failure: ${res.failed} bulb(s) unreachable after retries.`);
        }
      });
    },
    bright: async (target, level) => {
      const nextLevel = clamp(Math.round(level), 1, 100);
      patchTargets(target, { bright: nextLevel, power: "on" });
      await withTargetLock(
        target,
        () => safeAction(
          () => request(
            `/bright/${encodeURIComponent(target)}?level=${nextLevel}`,
            { method: "POST" },
            12000,
            `bright:${target}`,
          ),
        ),
      );
    },
    rgb: async (target, rgb) => {
      const [r, g, b] = rgb.map((v) => clamp(Math.round(v), 0, 255));
      patchTargets(target, { rgb: [r, g, b], color_mode: 1, power: "on" });
      await withTargetLock(
        target,
        () => safeAction(
          () => request(
            `/rgb/${encodeURIComponent(target)}?r=${r}&g=${g}&b=${b}`,
            { method: "POST" },
            12000,
            `rgb:${target}`,
          ),
        ),
      );
    },
    setPresenceConfig: async (patch) => {
      await withPending("presence", async () => {
        const current = presence?.config || {};
        await safeAction(
          () => request(
            "/presence",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...current, ...patch }),
            },
            12000,
          ),
        );
        await loadAutomation();
      });
    },
    updateRoutine: async (name, patch) => {
      if (!name) return;
      await withPending(`routine:${name}:save`, async () => {
        const current = routines?.config?.[name] || {};
        await safeAction(
          () => request(
            "/routines",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ [name]: { ...current, ...patch } }),
            },
            12000,
          ),
        );
        await loadAutomation();
      });
    },
    startRoutine: async (name) => {
      if (!name) return;
      await withPending(`routine:${name}:run`, async () => {
        await safeAction(() => request(`/routine/${encodeURIComponent(name)}/start`, { method: "POST" }, 12000));
        await Promise.all([loadAutomation(), loadState()]);
      });
    },
    stopRoutine: async (name) => {
      if (!name) return;
      await withPending(`routine:${name}:run`, async () => {
        await safeAction(() => request(`/routine/${encodeURIComponent(name)}/stop`, { method: "POST" }, 12000));
        await Promise.all([loadAutomation(), loadState()]);
      });
    },
    setMusicMode: async (target, enabled) => {
      if (!target) return;
      await withPending(`music:${target}`, async () => {
        const state = enabled ? "on" : "off";
        const result = await safeAction(() => request(`/music/${encodeURIComponent(target)}/${state}`, { method: "POST" }, 12000));
        if (result?.enabled && typeof result.enabled === "object") {
          setMusic(result.enabled);
        } else {
          await loadTopology();
        }
      });
    },
    isPending: (target) => Boolean(pendingTargets[target]),
  }), [patchTargets, refreshAll, safeAction, withPending, pendingTargets, fetchStateSnapshot, resolveTargets, presence, routines, loadAutomation, loadState, withTargetLock, loadTopology]);

  return {
    bulbs,
    groups,
    music,
    states,
    presence,
    routines,
    loading,
    error,
    lastSyncAt,
    liveMode,
    actions,
  };
}

function groupAggregate(memberNames, states) {
  const memberStates = memberNames.map((name) => states[name]).filter(Boolean);
  const knownPower = memberStates.map((s) => s?.power).filter((p) => p === "on" || p === "off");
  const allOn = knownPower.length > 0 && knownPower.every((p) => p === "on");
  const allOff = knownPower.length > 0 && knownPower.every((p) => p === "off");
  const sample = memberStates.find((s) => Array.isArray(s?.rgb) && s.rgb.length === 3)
    || memberStates.find((s) => typeof s?.bright === "number")
    || {};

  return {
    power: allOn ? "on" : allOff ? "off" : "mixed",
    bright: typeof sample.bright === "number" ? sample.bright : 50,
    rgb: Array.isArray(sample.rgb) && sample.rgb.length === 3 ? sample.rgb : [255, 110, 30],
  };
}

function HsvColorPicker({ rgb, onChange, disabled = false }) {
  const [hsv, setHsv] = useState(() => rgbToHsv(rgb));
  const planeRef = useRef(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    setHsv(rgbToHsv(rgb));
  }, [rgb]);

  const emit = (next) => {
    setHsv(next);
    onChange(hsvToRgb(next));
  };

  const updateFromPointer = (event) => {
    if (!planeRef.current) return;
    const rect = planeRef.current.getBoundingClientRect();
    const sat = clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100);
    const val = clamp((1 - (event.clientY - rect.top) / rect.height) * 100, 0, 100);
    emit({ ...hsv, s: sat, v: val });
  };

  return (
    <div className="space-y-2">
      <div
        ref={planeRef}
        className="relative h-36 w-full rounded-xl border border-zinc-600 cursor-crosshair"
        style={{
          touchAction: "none",
          backgroundColor: `hsl(${hsv.h} 100% 50%)`,
          backgroundImage: "linear-gradient(to right, #fff, rgba(255,255,255,0)), linear-gradient(to top, #000, rgba(0,0,0,0))",
        }}
        onPointerDown={(event) => {
          if (disabled) return;
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (disabled) return;
          if (!draggingRef.current) return;
          updateFromPointer(event);
        }}
        onPointerUp={(event) => {
          draggingRef.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      >
        <div
          className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_#000]"
          style={{
            left: `${hsv.s}%`,
            top: `${100 - hsv.v}%`,
          }}
        />
      </div>

      <input
        type="range"
        min={0}
        max={360}
        value={Math.round(hsv.h)}
        onChange={(event) => emit({ ...hsv, h: Number(event.target.value) })}
        disabled={disabled}
        className="w-full accent-red-500"
        style={{
          background: "linear-gradient(90deg, #ff0000 0%, #ffa500 16%, #ffff00 33%, #00ff00 50%, #00ffff 66%, #0000ff 83%, #ff00ff 100%)",
        }}
      />
    </div>
  );
}

function ControlCard({ title, target, state, actions, members, music }) {
  const [brightness, setBrightness] = useState(50);
  const [rgb, setRgb] = useState([255, 110, 30]);

  useEffect(() => {
    if (typeof state?.bright === "number") {
      setBrightness(clamp(state.bright, 1, 100));
    }
    if (Array.isArray(state?.rgb) && state.rgb.length === 3) {
      setRgb(state.rgb.map((v) => clamp(Number(v) || 0, 0, 255)));
    }
  }, [state]);

  const throttledBrightness = useThrottledAction((value) => {
    actions.bright(target, value);
  }, 90);

  const throttledColor = useThrottledAction((nextRgb) => {
    actions.rgb(target, nextRgb);
  }, 120);
  const pending = actions.isPending(target);
  const musicPending = actions.isPending(`music:${target}`);

  const onState = state?.power || "mixed";
  const stateColor = onState === "on" ? "text-emerald-300" : onState === "off" ? "text-zinc-400" : "text-amber-300";
  const stateText = onState === "on" ? "ON" : onState === "off" ? "OFF" : "MIXED";
  const memberMusic = Array.isArray(members) ? members.map((name) => music?.[name]).filter((v) => typeof v === "boolean") : [];
  const musicAllOn = memberMusic.length > 0 && memberMusic.every(Boolean);
  const musicAllOff = memberMusic.length > 0 && memberMusic.every((v) => !v);
  const musicStateText = musicAllOn ? "ON" : musicAllOff ? "OFF" : "MIXED";
  const nextMusicEnabled = !musicAllOn;

  return (
    <article className="rounded-2xl border border-zinc-700 bg-zinc-900/70 p-2.5 sm:p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-white">{title}</h3>
          {members ? (
            <p className="mt-1 text-xs text-zinc-400">{members.length} bulbs</p>
          ) : null}
        </div>
        <span className={`rounded-full border border-zinc-700 px-2 py-1 text-xs font-semibold ${stateColor}`}>
          {stateText}
        </span>
      </div>
      {pending ? (
        <div className="mb-3 inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-600/20 px-2 py-1 text-xs text-amber-200">
          <Loader2 className="h-3 w-3 animate-spin" />
          In progress
        </div>
      ) : null}

      <div className="mb-3 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => actions.power(target, true)}
          disabled={pending}
          className="rounded-lg border border-zinc-600 bg-zinc-800 px-1.5 py-1 text-[11px] sm:px-2 sm:text-xs text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          On
        </button>
        <button
          type="button"
          onClick={() => actions.power(target, false)}
          disabled={pending}
          className="rounded-lg border border-zinc-600 bg-zinc-800 px-1.5 py-1 text-[11px] sm:px-2 sm:text-xs text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          Off
        </button>
        <button
          type="button"
          onClick={() => actions.toggle(target)}
          disabled={pending}
          aria-label={`Toggle ${title}`}
          title="Toggle"
          className="inline-flex items-center justify-center rounded-lg border border-zinc-600 bg-zinc-800 p-1.5 text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          <RefreshCcw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between text-xs text-zinc-300">
          <span>Brightness</span>
          <span>{brightness}</span>
        </div>
        <input
          type="range"
          min={1}
          max={100}
          value={brightness}
          disabled={pending}
          onChange={(event) => {
            const next = Number(event.target.value);
            setBrightness(next);
            if (!pending) {
              throttledBrightness(next);
            }
          }}
          className="w-full accent-red-500"
        />
      </div>

      <div className="mb-2 flex items-center justify-between text-xs text-zinc-300">
        <span>Color</span>
        <span className="rounded-md border border-zinc-600 px-2 py-1 font-mono" style={{ backgroundColor: rgbToHex(rgb) }}>
          {rgbToHex(rgb).toUpperCase()}
        </span>
      </div>
      <HsvColorPicker
        rgb={rgb}
        disabled={pending}
        onChange={(nextRgb) => {
          setRgb(nextRgb);
          if (!pending) {
            throttledColor(nextRgb);
          }
        }}
      />

      {Array.isArray(members) ? (
        <div className="mt-3 flex items-center justify-between rounded-lg border border-zinc-700 bg-zinc-950/70 px-2 py-2">
          <span className="text-xs text-zinc-300">Music mode: <span className="font-semibold">{musicStateText}</span></span>
          <button
            type="button"
            disabled={pending || musicPending}
            onClick={() => actions.setMusicMode(target, nextMusicEnabled)}
            className="rounded-md border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs font-semibold text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            {musicPending ? "Switching..." : nextMusicEnabled ? "Enable" : "Disable"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function formatUnixSeconds(ts) {
  if (!ts) return "never";
  return new Date(ts * 1000).toLocaleTimeString();
}

function AutomationPanel({ bulbs, groups, presence, routines, actions }) {
  const presenceConfig = presence?.config || {};
  const presenceStatus = presence?.status || {};
  const routineConfig = routines?.config || {};
  const routineStatus = routines?.status || {};

  const targetOptions = useMemo(() => {
    const all = ["all", ...Object.keys(groups || {}), ...Object.keys(bulbs || {})];
    return Array.from(new Set(all));
  }, [groups, bulbs]);

  const routineOptions = useMemo(() => {
    const names = Object.keys(routineConfig || {});
    if (!names.includes("boost")) names.push("boost");
    return names;
  }, [routineConfig]);

  const [presenceDraft, setPresenceDraft] = useState({
    enabled: false,
    device_name: "",
    device_mac: "",
    device_iface: "",
    start_time: "19:00",
    end_time: "06:00",
    target: "all",
    routine: "boost",
    poll_interval_sec: 30,
    cooldown_sec: 0,
  });

  const [routineDraft, setRoutineDraft] = useState({
    wake: {},
    sleep: {},
  });

  useEffect(() => {
    setPresenceDraft((prev) => ({ ...prev, ...presenceConfig }));
  }, [presenceConfig]);

  useEffect(() => {
    setRoutineDraft({
      wake: { ...(routineConfig.wake || {}) },
      sleep: { ...(routineConfig.sleep || {}) },
    });
  }, [routineConfig]);

  const updateRoutineField = (name, key, value) => {
    setRoutineDraft((prev) => ({
      ...prev,
      [name]: {
        ...(prev[name] || {}),
        [key]: value,
      },
    }));
  };

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">Automation</h2>
        <span className="text-xs text-zinc-400">Wake/Sleep + Wi-Fi presence</span>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <article className="rounded-2xl border border-zinc-700 bg-zinc-900/70 p-3 sm:p-4 lg:col-span-1">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Presence Trigger</h3>
            <span className={`rounded-full border px-2 py-1 text-xs ${presenceStatus.present ? "border-emerald-500/50 text-emerald-300" : "border-zinc-700 text-zinc-400"}`}>
              {presenceStatus.present ? "present" : "away"}
            </span>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-zinc-200">
              <input
                type="checkbox"
                checked={Boolean(presenceDraft.enabled)}
                onChange={(event) => setPresenceDraft((prev) => ({ ...prev, enabled: event.target.checked }))}
                className="accent-red-500"
              />
              Enabled
            </label>

            <input
              value={presenceDraft.device_name || ""}
              onChange={(event) => setPresenceDraft((prev) => ({ ...prev, device_name: event.target.value }))}
              placeholder="device hostname (phone/laptop)"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
            />
            <input
              value={presenceDraft.device_mac || ""}
              onChange={(event) => setPresenceDraft((prev) => ({ ...prev, device_mac: event.target.value }))}
              placeholder="device mac (optional)"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
            />
            <input
              value={presenceDraft.device_iface || ""}
              onChange={(event) => setPresenceDraft((prev) => ({ ...prev, device_iface: event.target.value }))}
              placeholder="interface (optional, ex: wlan0)"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
            />

            <div className="grid grid-cols-2 gap-2">
              <input
                type="time"
                value={presenceDraft.start_time || "19:00"}
                onChange={(event) => setPresenceDraft((prev) => ({ ...prev, start_time: event.target.value }))}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
              />
              <input
                type="time"
                value={presenceDraft.end_time || "06:00"}
                onChange={(event) => setPresenceDraft((prev) => ({ ...prev, end_time: event.target.value }))}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <select
                value={presenceDraft.target || "all"}
                onChange={(event) => setPresenceDraft((prev) => ({ ...prev, target: event.target.value }))}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
              >
                {targetOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
              <select
                value={presenceDraft.routine || "boost"}
                onChange={(event) => setPresenceDraft((prev) => ({ ...prev, routine: event.target.value }))}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
              >
                {routineOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                min={5}
                value={presenceDraft.poll_interval_sec ?? 30}
                onChange={(event) => setPresenceDraft((prev) => ({ ...prev, poll_interval_sec: Number(event.target.value) || 30 }))}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
              />
              <input
                type="number"
                min={0}
                value={presenceDraft.cooldown_sec ?? 0}
                onChange={(event) => setPresenceDraft((prev) => ({ ...prev, cooldown_sec: Number(event.target.value) || 0 }))}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
              />
            </div>

            <button
              type="button"
              onClick={() => actions.setPresenceConfig(presenceDraft)}
              disabled={actions.isPending("presence")}
              className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {actions.isPending("presence") ? "Saving..." : "Save Presence"}
            </button>

            <p className="text-[11px] text-zinc-400">
              Last seen {formatUnixSeconds(presenceStatus.last_seen)} • Last trigger {formatUnixSeconds(presenceStatus.last_trigger)}
            </p>
          </div>
        </article>

        <div className="grid gap-3 lg:col-span-2 sm:grid-cols-2">
          {["wake", "sleep"].map((name) => {
            const cfg = routineDraft[name] || {};
            const running = Boolean(routineStatus?.running?.[name]);
            const runPending = actions.isPending(`routine:${name}:run`);
            const savePending = actions.isPending(`routine:${name}:save`);
            return (
              <article key={name} className="rounded-2xl border border-zinc-700 bg-zinc-900/70 p-3 sm:p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold capitalize text-white">{name}</h3>
                  <span className={`rounded-full border px-2 py-1 text-xs ${running ? "border-emerald-500/50 text-emerald-300" : "border-zinc-700 text-zinc-400"}`}>
                    {running ? "running" : "stopped"}
                  </span>
                </div>

                <div className="space-y-2">
                  <select
                    value={cfg.target || "all"}
                    onChange={(event) => updateRoutineField(name, "target", event.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
                  >
                    {targetOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>

                  <div className="grid grid-cols-3 gap-2">
                    <input
                      type="number"
                      min={1}
                      value={cfg.duration_min ?? 30}
                      onChange={(event) => updateRoutineField(name, "duration_min", Number(event.target.value) || 1)}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
                      title="Minutes"
                    />
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={cfg.start_bright ?? 10}
                      onChange={(event) => updateRoutineField(name, "start_bright", clamp(Number(event.target.value) || 1, 1, 100))}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
                      title="Start brightness"
                    />
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={cfg.end_bright ?? 100}
                      onChange={(event) => updateRoutineField(name, "end_bright", clamp(Number(event.target.value) || 1, 1, 100))}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
                      title="End brightness"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      min={1700}
                      max={6500}
                      value={cfg.start_ct ?? 2200}
                      onChange={(event) => updateRoutineField(name, "start_ct", clamp(Number(event.target.value) || 1700, 1700, 6500))}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
                      title="Start CT"
                    />
                    <input
                      type="number"
                      min={1700}
                      max={6500}
                      value={cfg.end_ct ?? 5000}
                      onChange={(event) => updateRoutineField(name, "end_ct", clamp(Number(event.target.value) || 1700, 1700, 6500))}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
                      title="End CT"
                    />
                  </div>
                </div>

                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => actions.startRoutine(name)}
                    disabled={runPending}
                    className="flex-1 rounded-lg border border-emerald-600/50 bg-emerald-700/40 px-2 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-600/50 disabled:opacity-50"
                  >
                    {runPending ? "Working..." : "Start"}
                  </button>
                  <button
                    type="button"
                    onClick={() => actions.stopRoutine(name)}
                    disabled={runPending}
                    className="flex-1 rounded-lg border border-zinc-600 bg-zinc-800 px-2 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
                  >
                    Stop
                  </button>
                  <button
                    type="button"
                    onClick={() => actions.updateRoutine(name, cfg)}
                    disabled={savePending}
                    className="flex-1 rounded-lg border border-zinc-600 bg-zinc-800 px-2 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
                  >
                    {savePending ? "Saving..." : "Save"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function formatSync(ts) {
  if (!ts) return "waiting";
  return new Date(ts).toLocaleTimeString();
}

export default function YeelightControlApp() {
  const { bulbs, groups, music, states, presence, routines, loading, error, lastSyncAt, liveMode, actions } = useYeelight();

  const bulbNames = useMemo(() => Object.keys(bulbs).sort(), [bulbs]);
  const groupEntries = useMemo(() => Object.entries(groups), [groups]);
  const primaryGroups = useMemo(() => groupEntries.slice(0, 3), [groupEntries]);
  const allPending = actions.isPending("all");

  return (
    <div className="min-h-screen bg-black text-white">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-black/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-2 px-2 py-2 sm:gap-3 sm:px-4 sm:py-3">
          <div>
            <h1 className="text-lg font-semibold">Yeelight Live Control</h1>
            <p className="hidden text-xs text-zinc-400 sm:block">Port 5005 • Real-time state sync</p>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2 py-1 text-xs text-zinc-300">
              {liveMode === "stream" ? <Wifi className="h-3.5 w-3.5 text-emerald-400" /> : <WifiOff className="h-3.5 w-3.5 text-amber-400" />}
              {liveMode === "stream" ? "stream" : "poll"}
            </span>
            <span className="rounded-full border border-zinc-700 px-2 py-1 text-xs text-zinc-300">
              sync {formatSync(lastSyncAt)}
            </span>
            <button
              type="button"
              onClick={() => actions.refresh()}
              className="rounded-xl border border-zinc-700 bg-zinc-900 p-2 text-zinc-200 hover:bg-zinc-800"
              aria-label="Refresh"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => actions.power("all", false)}
              disabled={allPending}
              className="inline-flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-600/90 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500"
            >
              {allPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
              {allPending ? "Switching..." : "Shut Down All Bulbs"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-2 py-3 sm:px-4 sm:py-4">
        {error ? (
          <div className="mb-4 rounded-xl border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        <section className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-semibold">Groups</h2>
            <span className="text-xs text-zinc-400">Fixed one row, three columns</span>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {Array.from({ length: 3 }).map((_, index) => {
              const entry = primaryGroups[index];
              if (!entry) {
                return (
                  <div key={`placeholder-${index}`} className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-950/50 p-4 text-xs text-zinc-500">
                    Empty group slot
                  </div>
                );
              }

              const [groupName, members] = entry;
              const aggregate = groupAggregate(members, states);

              return (
                <ControlCard
                  key={groupName}
                  title={groupName}
                  target={groupName}
                  members={members}
                  music={music}
                  state={aggregate}
                  actions={actions}
                />
              );
            })}
          </div>
        </section>

        <AutomationPanel
          bulbs={bulbs}
          groups={groups}
          presence={presence}
          routines={routines}
          actions={actions}
        />

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-semibold">Bulbs</h2>
            <span className="text-xs text-zinc-400">{bulbNames.length} discovered</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {bulbNames.map((name) => (
                <ControlCard
                  key={name}
                  title={name}
                  target={name}
                  state={states[name] || {}}
                  music={music}
                  actions={actions}
                />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
