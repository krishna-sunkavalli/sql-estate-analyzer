<#
  build.ps1 — assembles both published pages.

    /            the decision guide, static, no application JavaScript
    /analyzer/   the single-file analyzer, with the price snapshot inlined

  The guide is the front door because the first question is "which option fits",
  not "what does my estate cost". Both pages are fully self-contained: no external
  requests, no storage, no network calls at runtime.
#>

param(
  [string]$Root   = (Split-Path $PSScriptRoot -Parent),
  [string]$Output = $null
)

$ErrorActionPreference = 'Stop'
$build = $PSScriptRoot
if (-not $Output) { $Output = Join-Path $Root 'analyzer/index.html' }

$template = Get-Content (Join-Path $build 'app.template.html') -Raw -Encoding UTF8
$prices   = Get-Content (Join-Path $build 'prices.json')       -Raw -Encoding UTF8

$parts = @('app.part1.js','app.part2.js','app.part3.js') | ForEach-Object {
  $p = Join-Path $build $_
  if (-not (Test-Path $p)) { throw "Missing JS part: $p" }
  Get-Content $p -Raw -Encoding UTF8
}
$js = $parts -join "`n`n"

# Inject the price snapshot into the placeholder in part 1.
$pattern = '/\*__PRICES__\*/\{\}/\*__END_PRICES__\*/'
if ($js -notmatch $pattern) { throw 'Price placeholder not found in app.part1.js' }
$js = [regex]::Replace($js, $pattern, { param($m) $prices }, 1)

# Sanity: the bundle must have no external references or network/storage calls.
$violations = @()
if ($js -match '(?<![\w.])fetch\s*\(')                    { $violations += 'fetch()' }
if ($js -match 'XMLHttpRequest')                          { $violations += 'XMLHttpRequest' }
if ($js -match 'localStorage|sessionStorage|indexedDB')   { $violations += 'browser storage' }
if ($template -match '<script[^>]+src\s*=\s*["'']?(?:https?:)?//') { $violations += 'external <script src>' }
if ($template -match '<link[^>]+href\s*=\s*["'']?(?:https?:)?//')   { $violations += 'external <link>' }
if ($violations.Count) {
  throw "Bundle is not self-contained — found: $($violations -join ', ')"
}

# .Replace() is a literal string swap — unlike -replace it will not reinterpret
# $ sequences inside the JavaScript payload.
$html = $template.Replace('<!--APP_SCRIPT-->', "<script>`n$js`n</script>")

$outDir = Split-Path $Output -Parent
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
Set-Content -Path $Output -Value $html -Encoding UTF8
$kb = [math]::Round((Get-Item $Output).Length / 1KB, 1)
Write-Host "Built $Output ($kb KB)" -ForegroundColor Green

<#
  The decision guide, published at the site root.

  Derived from the same sources rather than maintained separately: the theme
  variables and boot script are lifted straight out of app.template.html and the
  content comes from guide.partial.html, so the landing page cannot drift from
  the product it links to. It carries no application JavaScript — the guide is
  static content and needs none.
#>
$styleMatch = [regex]::Match($template, '(?s)<style>(.*?)</style>')
if (-not $styleMatch.Success) { throw 'Could not extract <style> block for the guide' }
$css = $styleMatch.Groups[1].Value

$guidePartial = Join-Path $build 'guide.partial.html'
if (-not (Test-Path $guidePartial)) { throw "Missing guide partial: $guidePartial" }
$guideBody = Get-Content $guidePartial -Raw -Encoding UTF8

# The partial's closing call to action is a button; as a page it becomes a link.
$guideBody = [regex]::Replace(
  $guideBody,
  '<button class="primary" id="btnGuideBack">[^<]*</button>',
  '<a class="btn primary" href="analyzer/">Scan my estate &rarr;</a>')

$headMatch = [regex]::Match($template, '(?s)<head>(.*?)<style>')
$themeBoot = [regex]::Match($headMatch.Groups[1].Value, '(?s)<script>.*?</script>').Value
$favicon   = [regex]::Match($headMatch.Groups[1].Value, '<link rel="icon"[^>]*>').Value

$guidePage = @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Azure SQL modernization options &mdash; which one fits?</title>
<meta name="description" content="Choosing between SQL Server on Azure VM, Azure SQL Managed Instance, Azure SQL Database and serverless.">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0078d4">
$favicon
$themeBoot
<style>
$css
</style>
</head>
<body>
<div class="wrap">
  <header class="app">
    <div class="brand">
      <div class="mark">SQL</div>
      <div>
        <h1>Azure SQL modernization options</h1>
        <div class="sub">Which option fits, and why</div>
      </div>
    </div>
    <div class="spacer"></div>
    <a class="btn primary" href="analyzer/">Scan my estate</a>
    <button id="btnTheme" class="ghost" title="Toggle light/dark">&#9680;</button>
  </header>
  <section>
$guideBody
  </section>
</div>
<script>
  document.getElementById("btnTheme").onclick = () => {
    const d = document.documentElement;
    d.setAttribute("data-theme", d.getAttribute("data-theme") === "dark" ? "light" : "dark");
  };
</script>
</body>
</html>
"@

$guideOut = Join-Path $Root 'index.html'
Set-Content -Path $guideOut -Value $guidePage -Encoding UTF8
$gkb = [math]::Round((Get-Item $guideOut).Length / 1KB, 1)
Write-Host "Built $guideOut ($gkb KB)" -ForegroundColor Green

# The guide was briefly published at /sqlmodernizationoptions/. Keep that path
# alive so any link already shared still lands somewhere useful.
$legacyDir = Join-Path $Root 'sqlmodernizationoptions'
if (-not (Test-Path $legacyDir)) { New-Item -ItemType Directory -Path $legacyDir | Out-Null }
Set-Content -Path (Join-Path $legacyDir 'index.html') -Encoding UTF8 -Value @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Azure SQL modernization options</title>
<link rel="canonical" href="../">
<meta http-equiv="refresh" content="0; url=../">
</head>
<body><p>This page has moved to <a href="../">Azure SQL modernization options</a>.</p></body>
</html>
"@
Write-Host "Built $legacyDir\index.html (redirect)" -ForegroundColor DarkGray
