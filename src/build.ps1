<#
  build.ps1 — assembles the single-file SQL Estate Analyzer.

  Injects the Azure price snapshot and concatenates the JS parts into
  app.template.html, producing a fully self-contained HTML file with no
  external requests, no storage and no network calls at runtime.
#>

param(
  [string]$Root   = (Split-Path $PSScriptRoot -Parent),
  [string]$Output = $null
)

$ErrorActionPreference = 'Stop'
$build = $PSScriptRoot
if (-not $Output) { $Output = Join-Path $Root 'index.html' }

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
if ($template -match '<script[^>]+src=')                  { $violations += 'external <script src>' }
if ($template -match '<link[^>]+href=')                   { $violations += 'external <link>' }
if ($violations.Count) {
  throw "Bundle is not self-contained — found: $($violations -join ', ')"
}

# .Replace() is a literal string swap — unlike -replace it will not reinterpret
# $ sequences inside the JavaScript payload.
$html = $template.Replace('<!--APP_SCRIPT-->', "<script>`n$js`n</script>")

Set-Content -Path $Output -Value $html -Encoding UTF8
$kb = [math]::Round((Get-Item $Output).Length / 1KB, 1)
Write-Host "Built $Output ($kb KB)" -ForegroundColor Green
