import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { init, reduce, type State, type Cell } from "./state";
import { pickSource } from "./source";
import { DICT, pickLang, type Dict, type Lang } from "./i18n";

// Active dictionary; assigned in App before children render.
let T: Dict = DICT.en;

const fmt = (n: number | undefined, d = 0) => (n === undefined || !isFinite(n) ? "n/a" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const sgn = (n: number | undefined, d = 1) => (n === undefined ? "n/a" : (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n), d));
const short = (h: string) => (h.length > 14 ? h.slice(0, 6) + "…" + h.slice(-4) : h);
// Score scale: seven steps from paper tint to blue-black ink. Varies in lightness, not hue.
const SCALE = ["#e4dcc8", "#c9cfe0", "#9fb0d6", "#7088c4", "#4562b3", "#2a45a6", "#14246b"];
const stepIdx = (v: number, lo: number, hi: number) => Math.max(0, Math.min(6, Math.round(((v - lo) / Math.max(1e-9, hi - lo)) * 6)));
const step = (v: number, lo: number, hi: number) => SCALE[stepIdx(v, lo, hi)]!;
const ROWS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const COLS = 20;

function safeExplorer(u: string | undefined) {
  try { if (!u) return ""; const x = new URL(u); return x.protocol.startsWith("http") ? x.origin + x.pathname.replace(/\/$/, "") : ""; } catch { return ""; }
}
function Lk({ href, children, title }: { href: string; children: React.ReactNode; title?: string }) {
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" title={title}>{children}</a> : <span>{children}</span>;
}
function Head({ n, title, sub }: { n: number; title: string; sub?: React.ReactNode }) {
  return (
    <div className="ph">
      <h2><span className="fig">{T.fig} {n}</span>{title}</h2>
      {sub !== undefined && <span className="cap">{sub}</span>}
    </div>
  );
}

function Plate({ s }: { s: State }) {
  const devs = s.cells.filter((c) => c.dev !== undefined).map((c) => c.dev!);
  const lo = devs.length ? Math.min(...devs) : 0, hi = devs.length ? Math.max(...devs) : 1;
  const top = new Set((s.ends[s.gen]?.archive ?? []).filter((a) => a.gen === s.gen).map((a) => a.idx));
  const landed = s.cells.filter((c) => c.state === "landed").length;
  const cells = s.cells.length ? s.cells : Array.from({ length: 200 }, () => ({ state: "idle" }) as Cell);
  const rows = Math.ceil(cells.length / COLS);
  const ge = s.ends[s.gen];
  const h = ge ? ge.blocks.histogram : s.liveHist;
  const keys = Object.keys(h).map(Number);
  const total = keys.reduce((a, k) => a + (h[k] ?? 0), 0);
  const ex = safeExplorer(s.hello?.explorer);
  const parts = T.evals_in_blocks(fmt(total), fmt(keys.length));
  return (
    <section className="panel hero">
      <div className="heroin">
        <div className="plate" style={{ ["--rows" as string]: rows }}>
          <div className="collabels">{Array.from({ length: COLS }, (_, i) => <span key={i}>{i + 1}</span>)}</div>
          <div className="rowlabels">{Array.from({ length: rows }, (_, i) => <span key={i}>{ROWS[i]}</span>)}</div>
          <div className="wells">
            {cells.map((c, i) => (
              <div key={i} className={"well " + c.state + (top.has(i) ? " top" : "") + (c.status && c.status !== "success" ? " bad" : "")}
                title={c.dev !== undefined ? `${ROWS[Math.floor(i / COLS)]}${(i % COLS) + 1}  dev ${c.dev}` : `${ROWS[Math.floor(i / COLS)]}${(i % COLS) + 1}`}>
                {c.state === "landed" && c.status === "success" && <i key={c.hash} style={{ background: step(c.dev ?? lo, lo, hi) }} />}
              </div>
            ))}
          </div>
        </div>
        <div className="side">
          <div className="lbl">{T.fig} 1 &middot; {T.plate_title}</div>
          <h1 className="claim">{parts.map((p, i) => (i % 2 === 1 ? <span key={i}>{p}</span> : <b key={i}>{p}</b>))}</h1>
          <div className="cap">{T.plate_sub(landed, s.planned ? String(s.planned) : "?")}</div>
          <div className="blockbox">
            <div className="lbl">{T.claim_this_block}</div>
            <div key={s.blockSeq} className="big fadein num">{fmt(s.lastBlockEvals)}</div>
            <div className="cap num">{T.at_block} <Lk href={s.block && ex ? `${ex}/block/${s.block}` : ""}>{s.block ? fmt(s.block) : T.waiting}</Lk></div>
          </div>
          <div className="cap note">{T.plate_note}</div>
        </div>
      </div>
      <div className="legend">
        <span>{T.lg_dev}</span><span>{T.lg_low}</span>{SCALE.map((c) => <i key={c} style={{ background: c }} />)}<span>{T.lg_high}</span>
        <span className="sep" /><span className="ringkey" /><span>{T.lg_top}</span>
        <span className="sep" /><span className="badkey" /><span>{T.lg_bad}</span>
      </div>
    </section>
  );
}

