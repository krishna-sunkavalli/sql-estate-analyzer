# SQL Modernization on Azure

Two pages, both fully client-side and self-contained.

**Cost Estimator:** https://krishna-sunkavalli.github.io/sql-modernization-azure/

Compares the cost of renewing SQL Server on-premises against one chosen Azure
target, using published Microsoft list prices.

**Deployment Options:** https://krishna-sunkavalli.github.io/sql-modernization-azure/modernization-options/

Which offering fits, and what you still configure inside it.

**Local preview:** http://127.0.0.1:8793/ (when the local server is running).

Enter Standard cores, Enterprise cores, the same migration percentage for both
editions, region, optional SQL Azure Hybrid Benefit (AHB) and one discount
percentage (default 0). Select **Calculate
options**. No customer query, scan, upload, sign-in or application tier is involved.

## Four alternatives

| Alternative | Scope |
|---|---|
| Stay on-premises | All original workload cores remain |
| SQL Server on Azure VM | Selected footprint moves to Windows Ebdsv5; remainder stays on-premises |
| SQL Managed Instance GP | Selected footprint moves to classic General Purpose Gen5; remainder stays on-premises |
| Azure SQL Database serverless | Optional, illustrative GP Gen5 database estimate for the selected migrating footprint; remainder stays on-premises |

Each available alternative shows recurring monthly cost (amortized for commitments),
the separate one-time SQL purchase, three-year cost including that purchase,
monthly and three-year dollar differences from on-premises, and the three-year
percentage difference. A zero three-year baseline makes the percentage unavailable,
not infinite savings. Incomplete serverless inputs and unsupported rates show
**Input needed** or **Unavailable**, never a zero total.

These are conditional planning scenarios, not workload compatibility, licensing
entitlement evidence, an exact deployment topology or a binding quote.

## Simple form and explicit license-refresh scenario

The main form has core counts, migration percentage, region, AHB and a single
discount field. Purchase basis, operations, sizing, storage and commitment
choices are in collapsed advanced assumptions; serverless has its own optional
collapsed section. There are **no annual SA renewal estimates or amount inputs**.

- **Default: license-refresh scenario.** A visible notice states that a planned
  one-time SQL replacement purchase is modeled over three years. This is not an
  annual renewal or an undisclosed recharge of existing historical purchases.
- **Published SQL Server 2022 list prices:** $3,945 Standard and $15,123 Enterprise
  per two-core pack, from Microsoft's linked pricing page. These are explicitly
  versioned public reference prices, not annual SA rates or a current contract
  quote. Pack counts round up separately by edition.
- **Allocation:** on-premises buys for the full input footprint. Each Azure
  alternative buys only for the retained on-premises footprint. Migrated Azure
  deployments pay license-included service rates unless conditionally AHB-covered.
  With AHB, the model assumes *separate eligible existing migrated rights* are
  already available and reassignable; the reduced refresh purchase does not
  create free new licenses or free SA. Retained rights are not reused.
- **Existing-license mode:** select it in advanced assumptions when no future
  license refresh is planned. It excludes sunk purchases in every alternative.
- **Discount:** default 0%, range 0–100%. The same assumed commercial discount
  applies to one-time Microsoft SQL license purchases and selected Azure compute,
  SQL licensing and storage charges. It does **not** reduce on-premises operations.
  If RI/SP is chosen, it applies additionally to the actual published selected
  rate, explicitly labeled an extra unverified commercial assumption, not an
  automatic RI saving or guaranteed stack. No blanket RI discount is invented.
- **Math:** purchase = `(ceil(Standard/2) × 3945 + ceil(Enterprise/2) × 15123)
  × (1 − discount/100)` using full counts for baseline, retained counts for Azure.
  Recurring monthly = on-premises operations + selected Azure charges after
  discount. Three-year total = purchase + 36 × recurring monthly.
- **Ongoing SA/subscription fees are excluded**, not free or eliminated. There
  is no verified public renewal rate here. All comparisons are partial cost,
  not full TCO or guaranteed savings; AHB requires ongoing eligibility.
- **AHB is optional and off by default.** It
  assumes independently verified eligible licenses with active SA or a qualifying
  subscription that can be reassigned. Input core counts are not proof of rights.
  The model does not inspect contracts or establish license eligibility.
- Only migrated existing rights can cover Azure deployments: Standard 1:1 and Enterprise
  4:1 for MI GP; same-edition 1:1 for VM. Only fully covered reference deployments
  receive AHB. Rights retained on-premises are never reused. Licensing conversion
  ratios never reduce compute demand. Serverless gets no AHB.

