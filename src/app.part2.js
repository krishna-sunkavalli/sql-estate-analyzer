/* =============================================================================
   Part 2 — parsing, state, rendering, export
   ============================================================================= */

/* ---------------------------------------------------------------------------
   7. CSV / Excel parsing (no external libraries)
   --------------------------------------------------------------------------- */
function parseDelimited(text) {
  // Strip BOM and normalise line endings.
  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Sniff the delimiter from the header line, ignoring quoted sections.
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const counts = { ",": 0, "\t": 0, ";": 0, "|": 0 };
  let q = false;
  for (const ch of firstLine) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  const delim = Object.keys(counts).reduce((a, b) => counts[a] >= counts[b] ? a : b);

  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === delim) {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      if (row.some(x => x.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(x => x.trim() !== "")) rows.push(row);
  if (!rows.length) return { headers: [], records: [] };

  const headers = rows[0].map(h => h.trim());
  const records = rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    return o;
  });
  return { headers, records };
}

/* Minimal XLSX reader: unzips via DecompressionStream and reads the first sheet. */
async function parseXlsx(buf) {
  const files = await unzip(new Uint8Array(buf));
  const dec = new TextDecoder();
  const getText = (name) => files[name] ? dec.decode(files[name]) : null;

  // Shared strings
  const shared = [];
  const ss = getText("xl/sharedStrings.xml");
  if (ss) {
    const doc = new DOMParser().parseFromString(ss, "application/xml");
    for (const si of doc.getElementsByTagName("si")) {
      let s = "";
      for (const t of si.getElementsByTagName("t")) s += t.textContent;
      shared.push(s);
    }
  }

  // Resolve the first sheet's target path via the workbook relationships.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const wb = getText("xl/workbook.xml"), rels = getText("xl/_rels/workbook.xml.rels");
  if (wb && rels) {
    const wbDoc = new DOMParser().parseFromString(wb, "application/xml");
    const relDoc = new DOMParser().parseFromString(rels, "application/xml");
    const first = wbDoc.getElementsByTagName("sheet")[0];
    const rid = first?.getAttribute("r:id") || first?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    if (rid) {
      for (const rel of relDoc.getElementsByTagName("Relationship")) {
        if (rel.getAttribute("Id") === rid) {
          let t = rel.getAttribute("Target").replace(/^\//, "");
          sheetPath = t.startsWith("xl/") ? t : "xl/" + t;
        }
      }
    }
  }
  const sheet = getText(sheetPath);
  if (!sheet) throw new Error("Could not read the first worksheet from this workbook.");

  const doc = new DOMParser().parseFromString(sheet, "application/xml");
  const grid = [];
  for (const rowEl of doc.getElementsByTagName("row")) {
    const cells = [];
    for (const c of rowEl.getElementsByTagName("c")) {
      const ref = c.getAttribute("r") || "";
      const col = colIndex(ref.replace(/\d+/g, ""));
      const type = c.getAttribute("t");
      let val = "";
      if (type === "inlineStr") {
        const isEl = c.getElementsByTagName("is")[0];
        if (isEl) for (const t of isEl.getElementsByTagName("t")) val += t.textContent;
      } else {
        const v = c.getElementsByTagName("v")[0];
        if (v) val = (type === "s") ? (shared[parseInt(v.textContent, 10)] ?? "") : v.textContent;
      }
      cells[col] = val;
    }
    grid.push(cells);
  }
  const nonEmpty = grid.filter(r => r && r.some(x => String(x ?? "").trim() !== ""));
  if (!nonEmpty.length) return { headers: [], records: [] };

  const width = Math.max(...nonEmpty.map(r => r.length));
  const headers = [];
  for (let i = 0; i < width; i++) headers.push(String(nonEmpty[0][i] ?? "").trim() || `Column${i + 1}`);
  const records = nonEmpty.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = String(r[i] ?? "").trim(); });
    return o;
  });
  return { headers, records };
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ZIP reader (stored + deflate) using the browser's DecompressionStream. */
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Locate End Of Central Directory.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx file (no ZIP directory found).");

  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);
  const out = {};

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break;
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOff = dv.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));

    // Re-read the local header: its extra-field length can differ from central.
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    if (method === 0) {
      out[name] = raw;
    } else if (method === 8) {
      const ds = new DecompressionStream("deflate-raw");
      const ab = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
      out[name] = new Uint8Array(ab);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ---------------------------------------------------------------------------
   8. State
   --------------------------------------------------------------------------- */
const S = {
  rawHeaders: [],
  rawRecords: [],
  map: {},
  rows: [],
  instances: [],
  filter: "all",
  search: "",
  sort: { key: "sizeGb", dir: -1 },
  loadErrors: [],
};

function buildRows() {
  const m = S.map;
  const get = (rec, key) => m[key] ? rec[m[key]] : undefined;

  const rows = S.rawRecords.map((rec, idx) => {
    const f = {}, inst = {};
    for (const ft of FEATURES) f[ft.key] = truthy(get(rec, "f_" + ft.key));
    for (const it of INSTANCE_FIELDS) {
      const v = get(rec, "i_" + it.key);
      inst[it.key] = (it.key === "agentJobs" || it.key === "linkedServers" ||
                      it.key === "agCount" || it.key === "proxies") ? (numOf(v) ?? 0) : truthy(v);
    }

    let sizeGb = numOf(get(rec, "sizeGb"));
    // Tolerate an inventory that reports size in MB.
    if (sizeGb == null) {
      const data = numOf(get(rec, "dataGb")), log = numOf(get(rec, "logGb"));
      if (data != null || log != null) sizeGb = (data || 0) + (log || 0);
    }
    if (m.sizeGb && /mb$/i.test(m.sizeGb) && sizeGb != null) sizeGb = sizeGb / 1024;

    const server = String(get(rec, "server") || "").trim() || "(unknown)";
    const instance = String(get(rec, "instance") || "").trim();
    const r = {
      _i: idx,
      server, instance,
      instKey: instance && instance.toUpperCase() !== "MSSQLSERVER" ? `${server}\\${instance}` : server,
      database: String(get(rec, "database") || "").trim() || "(unnamed)",
      version: get(rec, "version") || "",
      productver: get(rec, "productver") || "",
      edition: get(rec, "edition") || "",
      cores: numOf(get(rec, "cores")),
      memoryGb: numOf(get(rec, "memoryGb")),
      sizeGb: sizeGb ?? 0,
      cpuPct: numOf(get(rec, "cpuPct")),
      peakCpuPct: numOf(get(rec, "peakCpuPct")),
      environment: get(rec, "environment") || "",
      compat: numOf(get(rec, "compat")),
      os: get(rec, "os") || "",
      application: get(rec, "application") || "",
      hasSA: get(rec, "hasSA"),
      f, i: inst,
      override: null,
    };
    r.major = majorFrom(r);
    r.support = supportState(r.major);
    return r;
  }).filter(r => r.database !== "(unnamed)" || r.sizeGb > 0);

  // Instance-scope signals apply to every database on that instance: if one row
  // reports SSIS or an Agent job, the whole instance carries that constraint.
  const byInst = {};
  for (const r of rows) (byInst[r.instKey] ||= []).push(r);
  for (const key in byInst) {
    const group = byInst[key];
    const agg = {};
    for (const it of INSTANCE_FIELDS) {
      const vals = group.map(g => g.i[it.key]);
      agg[it.key] = (typeof vals[0] === "number")
        ? Math.max(...vals.map(v => v || 0))
        : vals.some(Boolean);
    }
    for (const g of group) g.i = { ...g.i, ...agg };
  }

  for (const r of rows) {
    const ev = evaluateRow(r);
    r.blocked = ev.blocked; r.fired = ev.fired; r.rec = ev.rec;
  }

  S.rows = rows;
  S.instances = Object.keys(byInst).map(k => ({ key: k, rows: byInst[k] }));
}

function recompute() {
  computeEstate();
}

/* ---------------------------------------------------------------------------
   9. Rendering
   --------------------------------------------------------------------------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function kpi(label, value, opts = {}) {
  return `<div class="kpi ${opts.cls || ""}">
    <div class="lbl">${esc(label)}</div>
    <div class="val ${opts.sm ? "sm" : ""}">${value}</div>
    ${opts.foot ? `<div class="fnt">${opts.foot}</div>` : ""}
  </div>`;
}

function renderAll() {
  recompute();
  renderSummary(); renderTargets(); renderCost();
  renderRisk(); renderInventory(); renderMapping(); renderAssumptions();
}

function totals() {
  const t = { monthly: 0, compute: 0, storage: 0, license: 0, dbs: S.rows.length, sizeGb: 0, vcores: 0, deployments: 0 };
  const seen = new Set();
  for (const r of S.rows) {
    t.monthly += r.cost.total; t.compute += r.cost.compute;
    t.storage += r.cost.storage; t.license += r.cost.license;
    t.sizeGb += r.sizeGb || 0;
    // Shared deployments must be counted once, not once per database.
    if (r.cost.shared) {
      const key = r.instKey + "|" + r.cost.target + "|" + r.cost.tier;
      if (!seen.has(key)) { seen.add(key); t.vcores += r.cost.groupVcores; t.deployments++; }
    } else {
      t.vcores += r.cost.vcores; t.deployments++;
    }
  }
  return t;
}

function onPremTotals() {
  let yr = 0, sa = 0, esu = 0, hw = 0;
  for (const inst of S.instances) {
    const c = onPremInstanceCost(inst.rows);
    yr += c.totalYr; sa += c.saYr; esu += c.esuYr; hw += c.hwYr;
  }
  return { yr, sa, esu, hw, monthly: yr / 12 };
}

function renderSummary() {
  const t = totals();
  const op = onPremTotals();
  const counts = { sqldb: 0, hs: 0, mi: 0, vm: 0 };
  for (const r of S.rows) counts[r.cost.target]++;

  const eol = S.rows.filter(r => r.support.state === "eol" || r.support.state === "esu").length;
  const ending = S.rows.filter(r => r.support.state === "ending").length;
  const paasPct = S.rows.length ? (100 * (counts.sqldb + counts.hs + counts.mi) / S.rows.length) : 0;

  const delta = op.monthly - t.monthly;
  const deltaPct = op.monthly > 0 ? (100 * delta / op.monthly) : 0;

  const segs = [
    { k: "sqldb", c: "var(--cp-viz-1)" }, { k: "hs", c: "var(--cp-viz-2)" },
    { k: "mi", c: "var(--cp-viz-3)" }, { k: "vm", c: "var(--cp-viz-4)" },
  ];
  const stack = segs.filter(s => counts[s.k] > 0).map(s => {
    const pct = 100 * counts[s.k] / Math.max(1, S.rows.length);
    return `<div class="stack-seg" style="width:${pct}%;background:${s.c}" title="${TARGETS[s.k].name}: ${counts[s.k]}">${pct > 8 ? counts[s.k] : ""}</div>`;
  }).join("");

  $("#panel-summary").innerHTML = `
    <div class="kpis">
      ${kpi("Databases", FMT.num(t.dbs), { foot: `${S.instances.length} instance${S.instances.length === 1 ? "" : "s"}` })}
      ${kpi("Total size", FMT.gb(t.sizeGb))}
      ${kpi("Azure monthly", FMT.money(t.monthly), { cls: "accent", foot: `${FMT.money(t.monthly * 12)} / year` })}
      ${kpi("PaaS eligible", FMT.pct(paasPct), { cls: paasPct >= 60 ? "good" : "warn", foot: `${counts.sqldb + counts.hs + counts.mi} of ${t.dbs} databases` })}
      ${kpi("Out of support", FMT.num(eol), { cls: eol ? "bad" : "good", foot: ending ? `${ending} ending within 12 mo` : "—" })}
    </div>

    <div class="split">
      <div class="card">
        <h3>Recommended Azure targets</h3>
        <div class="stack-bar">${stack || '<div class="stack-seg" style="width:100%;background:var(--cp-border)"></div>'}</div>
        <div class="legend">
          ${segs.map(s => `<span><i style="background:${s.c}"></i>${TARGETS[s.k].name} — <b>${counts[s.k]}</b></span>`).join("")}
        </div>
        <div class="note">
          Targets follow a most-managed-first rule: a database only drops to a less managed
          option when a specific feature blocks the one above it. Open the
          <b>Recommendations</b> tab to see the blocker behind every rejected option.
        </div>
      </div>

      <div class="card">
        <h3>Azure vs staying on-premises <span class="hint">per month</span></h3>
        <table>
          <tbody>
            <tr><td>Azure — compute</td><td class="num">${FMT.money(t.compute)}</td></tr>
            <tr><td>Azure — storage</td><td class="num">${FMT.money(t.storage)}</td></tr>
            ${t.license > 0 ? `<tr><td>Azure — SQL licence</td><td class="num">${FMT.money(t.license)}</td></tr>` : ""}
            <tr><td><b>Azure total</b></td><td class="num"><b>${FMT.money(t.monthly)}</b></td></tr>
            <tr><td colspan="2" style="border-bottom:2px solid var(--cp-border)"></td></tr>
            <tr><td>On-prem — Software Assurance</td><td class="num">${FMT.money(op.sa / 12)}</td></tr>
            ${op.esu > 0 ? `<tr><td>On-prem — ESU <span class="pill red">out of support</span></td><td class="num">${FMT.money(op.esu / 12)}</td></tr>` : ""}
            ${op.hw > 0 ? `<tr><td>On-prem — hardware/hosting</td><td class="num">${FMT.money(op.hw / 12)}</td></tr>` : ""}
            <tr><td><b>On-prem total</b></td><td class="num"><b>${FMT.money(op.monthly)}</b></td></tr>
          </tbody>
        </table>
        <div class="note ${delta >= 0 ? "" : "warn"}">
          ${delta >= 0
            ? `Moving to Azure is <b>${FMT.money(Math.abs(delta))}/mo lower</b> (${FMT.pct(Math.abs(deltaPct))}) than the on-premises run-rate modelled here.`
            : `Azure is <b>${FMT.money(Math.abs(delta))}/mo higher</b> than the on-premises run-rate modelled here. Check the term and Hybrid Benefit settings on the Cost model tab.`}
          <br><span class="src-tag">The on-premises figure covers SQL Server SA/ESU only (plus optional hardware) — not datacentre, power, storage-array or staffing costs.</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Estate by instance</h3>
      <div class="tbl-wrap">
        <table>
          <thead><tr>
            <th class="nosort">Instance</th><th class="nosort">Version</th><th class="nosort">Edition</th>
            <th class="nosort num">Cores</th><th class="nosort num">DBs</th><th class="nosort num">Size</th>
            <th class="nosort">Support</th><th class="nosort">Targets</th><th class="nosort num">Azure $/mo</th>
          </tr></thead>
          <tbody>
            ${S.instances.map(inst => {
              const r0 = inst.rows[0];
              const size = inst.rows.reduce((a, r) => a + (r.sizeGb || 0), 0);
              const cost = inst.rows.reduce((a, r) => a + r.cost.total, 0);
              const tset = [...new Set(inst.rows.map(r => TARGETS[r.cost.target].short))];
              return `<tr>
                <td><b>${esc(inst.key)}</b></td>
                <td>${esc(r0.version || "—")}</td>
                <td>${esc(editionKind(r0.edition))}</td>
                <td class="num">${FMT.num(r0.cores)}</td>
                <td class="num">${inst.rows.length}</td>
                <td class="num">${FMT.gb(size)}</td>
                <td><span class="pill ${r0.support.cls}">${esc(r0.support.label)}</span></td>
                <td>${tset.map(x => `<span class="pill gray">${esc(x)}</span>`).join(" ")}</td>
                <td class="num">${FMT.money(cost)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div class="note warn">
      <b>Indicative analysis only.</b> Sizing is derived from the signals present in your inventory
      (cores, CPU, size and feature flags) and priced at public list rates for
      <b>${esc(A.region)}</b>. It does not reflect negotiated discounts, and it cannot see application
      behaviour, query patterns or peak concurrency. Treat this as a starting point for a
      detailed assessment, not a migration commitment.
    </div>`;
}

function renderTargets() {
  const rows = filtered();
  const counts = { all: S.rows.length, sqldb: 0, hs: 0, mi: 0, vm: 0 };
  for (const r of S.rows) counts[r.cost.target]++;

  $("#panel-targets").innerHTML = `
    <div class="chips">
      ${["all", "sqldb", "hs", "mi", "vm"].map(k =>
        `<button class="chip ${S.filter === k ? "on" : ""}" data-filter="${k}">
           ${k === "all" ? "All" : TARGETS[k].name} (${counts[k]})
         </button>`).join("")}
      <input type="search" id="searchBox" placeholder="Search database, server or app…" value="${esc(S.search)}" style="margin-left:auto;min-width:250px">
    </div>

    <div class="card">
      <h3>Per-database recommendation <span class="hint">${rows.length} shown · click a target to override</span></h3>
      <div class="tbl-wrap">
        <table id="targetTable">
          <thead><tr>
            <th data-sort="instKey">Instance</th>
            <th data-sort="database">Database</th>
            <th class="num" data-sort="sizeGb">Size</th>
            <th data-sort="rec">Recommended</th>
            <th class="nosort">Override</th>
            <th class="nosort">Why not the tier above</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => {
              const t = r.cost.target;
              const reasons = [];
              for (const k of ["sqldb", "mi"]) {
                if (k === t) break;
                if (r.blocked[k]?.length) reasons.push(`<b>${TARGETS[k].short}:</b> ${esc(r.blocked[k][0])}`);
              }
              return `<tr>
                <td>${esc(r.instKey)}</td>
                <td><b>${esc(r.database)}</b>${r.application ? `<br><span class="src-tag">${esc(r.application)}</span>` : ""}</td>
                <td class="num">${FMT.gb(r.sizeGb)}</td>
                <td><span class="pill ${t === "vm" ? "amber" : t === "mi" ? "accent" : "green"}">${TARGETS[t].short}</span>
                    <span class="src-tag"> ${r.cost.tier === "bc" && t !== "vm" && t !== "hs" ? "Business Critical" : ""}</span></td>
                <td>
                  <select data-override="${r._i}">
                    <option value="">Auto (${TARGETS[r.rec].short})</option>
                    ${Object.keys(TARGETS).map(k =>
                      `<option value="${k}" ${r.override === k ? "selected" : ""}>${TARGETS[k].short}${r.blocked[k]?.length ? " ⚠" : ""}</option>`).join("")}
                  </select>
                </td>
                <td class="wrap-cell">${reasons.length ? reasons.join("<br>") : '<span class="src-tag">No blockers — most managed option available</span>'}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      ${rows.length === 0 ? '<div class="empty">No databases match this filter.</div>' : ""}
    </div>

    <div class="card">
      <h3>Blockers across the estate</h3>
      ${(() => {
        const tally = {};
        for (const r of S.rows) for (const f of r.fired) {
          (tally[f.id] ||= { why: f.why, n: 0, dbs: [] });
          tally[f.id].n++; tally[f.id].dbs.push(r.database);
        }
        const list = Object.entries(tally).sort((a, b) => b[1].n - a[1].n);
        if (!list.length) return '<div class="empty">No migration blockers detected in this estate.</div>';
        return list.map(([id, v]) => `
          <details class="acc">
            <summary>${esc(v.why)} <span class="pill amber">${v.n} database${v.n === 1 ? "" : "s"}</span></summary>
            <div style="font-size:12.5px;color:var(--cp-text-muted)">${v.dbs.slice(0, 40).map(esc).join(", ")}${v.dbs.length > 40 ? ` … +${v.dbs.length - 40} more` : ""}</div>
          </details>`).join("");
      })()}
    </div>`;

  $$("[data-filter]").forEach(b => b.onclick = () => { S.filter = b.dataset.filter; renderTargets(); });
  const sb = $("#searchBox");
  if (sb) sb.oninput = debounce(() => { S.search = sb.value; renderTargets(); sb.focus(); }, 220);
  $$("[data-override]").forEach(sel => sel.onchange = () => {
    const r = S.rows.find(x => x._i === +sel.dataset.override);
    r.override = sel.value || null;
    recompute(); renderTargets(); renderSummary(); renderCost();
  });
  wireSort("#targetTable", renderTargets);
}

function filtered() {
  let rows = S.rows;
  if (S.filter !== "all") rows = rows.filter(r => r.cost.target === S.filter);
  if (S.search.trim()) {
    const q = S.search.toLowerCase();
    rows = rows.filter(r => (r.database + " " + r.instKey + " " + r.application + " " + r.version).toLowerCase().includes(q));
  }
  const { key, dir } = S.sort;
  return [...rows].sort((a, b) => {
    const av = a[key] ?? "", bv = b[key] ?? "";
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

function wireSort(sel, rerender) {
  $$(`${sel} th[data-sort]`).forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : -1 };
    rerender();
  });
}

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