function Hist({ s }: { s: State }) {
  const ge = s.ends[s.gen];
  const h = ge ? ge.blocks.histogram : s.liveHist;
  const keys = Object.keys(h).map(Number).sort((a, b) => a - b);
  const mx = Math.max(1, ...keys.map((k) => h[k] ?? 0));
  const ex = safeExplorer(s.hello?.explorer);
  return (
    <section className="panel">
      <Head n={2} title={T.blocks_title} sub={`${T.gen_word} ${s.gen - s.base + 1}${ge ? "" : " (" + T.live_word + ")"}`} />
      <div className="hist">
        {keys.map((k) => (
          <div key={k} className="hb"><span className="num hv">{fmt(h[k])}</span><div className="bar"><i style={{ transform: `scaleY(${(h[k] ?? 0) / mx})` }} /></div>
            <Lk href={ex ? `${ex}/block/${k}` : ""}>{String(k).slice(-4)}</Lk></div>
        ))}
        {!keys.length && <span className="cap">{T.blocks_wait}</span>}
      </div>
    </section>
  );
}

function Tape({ s }: { s: State }) {
  const ex = safeExplorer(s.hello?.explorer);
  return (
    <section className="panel tape">
      <Head n={3} title={T.tape_title} sub={T.tape_sub} />
      <div className="trows">
        {s.tape.map((t) => (
          <div key={t.key} className={"tr num " + t.kind}>
            <span className="tk">{t.kind === "eval" ? `g${t.gen}·${t.idx}` : t.kind === "confirm" ? T.kind_confirm : T.kind_sealed}</span>
            <span className="tv">{t.kind === "eval" ? (t.status !== "success" ? (T.st[t.status ?? ""] ?? t.status) : T.op[t.op ?? 0]) : `g${t.gen}·${t.idx}`}</span>
            <span className="tn">{t.status === "success" || t.kind !== "eval" ? sgn(t.value, 0) : "-"}</span>
            <span className="tb">{t.block ? <Lk href={ex ? `${ex}/block/${t.block}` : ""}>{fmt(t.block)}</Lk> : ""}</span>
            <Lk href={ex ? `${ex}/tx/${t.hash}` : ""}>{short(t.hash)}</Lk>
          </div>
        ))}
        {!s.tape.length && <span className="cap">{T.tape_wait}</span>}
      </div>
    </section>
  );
}

