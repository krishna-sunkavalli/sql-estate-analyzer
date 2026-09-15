param([string]$Output = "$PSScriptRoot\calculator-prices.json")
$ErrorActionPreference = 'Stop'
$snapshot = Get-Content "$PSScriptRoot\prices.json" -Raw | ConvertFrom-Json
$miUrl = 'https://azure.microsoft.com/en-us/pricing/details/azure-sql-managed-instance/single/'
$licenseUrl = 'https://www.microsoft.com/en-us/sql-server/sql-server-2022-pricing'
$miHtml = (Invoke-WebRequest $miUrl -TimeoutSec 60).Content
$table = [regex]::Match($miHtml, '(?s)<table[^>]*aria-label="Standard-series \(Gen 5\)".*?</table>')
$row = [regex]::Match($table.Value, '(?s)<tbody>\s*(<tr>.*?</tr>)').Groups[1].Value
if ($row -notmatch '<td>\s*4\s*</td>') { throw 'MI pricing schema changed: expected 4-vCore row.' }
$miCells = @{}
foreach ($cell in [regex]::Matches($row, '(?s)<td[^>]*>.*?</td>')) {
    $amount = [regex]::Match($cell.Value, "data-amount='([^']+)'")
    if (-not $amount.Success) { continue }
    $classes = [regex]::Match($cell.Value, '<td class="([^"]+)"').Groups[1].Value.Split(' ')
    foreach ($name in @('webdirect-price','ahb-visible','one-year-savings','ahb-one-year-savings',
        'one-year-reserved','three-year-reserved','ahb-three-year-reserved')) {
        if ($classes -contains $name) { $miCells[$name] = $amount.Groups[1].Value | ConvertFrom-Json }
    }
}
if (-not $miCells['webdirect-price'] -or -not $miCells['ahb-visible']) { throw 'MI PAYG cells missing.' }