## Operations, sizing and storage

- **On-premises operations:** $450 per original core/year, or $37.50/month.
  Excludes unmodeled ongoing SA/subscription fees.
- **Avoidable share:** 50% by default, adjustable 0–100%. The alternative's
  operations cost is `baseline operations × (1 − avoidable share × actual moved
  cores / original cores)`. Fixed costs remain, including at 100% migration.
  Setting operations to zero explicitly excludes them and is not full TCO.
- **Right-sizing:** default 20%, adjustable 0–60%, for VM/MI only. Not measured.
- **Migration rounding:** apply the same percentage to each edition and round
  moved cores down; right-sized demand rounds up; pack editions separately into
  whole 4/8/16-core reference deployments. This is illustrative consolidation,
  not exact topology or proof of appropriate per-host licensing.
- **Storage:** enter total migrated data GB, shared evenly. VM includes one
  128 GB P10 OS disk per VM plus rounded Premium SSD data disks. Unspecified VM
  data storage is visibly omitted. MI reserves at least 32 GB per instance in
  32 GB increments, subject to modeled classic GP limits (2 TB at 4 vCores;
  8 TB at 8/16). Oversized MI configurations show unavailable.
- Memory, IOPS, HA/DR replicas, feature readiness and individual workload
  placement are not inferred. Physical-host, unlimited-virtualization and other
  licensing rules require independent review.

## Optional serverless estimate

Enable the optional estimate, supply the **actual migrating database count**
(unset by default), and enter total migrated data storage. Count and storage apply
to the selected migrating footprint, not the full estate; recheck them whenever
migration scope changes. Core totals do not infer database count or size serverless.

The count and chosen per-database capacity are assumed to serve the entire selected
footprint. This full-footprint equivalence and equal storage allocation are
unverified assumptions, not feature/readiness or performance conclusions.

- Conservative GP Gen5 subset: maximum 2, 4 or 8 vCores (default 8).
  Minimum default 1; allowed minimum starts at 0.5 for max 2/4 and 1 for max 8,
  with 0.5 increments up to the maximum.
- **Assumed billable vCores while online:** default 2, bounded by the configured
  maximum and memory-normalized billing minimum. Billing is the maximum of CPU
  demand, memory demand / 3 GB and provisioned minima. At configured min 0.5,
  minimum billable compute is 2.05/3 vCores for max 2, or 0.7 for max 4.
  This input is declared, not measured average CPU.
- **Active-use percentage:** default 25%, meaning all billable online time,
  including idle auto-pause delay. Use 100% if pausing is not possible.
  Only eligible General Purpose databases auto-pause; some features prevent it.
- Compute = `database count × assumed billable vCores × 730 × active-use fraction
  × published PAYG hourly rate × (1 − discount/100)`. Storage is charged all
  month, even while paused, with the same entered discount.
- Conservative storage range: 1–1,024 GB reserved per database, rounded up to
  whole GB. Larger configurations require separate assessment.
- Serverless is **PAYG only in this calculator**, with no AHB or reservations.
  Published database savings-plan rates are captured as provenance but not
  applied: intermittency requires hourly eligible-usage and commitment-sharing
  analysis. Multiplying average active time by a savings-plan rate alone would
  hide unused commitments. No universal savings claim is made.

At zero migrated cores, all four alternatives equal on-premises; no database
inputs are required because no Azure workload is modeled.

## Published pricing and commitment scope

The refreshed snapshot covers **18 regions**, three reference VM sizes and:

- VM PAYG, 1/3-year reservations, 1/3-year compute savings plans.
- MI GP PAYG, 1/3-year reservations and the verified 1-year database savings plan.
  The 3-year MI savings-plan option is explicitly unavailable in this snapshot;
  it is not a claim that the product can never offer it.
- Serverless GP Gen5 PAYG, plus published savings-plan metadata for reference.

No blanket commitment discounts are invented. Only one plan is selected per
scenario; RI and savings plans never stack on the same usage. The optional
commercial discount is a separate explicit assumption applied after rate selection.

VM reservations use the exact regional Ebdsv5 Linux infrastructure term price,
divided by 8,760 / 26,280 hours, plus the unchanged Windows PAYG license uplift.
VM savings plans use the retail API's Linux `savingsPlan` hourly rate plus that
uplift. SQL VM licensing remains at PAYG ($0.10 Standard / $0.375 Enterprise per
core-hour unless conditionally AHB-covered), as does storage, before the optional
commercial discount. No Windows AHB.

