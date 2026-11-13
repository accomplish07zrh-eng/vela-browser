# Packet-level DNS leak check for the live leak probe (Windows, run from an elevated PowerShell).
#
#   powershell -ExecutionPolicy Bypass -File scripts/leak-check/pktmon-dns.ps1
#
# Captures every packet on this computer to or from the DNS-related ports (DNS 53, DNS-over-TLS
# 853, mDNS 5353, LLMNR 5355, NetBIOS name service 137) while `bun test src/leak-live.test.ts`
# runs, then searches the capture for the probe's names. The probe uses unique names under
# vela-leak.test, so any packet that carries one is a lookup this computer made for a page.
# DNS-over-HTTPS is covered by the probe itself: it fails if the browser opens any connection
# that is not to the loopback relay.
#
# The environment variables the probe needs (VELA_LEAK_LIVE, VELA_LEAK_CHROMIUM,
# VELA_LEAK_FIREFOX) are read from this shell; defaults point at the installed Vela runtimes.
param(
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$WorkDir = (Join-Path $env:TEMP "vela-pktmon-$(Get-Date -Format yyyyMMdd-HHmmss)")
)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'pktmon needs an elevated PowerShell (Run as administrator).'
}
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$etl = Join-Path $WorkDir 'dns.etl'
$pcap = Join-Path $WorkDir 'dns.pcapng'

if (-not $env:VELA_LEAK_LIVE) { $env:VELA_LEAK_LIVE = '1' }
if (-not $env:VELA_LEAK_CHROMIUM) {
  $chromium = Get-ChildItem -Path (Join-Path $env:APPDATA 'com.velabrowser.desktop\runtimes') -Filter chrome.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($chromium) { $env:VELA_LEAK_CHROMIUM = $chromium.FullName }
}
if (-not $env:VELA_LEAK_FIREFOX) {
  $firefox = Join-Path $env:LOCALAPPDATA 'Vela Browser\firefox\aliasmode.exe'
  if (Test-Path $firefox) { $env:VELA_LEAK_FIREFOX = $firefox }
}
$node = Join-Path $env:LOCALAPPDATA 'Vela Browser\playwright\node'
if (Test-Path $node) { $env:PATH = "$node;$env:PATH" }

pktmon filter remove | Out-Null
foreach ($port in 53, 853, 5353, 5355, 137) { pktmon filter add "port$port" -p $port | Out-Null }
pktmon start --capture --pkt-size 0 --file-name $etl | Out-Null
try {
  # Positive control: a lookup this script makes itself must show up in the capture.
  Resolve-DnsName -Name 'pktmon-control.vela-ctrl.test' -DnsOnly -ErrorAction SilentlyContinue | Out-Null
  Push-Location $Repo
  bun test src/leak-live.test.ts
  $testExit = $LASTEXITCODE
} finally {
  Pop-Location
  pktmon stop | Out-Null
  pktmon filter remove | Out-Null
}
pktmon etl2pcap $etl --out $pcap | Out-Null

# DNS names travel as labels: 9 "vela-leak" 4 "test".
$bytes = [System.IO.File]::ReadAllBytes($pcap)
$text = [System.Text.Encoding]::GetEncoding('ISO-8859-1').GetString($bytes)
$label = [char]9 + 'vela-leak' + [char]4 + 'test'
$hits = ([regex]::Matches($text, [regex]::Escape($label))).Count
$plain = ([regex]::Matches($text, 'vela-leak')).Count
$control = ([regex]::Matches($text, [regex]::Escape([char]9 + 'vela-ctrl' + [char]4 + 'test'))).Count
Write-Output "probe test exit code: $testExit"
Write-Output "positive control packets: $control"
if ($control -eq 0) { Write-Output 'INVALID: the capture missed the control lookup, so it proves nothing.'; exit 2 }
Write-Output "capture: $pcap ($([math]::Round($bytes.Length / 1KB)) KB)"
Write-Output "packets carrying a probe name: $hits (any 'vela-leak' bytes: $plain)"
if ($hits -gt 0 -or $plain -gt 0) { Write-Output 'LEAK: this computer sent a DNS-family packet for a probe name.'; exit 1 }
Write-Output 'no DNS-family packet carried a probe name'
exit $testExit
