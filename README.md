# SQL Estate Analyzer

**▶ Open the analyzer: https://krishna-sunkavalli.github.io/sql-estate-analyzer/**

Upload a SQL Server inventory and get Azure target recommendations — Azure SQL
Database, Hyperscale, SQL Managed Instance, or SQL Server on Azure VM — with the
specific blocker behind every rejected option and costed scenarios across pricing
terms and Azure Hybrid Benefit.

Conceptually the SQL counterpart to
[RVTools Analyzer](https://azure.github.io/RVToolsAnalyzer/), but for database
estates rather than VMware inventory.

![SQL Estate Analyzer summary view](docs/img/shot-summary.png)

> **Your data never leaves your browser.** The page is a single static HTML file
> with no network calls, no storage APIs and no telemetry. Files you drop in are
> parsed in memory and discarded when you close the tab. Nothing is uploaded.
> A CI check on every commit fails the build if `fetch`, `XMLHttpRequest`,
> browser storage or any external `script`/`link` reference appears in the bundle.

---

## How to use it

**Whole estate, one command** — run the sweep and upload the single CSV it writes:

```powershell
# See what it finds, without querying anything
.\discovery\Invoke-SqlEstateDiscovery.ps1 -FromActiveDirectory -ListOnly

# Collect
.\discovery\Invoke-SqlEstateDiscovery.ps1 -FromActiveDirectory
```

**One instance, or no PowerShell** — run
[`discovery/SqlEstateDiscovery.sql`](discovery/SqlEstateDiscovery.sql) in SSMS,
right-click the grid → *Save Results As…* → CSV. Upload as many of those as you
like together.

Either way, open the [analyzer](https://krishna-sunkavalli.github.io/sql-estate-analyzer/)
and drop the files in. No install, no sign-in, no agent. Works offline — use
**Save Page As** if you need to run it on a disconnected network.

Prefer to fill in data by hand? Use
[`templates/SqlEstateInventory-Template.csv`](templates/SqlEstateInventory-Template.csv).

The analyzer accepts CSV, TSV and XLSX and auto-detects column names. Anything it
cannot match can be mapped on the **Column mapping** tab, so inventories from
Azure Migrate, MAP Toolkit or a hand-built spreadsheet work too.

Want to see it first? Load [`samples/sample-localdb.csv`](samples/sample-localdb.csv).

## Sweeping the estate

`Invoke-SqlEstateDiscovery.ps1` runs the discovery script against every instance
in one pass and merges the results. It needs **no PowerShell modules** — just
`System.Data.SqlClient` and ADSI, both present in Windows PowerShell 5.1 and
PowerShell 7. Under PowerShell 7 instances are queried in parallel.

It writes two files:

| File | Contents |
|---|---|
| `SqlEstateInventory-<timestamp>.csv` | One row per database, every instance — upload this |
| `SqlEstateInventory-<timestamp>-log.csv` | Per-instance status, row count, duration and failure reason |

### Finding the instances

| Source | Switch | Notes |
|---|---|---|
| Active Directory | `-FromActiveDirectory` | Finds every SQL Server by its `MSSQLSvc` SPN. Any authenticated domain user can read SPNs — no elevated rights, no RSAT. Disabled computer accounts are skipped. |
| Central Management Server | `-FromCentralManagementServer CMS01` | Reads the registered server list from the CMS `msdb`. |
| A list you already have | `-InputFile .\servers.txt` | One instance per line, or a CSV with an `Instance` / `ServerInstance` / `ServerName` column. |
| Named directly | `-Instance SQLPROD01,SQLPROD02\FIN` | |

`-ListOnly` resolves the target list and stops — always worth running first.

SPN discovery finds instances that have a Kerberos SPN registered, which covers
the large majority. Instances running under a domain account whose SPN was never
registered will not appear, so reconcile against a CMS or CMDB list if you need
completeness.

### Other options

```
-Credential           SQL authentication (Windows auth is the default)
-ThrottleLimit 16     parallel instances, PowerShell 7 only (default 8)
-ConnectTimeoutSec    default 8 — lower it when sweeping a list full of dead hosts
-QueryTimeoutSec      default 120
-Encrypt              force an encrypted connection
-TrustServerCertificate
-OutputPath           default .\SqlEstateInventory-<timestamp>.csv
```

Instances that fail are logged and the sweep continues. To retry just those, feed
the failures back in with `-InputFile`.

Permissions needed on each instance: `VIEW SERVER STATE` and `VIEW ANY DEFINITION`
(sysadmin is simplest).

## What the discovery script collects

Versions, editions, core and memory counts, database sizes, compatibility levels,
I/O rates, and feature flags (FILESTREAM, In-Memory OLTP, CLR, Service Broker,
cross-database dependencies, replication, and so on) plus instance-scope signals
(Agent jobs, linked servers, SSIS, SSRS, clustering, availability groups).

It is strictly read-only and collects **no schema, no data, no object names and no
query text** — safe to hand to a DBA for review before running.

Requires SQL Server 2012 or later and `VIEW SERVER STATE` + `VIEW ANY DEFINITION`.

## How recommendations are made

Each database is tested against a rule set of features unsupported on specific
Azure targets. The analyzer picks the **most managed platform with no violations**
— SQL Database, then Managed Instance, then SQL Server on Azure VM — and always
shows the blocker behind each rejected option, so the recommendation is auditable
rather than a black box.

Hyperscale is proposed only above the 4 TB single-database limit. Business Critical
is selected where the source uses In-Memory OLTP, is clustered, participates in an
availability group, or runs Enterprise edition in production.

Managed Instance and SQL-on-VM are instance-level products, so databases from the
same source instance are consolidated onto one deployment and share its compute
cost rather than each being billed a full instance.

## Pricing

Compute, storage and reservation rates come from the public
[Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices),
snapshotted at build time across 18 regions.

That API publishes only the *base* rate for Azure SQL PaaS — the rate that already
assumes Azure Hybrid Benefit. The SQL Server licence component, and SQL Server
licences on Azure VM, are not exposed by the API, so they are carried as visible,
editable assumptions on the **Assumptions** tab. That is also the more useful
design: most enterprise customers have negotiated rates rather than list.

Prices are indicative and for planning only — always confirm with the
[Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/) or your
Microsoft account team before committing to a number.

## Limitations worth stating up front

- Sizing is inferred from inventory signals; it cannot see query patterns, peak
  concurrency or application behaviour.
- Ring-buffer CPU covers roughly the last four hours, so it is indicative only.
  Where real perfmon history exists, prefer it and override the headroom setting.
- The on-premises comparison covers SQL Server SA and ESU (plus optional hardware)
  — not datacentre, power, storage-array or staffing costs. Real-world savings are
  therefore usually understated.
- Networking, egress, Defender for SQL, Purview and migration effort are excluded.

## Repository layout

| Path | Purpose |
|---|---|
| `index.html` | The built, self-contained app served by GitHub Pages |
| `discovery/` | Estate sweep (`Invoke-SqlEstateDiscovery.ps1`) and the read-only T-SQL script it runs |
| `templates/` | Blank CSV inventory template |
| `samples/` | Example inventory (CSV and XLSX) |
| `src/` | Source: HTML template, JS parts, price puller, build script |

### Building locally

```powershell
pwsh ./src/pull-prices.ps1    # optional: re-query the Azure Retail Prices API
pwsh ./src/build.ps1          # regenerate index.html
```

`build.ps1` fails if the bundle picks up an external reference, `fetch`,
`XMLHttpRequest` or a browser-storage call. Never hand-edit `index.html` — edit
the parts in `src/` and rebuild.

## Disclaimer

This is a personal project provided as-is under the MIT licence. It is not an
official Microsoft product, is not supported by Microsoft, and its output is not a
commitment on pricing, supportability or migration outcome.