MI prices come from the first **Standard-series (Gen 5)** table (classic GP),
first 4-vCore row on the official pricing page, divided by four. The extractor
uses exact cell class tokens, **not sequential price order**, because headers
and cells differ:

| Cell class | Rate |
|---|---|
| `webdirect-price` | PAYG included |
| `ahb-visible` | PAYG base |
| `one-year-savings` | Savings plan 1-year included |
| `ahb-one-year-savings` | Savings plan 1-year base |
| `one-year-reserved` | Reservation 1-year included |
| `three-year-reserved` | Reservation 3-year included |
| `ahb-three-year-reserved` | Reservation 3-year base |

The absent MI RI1 base cell is derived as included RI1 minus
`(included PAYG − base PAYG)`: reservation discounts exclude SQL software.
For example, East US per-core PAYG included/base are 0.252184/0.152218;
RI1 included/base 0.198936/0.09897; RI3 0.168456/0.06849;
SP1 0.20174/0.12177 USD/hour. Tests pin these values to detect class mix-ups.

VM/MI commitments assume **100% hourly utilization**. Monthly figures amortize
the entire commitment, not just active usage. Three-year projections assume
1-year terms are purchased again at unchanged prices; actual renewal is not
automatic and future rates are not guaranteed. Unused commitment costs can
erase apparent savings.

### Sources

- [Microsoft SQL Server 2022 license list](https://www.microsoft.com/en-us/sql-server/sql-server-2022-pricing)
- [MI pricing](https://azure.microsoft.com/en-us/pricing/details/azure-sql-managed-instance/single/)
- [Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
  using `api-version=2023-01-01-preview`, exact region/product/SKU filters,
  `Reservation` term records and `savingsPlan` properties.
- [Reservation scope](https://learn.microsoft.com/en-us/azure/azure-sql/database/reservations-discount-overview)
- [AHB eligibility](https://learn.microsoft.com/en-us/azure/azure-sql/azure-hybrid-benefit?view=azuresql)
- [Serverless billing](https://learn.microsoft.com/en-us/azure/azure-sql/database/serverless-tier-billing?view=azuresql)
- [Serverless limits](https://learn.microsoft.com/en-us/azure/azure-sql/database/resource-limits-vcore-single-databases?view=azuresql)

Snapshot dates are displayed in the calculator. VM/MI/serverless/license rates
are refreshed from public sources; storage is imported from the existing
`prices.json` snapshot, with its separate date. Query filters, meter IDs, rate
derivations and sources are retained in `calculator-prices.json`. Rates are
embedded at build time; nothing is requested at runtime. Missing required PAYG
rates stop calculation rather than producing free resources.

Excluded: ongoing SA/subscription fees, application tier, ESU, migration work,
networking, extra backup storage, DR, security services, taxes and free allowances.
Any entered commercial discount is hypothetical, not a verified negotiated quote.
These comparisons are not full TCO.

## Source and validation

| Path | Purpose |
|---|---|
| `src/calculator.js` | Pure cost model, one-time refresh/discount math, form/results |
| `src/calculator.template.html` | Four-alternative calculator UI |
| `src/calculator-prices.json` | Published price snapshot and provenance |
| `src/pull-calculator-prices.ps1` | Refresh VM/MI/serverless/license rates; import existing storage |
| `src/guide.partial.html` | Existing static modernization guide, unchanged |
| `src/build.ps1` | Build calculator, guide and legacy redirect |
| `src/calculator.test.js` | Model/pricing regression tests |

```powershell
# Optional public price refresh
pwsh .\src\pull-prices.ps1
pwsh .\src\pull-calculator-prices.ps1

node --test .\src\calculator.test.js
pwsh .\src\build.ps1
```

Never edit generated pages directly. CI runs the model tests, checks self-contained
pages and compares fresh build output. Tests cover zero/partial/full migration,
refresh versus sunk purchases, pack rounding, discounts, avoidable/fixed costs,
AHB with no retained-rights reuse, plan scopes,
serverless missing inputs and billing bounds, monetary/percentage deltas, and
all captured region/size/plan/AHB combinations.

Legacy scanner sources and discovery scripts remain but are not invoked. The
modernization guide and original renewal skill are not substantively modified.

## Disclaimer

Personal project, provided as-is under MIT. Not an official Microsoft product,
licensing determination, supportability certification or binding quote.