function Champion({ s }: { s: State }) {
  const lastEnd = s.ends[Math.max(0, ...Object.keys(s.ends).map(Number))];
  const sealed = s.sealed;
  const c = sealed ? { dev: sealed.dev, confirm: sealed.confirm, idx: sealed.idx, gen: sealed.gen, params: lastEnd?.archive.find((a) => a.gen === sealed.gen && a.idx === sealed.idx)?.params ?? [] }
    : lastEnd ? (() => { const t = lastEnd.archive[0] ?? { ...lastEnd.best, gen: lastEnd.gen }; const cf = s.confirms[`${t.gen}:${t.idx}`]; return { dev: t.dev, confirm: cf?.score, idx: t.idx, gen: t.gen, params: t.params }; })() : undefined;
  const sv = sealed?.score;
  const scale = Math.max(1, c?.dev ?? 0, c?.confirm ?? 0, sv ?? 0);
  const w = (v: number | undefined) => (v === undefined ? 0 : Math.max(0, Math.min(1, v / scale)) * 100);
  const sealedCls = sv === undefined ? "" : sv > 0 ? " pass" : " overfit";
  let verdict = "";
  if (c && c.dev > 0) {
    if (sv !== undefined) verdict = sv > 0 ? T.kept_sealed(fmt((sv / c.dev) * 100)) : T.kept_sealed_neg;
    else if (c.confirm !== undefined) verdict = T.kept_confirm(fmt((c.confirm / c.dev) * 100));
  }
  return (
    <section className="panel champ">
      <Head n={4} title={T.champ_title} sub={c ? `${T.gen_word} ${c.gen} #${c.idx}` : T.champ_none} />
      <div className="trio">
        <div><div className="lbl">{T.dev}</div><div className="big num">{sgn(c?.dev, 0)}</div><div className="meter"><i style={{ width: w(c?.dev) + "%" }} /></div><div className="cap">{T.dev_note}</div></div>
        <div><div className="lbl">{T.confirm}</div><div className="big num">{sgn(c?.confirm, 0)}</div><div className="meter"><i style={{ width: w(c?.confirm) + "%" }} /></div><div className="cap">{T.confirm_note}</div></div>
        <div className={"sealedcol" + sealedCls}><div className="lbl">{T.sealed}</div><div className={"big num" + (sealed ? "" : " unseen")}>{sealed ? sgn(sv, 0) : T.unseen}</div><div className="meter"><i style={{ width: w(sv) + "%" }} /></div><div className="cap">{T.sealed_note}</div></div>
      </div>
      {verdict && <p className={"verdict" + sealedCls}>{verdict}</p>}
      {c && c.params.length > 0 && <div className="spec num">{T.spec} [ {c.params.join("  ")} ]</div>}
    </section>
  );
}

