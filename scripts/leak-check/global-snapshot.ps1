# Snapshot of this computer's network-wide settings, to show a Vela Browser run changed none of them.
#
#   powershell -File scripts/leak-check/global-snapshot.ps1 -Out before.json
#   ... run Vela Browser profiles ...
#   powershell -File scripts/leak-check/global-snapshot.ps1 -Out after.json -Compare before.json
#
# Covered: the user's system proxy (WinINet), WinHTTP proxy, the IPv4/IPv6 routing tables, network
# adapters (no TUN/TAP may appear), DNS servers per interface, and the hosts file. Needs no admin.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Compare
)
$ErrorActionPreference = 'Stop'

$inet = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$snapshot = [ordered]@{
  systemProxy = [ordered]@{
    ProxyEnable   = $inet.ProxyEnable
    ProxyServer   = $inet.ProxyServer
    ProxyOverride = $inet.ProxyOverride
    AutoConfigURL = $inet.AutoConfigURL
    AutoDetect    = $inet.AutoDetect
  }
  winHttpProxy = ((netsh winhttp show proxy) -join "`n").Trim()
  routes = @(Get-NetRoute -ErrorAction SilentlyContinue |
    Sort-Object AddressFamily, DestinationPrefix, NextHop, InterfaceAlias |
    ForEach-Object { "$($_.AddressFamily) $($_.DestinationPrefix) via $($_.NextHop) on $($_.InterfaceAlias) metric $($_.RouteMetric)" })
  adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
    Sort-Object Name |
    ForEach-Object { "$($_.Name) | $($_.InterfaceDescription) | $($_.Status)" })
  dnsServers = @(Get-DnsClientServerAddress -ErrorAction SilentlyContinue |
    Where-Object { $_.ServerAddresses } |
    Sort-Object InterfaceAlias, AddressFamily |
    ForEach-Object { "$($_.InterfaceAlias) $($_.AddressFamily): $($_.ServerAddresses -join ',')" })
  hostsSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath "$env:SystemRoot\System32\drivers\etc\hosts").Hash
}
$snapshot | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Out -Encoding UTF8

if ($Compare) {
  $before = Get-Content -LiteralPath $Compare -Raw | ConvertFrom-Json
  $after = Get-Content -LiteralPath $Out -Raw | ConvertFrom-Json
  $changed = @()
  foreach ($key in 'systemProxy', 'winHttpProxy', 'routes', 'adapters', 'dnsServers', 'hostsSha256') {
    $a = $before.$key | ConvertTo-Json -Depth 5 -Compress
    $b = $after.$key | ConvertTo-Json -Depth 5 -Compress
    if ($a -ne $b) {
      $changed += $key
      if ($before.$key -is [array]) {
        Compare-Object @($before.$key) @($after.$key) | ForEach-Object { Write-Output "  $key $($_.SideIndicator) $($_.InputObject)" }
      } else {
        Write-Output "  $key before: $a"
        Write-Output "  $key after:  $b"
      }
    }
  }
  if ($changed.Count -eq 0) { Write-Output 'unchanged'; exit 0 }
  Write-Output "changed: $($changed -join ', ')"
  exit 1
}
