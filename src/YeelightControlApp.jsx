import React, { useEffect, useMemo, useState } from "react";
import { Power, RefreshCcw, Lightbulb, Settings2, Loader2 } from "lucide-react";


// Mobile-first, black & red palette with white text (TailwindCSS expected in host app)
// Assumes your Yeelight REST API from earlier is reachable at BASE_URL (same host by default)
// Endpoints used:
// GET /api/bulbs -> mapping name -> {ip, id}
// GET /api/groups -> mapping group -> [names]
// POST /api/power/:target/:on|off
// POST /api/bright/:target?level=NN
// POST /api/ct/:target?k=1700..6500
// POST /api/rgb/:target?r=0..255&g=0..255&b=0..255
// POST /api/toggle/:target
// POST /api/scene/:name (optional)


const DEFAULT_BASE = "http://pi:5005/api"; // same-origin; or set to "http://pi:5005" if different host


async function jpost(base, path) {
    const res = await fetch(`${base}${path}`, { method: "POST" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json().catch(() => ({}));
}


async function jget(base, path) {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
}


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

function Pill({ children }) {
    return (
        <span className="px-2 py-0.5 rounded-full bg-red-700/20 border border-red-600/40 text-red-300 text-xs">
            {children}
        </span>
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
    const hex = useMemo(() =>
        `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
        , [r, g, b]);


    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
                <div className="w-24 text-sm text-white/70">Color</div>
                <input
                    type="color"
                    value={hex}
                    onChange={(e) => {
                        const h = e.target.value.replace('#', '');
                        onChange([
                            parseInt(h.slice(0, 2), 16),
                            parseInt(h.slice(2, 4), 16),
                            parseInt(h.slice(4, 6), 16)
                        ]);
                    }}
                    className="h-9 w-16 bg-zinc-800 rounded"
                />
                <div className="flex items-center gap-2 ml-auto text-xs text-white/60">
                    <Pill>RGB {r},{g},{b}</Pill>
                </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
                {[r, g, b].map((v, i) => (
                    <input
                        key={i}
                        type="number"
                        min={0}
                        max={255}
                        value={v}
                        onChange={(e) => {
                            const nv = Math.min(255, Math.max(0, Number(e.target.value) || 0));
                            const nrgb = [r, g, b];
                            nrgb[i] = nv;
                            onChange(nrgb);
                        }}
                        className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1 text-white"
                    />
                ))}
            </div>
        </div>
    );
}


function ActionRow({ children }) {
    return <div className="flex flex-wrap gap-2">{children}</div>;
}


function Button({ onClick, children, variant = "solid", disabled }) {
    const base =
        "px-3 py-2 rounded-xl text-sm font-medium transition active:scale-[.98] disabled:opacity-50";
    const styles =
        variant === "solid"
            ? "bg-red-600 hover:bg-red-500 text-white"
            : variant === "ghost"
                ? "bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700"
                : "bg-transparent text-white/80 hover:text-white";
    return (
        <button onClick={onClick} className={`${base} ${styles}`} disabled={disabled}>
            {children}
        </button>
    );
}

function useApi(baseUrl) {
    const [bulbs, setBulbs] = useState({});
    const [groups, setGroups] = useState({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");


    const reload = async () => {
        setLoading(true);
        setError("");
        try {
            const [b, g] = await Promise.all([
                jget(baseUrl, "/api/bulbs"),
                jget(baseUrl, "/api/groups"),
            ]);
            setBulbs(b || {});
            setGroups(g || {});
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    };


    useEffect(() => {
        reload();
        const t = setInterval(reload, 10_000); // light polling for IP changes
        return () => clearInterval(t);
    }, [baseUrl]);


    const api = {
        power: (target, on) => jpost(baseUrl, `/api/power/${encodeURIComponent(target)}/${on ? "on" : "off"}`),
        toggle: (target) => jpost(baseUrl, `/api/toggle/${encodeURIComponent(target)}`),
        bright: (target, level) => jpost(baseUrl, `/api/bright/${encodeURIComponent(target)}?level=${level}`),
        ct: (target, k) => jpost(baseUrl, `/api/ct/${encodeURIComponent(target)}?k=${k}`),
        rgb: (target, r, g, b) => jpost(baseUrl, `/api/rgb/${encodeURIComponent(target)}?r=${r}&g=${g}&b=${b}`),
        scene: (name) => jpost(baseUrl, `/api/scene/${encodeURIComponent(name)}`),
    };


    return { bulbs, groups, loading, error, reload, api };
}


function TargetCard({ title, target, onPower, onToggle, onBright, onCT, onRGB }) {
    const [level, setLevel] = useState(50);
    const [ct, setCt] = useState(4000);
    const [rgb, setRgb] = useState([255, 120, 30]);
    const [busy, setBusy] = useState(false);
    const [isOn, setIsOn] = useState(null); // null unknown, true/false after first action

    const handleOn = () => exec(async () => { await onPower(target, true); setIsOn(true); });
    const handleOff = () => exec(async () => { await onPower(target, false); setIsOn(false); });
    const handleToggle = () => exec(async () => { await onToggle(target); setIsOn(v => v === null ? true : !v); });

    const onBtnVariant = isOn === false ? "ghost" : "solid"; // red when ON
    const offBtnVariant = isOn === true ? "ghost" : "solid"; // red when OFF



    const exec = async (fn) => {
        try { setBusy(true); await fn(); } finally { setBusy(false); }
    };


    return (
        <Card>
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <Lightbulb className="h-5 w-5 text-red-400" />
                    <h3 className="font-semibold text-white">{title}</h3>
                    <Pill>{target}</Pill>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant={"ghost"} onClick={handleToggle} disabled={busy}>
                        <Power className="h-4 w-4 mr-1" /> Toggle
                    </Button>
                    <Button variant={onBtnVariant} onClick={handleOn} disabled={busy}>On</Button>
                    <Button variant={offBtnVariant} onClick={handleOff} disabled={busy}>Off</Button>
                </div>
            </div>


            <div className="space-y-3">
                <Slider label="Brightness" min={1} max={100} value={level} onChange={(v) => { setLevel(v); onBright(target, v); }} />
                <Slider label="Color Temp" min={1700} max={6500} step={100} value={ct} onChange={(v) => { setCt(v); onCT(target, v); }} />
                <ColorRow rgb={rgb} onChange={(c) => { setRgb(c); onRGB(target, c[0], c[1], c[2]); }} />
            </div>
        </Card>
    );
}

export default function YeelightControlApp() {
    const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE);
    const { bulbs, groups, loading, error, reload, api } = useApi(baseUrl);


    const bulbNames = useMemo(() => Object.keys(bulbs).sort(), [bulbs]);
    const groupNames = useMemo(() => Object.keys(groups).sort(), [groups]);


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
                            placeholder="API base (e.g. http://pi:5005)"
                            className="w-56 sm:w-72 rounded-xl bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-red-600"
                        />
                        <Button variant="ghost" onClick={reload}>
                            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
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
                        {groupNames.map((g) => (
                            <TargetCard
                                key={g}
                                title={`Group: ${g}`}
                                target={g}
                                onPower={api.power}
                                onToggle={api.toggle}
                                onBright={api.bright}
                                onCT={api.ct}
                                onRGB={api.rgb}
                            />
                        ))}
                    </div>
                </Section>


                <Section title={`Bulbs (${bulbNames.length})`} right={<span className="text-white/60 text-sm">All discovered / configured bulbs</span>}>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {bulbNames.map((name) => (
                            <TargetCard
                                key={name}
                                title={name}
                                target={name}
                                onPower={api.power}
                                onToggle={api.toggle}
                                onBright={api.bright}
                                onCT={api.ct}
                                onRGB={api.rgb}
                            />
                        ))}
                    </div>
                </Section>
            </main>


            <footer className="max-w-5xl mx-auto px-4 py-6 text-center text-xs text-white/50">
                Built for LAN control • Works great on mobile • Theme: black / red / white
            </footer>
        </div>
    );
}