function Curve({ s }: { s: State }) {
  const gens = Object.keys(s.ends).map(Number).sort((a, b) => a - b);
  const N = s.hello?.config.generations ?? Math.max(10, gens.length);
  const best = gens.map((g) => ({ g, v: s.ends[g]!.best.dev }));
  const bg = Object.keys(s.baselines).map(Number).sort((a, b) => a - b);
  const b1 = bg.map((g) => ({ g, v: s.baselines[g]!.b1 }));
  const b2 = bg.map((g) => ({ g, v: s.baselines[g]!.b2 }));
  const all = [...best, ...b1, ...b2].map((p) => p.v);
  const lo = Math.min(0, ...all), hi = Math.max(1, ...all);
  const W = 600, H = 205, P = { l: 52, r: 16, t: 14, b: 32 };
  const x = (g: number) => P.l + ((g - s.base) / Math.max(1, N - 1)) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - ((v - lo) / (hi - lo)) * (H - P.t - P.b);
  const path = (a: { g: number; v: number }[]) => a.map((p, i) => `${i ? "L" : "M"}${x(p.g).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const last = best[best.length - 1], l1 = b1[b1.length - 1], l2 = b2[b2.length - 1];
  const behind = last && l1 && l2 && last.v < Math.max(l1.v, l2.v);
  return (
    <section className="panel">
      <Head n={5} title={T.curve_title} sub={T.curve_sub} />
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={T.curve_title}>
        {[0, 0.5, 1].map((f) => { const v = lo + (hi - lo) * f; return <g key={f}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} className="gl" /><text x={P.l - 8} y={y(v) + 5} textAnchor="end" className="ax">{fmt(v)}</text></g>; })}
        {Array.from({ length: N }, (_, i) => i + s.base).filter((g) => g === s.base || (g - s.base + 1) % 2 === 0).map((g) => <text key={g} x={x(g)} y={H - 10} textAnchor="middle" className="ax">{g - s.base + 1}</text>)}
        <path d={path(b2)} className="ln l2" /><path d={path(b1)} className="ln l1" /><path d={path(best)} className="ln lp" />
        {last && <circle cx={x(last.g)} cy={y(last.v)} r="5.5" className="dot" />}
      </svg>
      <div className="key num">
        <span><i className="k kp" />{T.k_portfolio} {last ? sgn(last.v, 0) : ""}</span>
        <span><i className="k k1" />{T.k_r1} {l1 ? sgn(l1.v, 0) : ""}</span>
        <span><i className="k k2" />{T.k_r2} {l2 ? sgn(l2.v, 0) : ""}</span>
      </div>
      {behind && <p className="verdict overfit">{T.curve_behind}</p>}
    </section>
  );
}

const STY = ["reversion", "neutral", "momentum"] as const, ACT = ["low", "mid", "high"] as const;
function NicheMap({ s }: { s: State }) {
  const m = s.map;
  const devs = (m?.cells ?? []).map((c) => c.elite?.dev).filter((v): v is number => v !== undefined);
  const lo = Math.min(0, ...devs), hi = Math.max(1, ...devs);
  return (
    <section className="panel">
      <Head n={6} title={T.niche_title} sub={T.niche_sub} />
      <div className="nm">
        <span />{STY.map((x) => <span key={x} className="lbl ctr">{T.sty[x]}</span>)}
        {ACT.map((a) => (
          <React.Fragment key={a}>
            <span className="lbl">{T.act[a]}</span>
            {STY.map((st) => {
              const c = m?.cells.find((q) => q.style === st && q.activity === a);
              const idx = c?.elite ? stepIdx(c.elite.dev, lo, hi) : -1;
              return <div key={st} className={"nc " + (c?.elite ? "" : "empty")} style={c?.elite ? { background: SCALE[idx], color: idx >= 3 ? "#faf7f0" : "#1b1a17" } : undefined}>
                <b className="num">{c?.elite ? sgn(c.elite.dev, 0) : T.empty}</b><small>{c ? (T.lab[c.label] ?? c.label) : ""}</small></div>;
            })}
          </React.Fragment>
        ))}
      </div>
      <div className="cap ceil num">{m?.ceilingProxy ? T.ceiling(fmt(m.ceilingProxy.evals), sgn(m.ceilingProxy.dev, 0), sgn(m.ceilingProxy.confirm, 0), sgn(m.ceilingProxy.sealed, 0)) : T.ceiling_none}</div>
    </section>
  );
}

function Log({ s, model }: { s: State; model: string }) {
  const t = s.totals; const c = s.calib; const ex = safeExplorer(s.hello?.explorer);
  const items: [string, string, boolean][] = [[T.evals, fmt(t?.evals ?? 0), false], [T.reverted, fmt(t?.reverted ?? 0), (t?.reverted ?? 0) > 0], [T.lost, fmt(t?.lost ?? 0), (t?.lost ?? 0) > 0], [T.gas, fmt(t?.gasMon ?? 0, 3), false], [T.jev_spend, "$" + fmt(t?.jevUsd ?? s.judgeUsd, 4), false]];
  const worse = c ? c.brier > c.brierBaseline : false;
  return (
    <section className="panel log">
      <Head n={7} title={T.log_title} />
      <div className="counters">{items.map(([k, v, bad]) => <div key={k}><div className="lbl">{k}</div><div className={"mid num" + (bad ? " revert" : "")}>{v}</div></div>)}</div>
      <div className="twocol">
        <div>
          <div className="subh"><span className="lbl">{T.jev_title}</span><span className={"tag " + (model === "jev" ? "" : "amber")}>{model === "jev" ? T.model_jev : model === "none" ? T.model_none : T.model_standin}</span></div>
          {c ? <>
            <div className="cap">{T.authority[c.authority]}: {T.resolved(c.n, s.judges)}</div>
            <div className="brier">
              <span className="cap">{T.brier}</span><div className="bar2"><i style={{ width: `${Math.min(100, c.brier * 200)}%` }} /></div><b className="num">{fmt(c.brier, 3)}</b>
              <span className="cap">{T.brier_base}</span><div className="bar2"><i className="base" style={{ width: `${Math.min(100, c.brierBaseline * 200)}%` }} /></div><b className="num">{fmt(c.brierBaseline, 3)}</b>
            </div>
            <div className={"cap" + (worse ? " overfit" : "")}>{worse ? T.brier_worse : T.brier_better}</div>
          </> : <div className="cap">{T.jev_none}</div>}
        </div>
        <div>
          <div className="subh"><span className="lbl">{T.fund_title}</span></div>
          <div className="cap">{T.fund_note}</div>
          {!s.allocs.length ? <div className="cap">{T.fund_none}</div> : <>
            <div className="row2"><span>{T.fund_total}</span><b className="num">{s.funded?.total ?? "0"} test MON</b></div>
            {s.allocs.slice(0, 2).map((a) => <div key={a.txHash} className="row2 num cap"><span>{short(a.wallet)} {a.agent ? `${T.gen_word} ${a.agent.gen} #${a.agent.idx}` : T.pool}</span><Lk href={ex ? `${ex}/tx/${a.txHash}` : ""}>{a.amount}</Lk></div>)}
          </>}
        </div>
      </div>
    </section>
  );
}