function Get-RetailItems([string]$Filter) {
    $url = 'https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=' + [uri]::EscapeDataString($Filter)
    do {
        $response = Invoke-RestMethod $url -TimeoutSec 90
        $response.Items
        $url = $response.NextPageLink
    } while ($url)
}
function Get-UniqueRate($Items, [string]$Label) {
    $values = @($Items | ForEach-Object { $_.retailPrice } | Sort-Object -Unique)
    if ($values.Count -ne 1 -or $values[0] -le 0) { throw "Missing or ambiguous price: $Label." }
    return [double]$values[0]
}
$licenseHtml = (Invoke-WebRequest $licenseUrl -TimeoutSec 60).Content
if ($licenseHtml -notmatch '\$15,123' -or $licenseHtml -notmatch '\$3,945') {
    throw 'Published SQL Server 2022 list prices changed; review license pack assumptions.'
}
$vmLicense = @{}
foreach ($edition in @('Standard','Enterprise')) {
    $filter = "serviceName eq 'Virtual Machines Licenses' and productName eq 'SQL Server $edition' and skuName eq '64 vCPU VM' and priceType eq 'Consumption'"
    $url = 'https://prices.azure.com/api/retail/prices?$filter=' + [uri]::EscapeDataString($filter)
    $items = (Invoke-RestMethod $url -TimeoutSec 60).Items
    $values = @($items | Where-Object { $_.unitOfMeasure -eq '1 Hour' -and $_.retailPrice -gt 0 } |
        ForEach-Object { $_.retailPrice / 64 } | Sort-Object -Unique)
    if ($values.Count -ne 1) { throw "Ambiguous or missing $edition SQL VM license meter." }
    $vmLicense[$edition.ToLowerInvariant()] = $values[0]
}
$regionMap = [ordered]@{
    eastus='us-east'; eastus2='us-east-2'; westus2='us-west-2'; westus3='us-west-3'
    centralus='us-central'; southcentralus='us-south-central'; northeurope='europe-north'
    westeurope='europe-west'; uksouth='united-kingdom-south'; francecentral='france-central'
    germanywestcentral='germany-west-central'; swedencentral='sweden-central'
    southeastasia='asia-pacific-southeast'; australiaeast='australia-east'
    japaneast='japan-east'; centralindia='central-india'; canadacentral='canada-central'; brazilsouth='brazil-south'
}
$regions = [ordered]@{}
foreach ($key in $regionMap.Keys) {
    $name = $regionMap[$key]
    $i = $miCells['webdirect-price'].regional.$name
    $b = $miCells['ahb-visible'].regional.$name
    $r = $snapshot.regions.$key
    if (-not $i -or -not $b -or -not $r) { throw "Missing price for $key ($name)." }
    $vmFilter = "serviceName eq 'Virtual Machines' and armRegionName eq '$key' and (productName eq 'Virtual Machines Ebdsv5 Series' or productName eq 'Virtual Machines Ebdsv5 Series Windows')"
    $vmItems = @(Get-RetailItems $vmFilter)
    $vmPlans = [ordered]@{}
    foreach ($size in @(4,8,16)) {
        $sku = "Standard_E${size}bds_v5"
        $linux = @($vmItems | Where-Object { $_.armSkuName -eq $sku -and $_.skuName -eq $sku -and $_.productName -eq 'Virtual Machines Ebdsv5 Series' -and $_.type -eq 'Consumption' -and $_.unitOfMeasure -eq '1 Hour' })
        $windows = @($vmItems | Where-Object { $_.armSkuName -eq $sku -and $_.skuName -eq $sku -and $_.productName -eq 'Virtual Machines Ebdsv5 Series Windows' -and $_.type -eq 'Consumption' -and $_.unitOfMeasure -eq '1 Hour' })
        $l = Get-UniqueRate $linux "$key $sku Linux"
        $w = Get-UniqueRate $windows "$key $sku Windows"
        if ($w -lt $l) { throw 'Windows license uplift is negative.' }
        $plans = [ordered]@{payg=$w}
        foreach ($term in @(@('1 Year','ri1',8760), @('3 Years','ri3',26280))) {
            $ri = @($vmItems | Where-Object { $_.armSkuName -eq $sku -and $_.skuName -eq $sku -and $_.productName -eq 'Virtual Machines Ebdsv5 Series' -and $_.type -eq 'Reservation' -and $_.reservationTerm -eq $term[0] -and $_.unitOfMeasure -eq '1 Hour' })
            if ($ri.Count) { $plans[$term[1]] = (Get-UniqueRate $ri "$key $sku $($term[0])") / $term[2] + ($w - $l) }
        }
        foreach ($term in @(@('1 Year','sp1'), @('3 Years','sp3'))) {
            $sp = @($linux | ForEach-Object { $_.savingsPlan } | Where-Object { $_.term -eq $term[0] })
            if ($sp.Count) { $plans[$term[1]] = (Get-UniqueRate $sp "$key $sku savings $($term[0])") + ($w - $l) }
        }
        $vmPlans[$sku] = @{
            rates=$plans; windowsLicensePerHour=($w-$l)
            meterIds=@(@($linux.meterId) + @($windows.meterId) | Sort-Object -Unique)
            filter=$vmFilter; reservationHours=@{ri1=8760;ri3=26280}
        }
        $r.vm.$sku.windows = $w
        $r.vm.$sku.linux = $l
    }
    $miPlans = [ordered]@{payg=@{included=$i/4; base=$b/4}}
    foreach ($term in @(@('sp1','one-year-savings','ahb-one-year-savings'), @('ri3','three-year-reserved','ahb-three-year-reserved'))) {
        $inc = $miCells[$term[1]].regional.$name
        $bas = $miCells[$term[2]].regional.$name
        if ($inc -gt 0 -and $bas -gt 0) { $miPlans[$term[0]] = @{included=$inc/4; base=$bas/4} }
    }
    $ri1 = $miCells['one-year-reserved'].regional.$name
    # Reservations exclude software charges; derive the absent RI1 AHB cell
    # by subtracting the same published PAYG SQL licensing component.
    if ($ri1 -gt ($i-$b)) { $miPlans['ri1'] = @{included=$ri1/4; base=($ri1-($i-$b))/4; baseDerived=$true} }
    $serverlessFilter = "serviceName eq 'SQL Database' and armRegionName eq '$key' and productName eq 'SQL Database General Purpose - Serverless - Compute Gen5' and skuName eq '1 vCore' and meterName eq 'vCore' and priceType eq 'Consumption'"
    $serverless = @(Get-RetailItems $serverlessFilter | Where-Object { $_.unitOfMeasure -eq '1 Hour' })
    $serverlessRate = Get-UniqueRate $serverless "$key serverless Gen5"
    if (-not $r.storage.mi_gp_per_gb_mo -or -not $r.storage.db_gp_per_gb_mo -or -not $r.storage.premium_ssd_lrs_per_disk_mo.P10) {
        throw "Missing storage prices for $key."
    }
    $regions[$key] = @{
        miBasePerCoreHour = $b / 4
        miIncludedPerCoreHour = $i / 4
        miPlans = $miPlans
        vmPlans = $vmPlans
        serverless = @{
            paygPerCoreHour=$serverlessRate
            meterIds=@($serverless.meterId | Sort-Object -Unique)
            filter=$serverlessFilter
            savingsPlanRates=@($serverless[0].savingsPlan)
            commitmentNote='Published savings-plan rates captured for reference, not modeled: hourly eligible usage/commitment sharing must be established separately.'
        }
        vm = $r.vm
        storage = $r.storage
    }
    Write-Output "Captured $key PAYG, reservations and available savings plans."
}
$result = [ordered]@{
    captured = (Get-Date).ToUniversalTime().ToString('o')
    infrastructureSnapshot = $snapshot.generated
    currency = 'USD'
    sql2022Pack = @{standard=3945; enterprise=15123}
    vmLicensePerCoreHour = $vmLicense
    sources = @{
        mi=$miUrl; onPremLicense=$licenseUrl; infrastructure='https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview'
        miTable='First Standard-series (Gen 5) table: classic General Purpose, first 4-vCore row; per-core rates divided by 4. Cells selected by exact class token, not position.'
        miRI1Base='Derived included RI1 minus (included PAYG - AHB PAYG); reservations do not discount SQL software.'
        reservations='https://learn.microsoft.com/en-us/azure/azure-sql/database/reservations-discount-overview'
        vmCommitments='Linux base reservation total / term hours or Linux savingsPlan hourly rate + unchanged Windows PAYG uplift; SQL licensing and storage separate.'
        serverless='https://learn.microsoft.com/en-us/azure/azure-sql/database/serverless-tier-billing'
        serverlessLimits='https://learn.microsoft.com/en-us/azure/azure-sql/database/resource-limits-vcore-single-databases'
    }
    regions = $regions
}
$result | ConvertTo-Json -Depth 12 | Set-Content $Output -Encoding UTF8
Write-Output "Built calculator prices for $($regions.Count) regions."