function App() {
  const player = useMemo(() => pickSource(), []);
  const [lang, setLang] = useState<Lang>(pickLang);
  T = DICT[lang];
  const [s, dispatch] = useReducer(reduce, undefined, init);
  const [status, setStatus] = useState("starting");
  const [speed, setSpeed] = useState(1);
  const stop = useRef<(() => void) | undefined>();
  const begin = () => { stop.current?.(); dispatch({ type: "__reset" }); stop.current = player.start(dispatch, setStatus); };
  useEffect(() => { begin(); return () => stop.current?.(); }, []);
  useEffect(() => { document.documentElement.lang = lang === "zh" ? "zh-CN" : "en"; }, [lang]);
  const switchLang = (l: Lang) => {
    setLang(l);
    try { const u = new URL(location.href); u.searchParams.set("lang", l); history.replaceState(null, "", u); } catch { /* ignore */ }
  };
  const h = s.hello;
  const N = h?.config.generations;
  const model = s.judgeModel ?? h?.model ?? "none";
  const down = status === "reconnecting";
  const fixture = !!h && /invalid|synthetic/i.test(h.explorer ?? "");
  const stLabel: Record<string, string> = { connected: T.st_connected, reconnecting: T.st_reconnecting, "loading history": T.st_loading, "history unavailable": T.st_unavailable };
  const k = player.kind;
  const srcName = k === "replay" ? T.src_replay : k === "live" ? T.src_live : T.src_demo;
  const srcDetail = k === "replay" ? T.src_replay_d : k === "live" ? `${T.src_live_d} (${stLabel[status] ?? status})` : T.src_demo_d;
  return (
    <div className={"app " + lang}>
      <header>
        <div className="brand"><b>Blockwise</b><span className="cap">{T.tagline}</span></div>
        <div className={"src " + k + (down ? " down" : "")} role="status"><i className="dot" /><b>{srcName}</b><span>{srcDetail}{fixture ? " · " + T.src_synth : ""}</span></div>
        <div className="hstats">
          <div className="hstat"><span className="lbl">{T.block}</span><b className="num">{s.block ? fmt(s.block) : "-"}</b></div>
          <div className="hstat"><span className="lbl">{T.epoch}</span><b className="num">{h ? short(h.epoch) : "-"}</b></div>
          <div className="hstat"><span className="lbl">{T.generation}</span><b className="num">{s.count ? s.gen - s.base + 1 : "-"} / {N ?? "?"}</b></div>
        </div>
        <div className="ctl">
          <div className="seg" role="group" aria-label={T.language}>
            {(["en", "zh"] as Lang[]).map((l) => <button key={l} className={l === lang ? "on" : ""} aria-pressed={l === lang} onClick={() => switchLang(l)}>{l === "en" ? "EN" : "中文"}</button>)}
          </div>
          {player.setSpeed && <div className="seg" role="group" aria-label={T.speed}>
            {[1, 4, 16].map((x) => <button key={x} className={x === speed ? "on" : ""} aria-pressed={x === speed} onClick={() => { setSpeed(x); player.setSpeed!(x); }}>{x}x</button>)}
            <button onClick={begin}>{T.restart}</button>
          </div>}
        </div>
      </header>
      {down && <div className="banner">{T.banner_down}</div>}
      {s.errors[0] && <div className="banner">{s.errors[0]}</div>}
      <main>
        <div className="colA">
          <Plate s={s} />
          <div className="rowAB"><Hist s={s} /><Tape s={s} /></div>
          <Log s={s} model={model} />
        </div>
        <div className="colB"><Champion s={s} /><Curve s={s} /><NicheMap s={s} /></div>
      </main>
      <footer className="cap">{T.foot} {k === "demo" ? T.foot_demo : ""} {fixture ? T.foot_fixture : ""}</footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
