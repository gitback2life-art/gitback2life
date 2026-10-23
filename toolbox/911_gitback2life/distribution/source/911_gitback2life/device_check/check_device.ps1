# device_check: read-only security status of the Windows PC used to help an organization.
# Adapted from the gitback2life security suite device collector. Reads status only; changes nothing.
# Never calls BitLocker key-protector or recovery-password methods. Prints a JSON report to the console.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File device_check\check_device.ps1
#
# Test mode (used by device_check.test.mjs): judge sample settings from a file instead of reading this PC.
#   ... -File device_check\check_device.ps1 -InputJson sample.json
#
# Exit codes: 0 = all pass, 1 = a check failed, 3 = some checks need a manual look.
param([string]$InputJson)
$ErrorActionPreference = 'Stop'

# Part 1: READ. Collects raw facts only. Anything that cannot be read stays $null.
function Get-DeviceStatus {
    $status = [ordered]@{ defender = $null; bitlocker = $null; firewall = $null; lock_timeout_secs = $null }
    try {
        $mp = Get-MpComputerStatus
        $status.defender = [ordered]@{
            antivirus_enabled = [bool]$mp.AntivirusEnabled; realtime_enabled = [bool]$mp.RealTimeProtectionEnabled
            service_enabled = [bool]$mp.AMServiceEnabled; signature_age_days = $mp.AntivirusSignatureAge
        }
    } catch { }
    try {
        # Status methods only.
        $vol = Get-CimInstance -Namespace 'root/CIMV2/Security/MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -Filter "DriveLetter='$env:SystemDrive'"
        if ($null -ne $vol) {
            $protection = Invoke-CimMethod -InputObject $vol -MethodName GetProtectionStatus
            $encryption = Invoke-CimMethod -InputObject $vol -MethodName GetConversionStatus
            if ($protection.ReturnValue -eq 0 -and $encryption.ReturnValue -eq 0) {
                $status.bitlocker = [ordered]@{ protection_status = [int]$protection.ProtectionStatus; conversion_status = [int]$encryption.ConversionStatus }
            }
        }
    } catch { }
    try {
        $off = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled })
        $status.firewall = [ordered]@{ all_enabled = ($off.Count -eq 0) }
    } catch { }
    try {
        $status.lock_timeout_secs = [int](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name InactivityTimeoutSecs).InactivityTimeoutSecs
    } catch { }
    return $status
}

# Part 2: DECIDE. Turns raw facts into checks. Pure: same facts in, same checks out.
function Get-DeviceChecks($status) {
    $checks = [System.Collections.Generic.List[object]]::new()
    function Push-Check([string]$Id, [string]$Result, [string]$Category) {
        $checks.Add([ordered]@{ id = $Id; result = $Result; category = $Category; reference = $null })
    }
    $d = $status.defender
    if ($null -eq $d) {
        Push-Check 'malware_protection' 'unresolved' 'unsupported_or_denied'
        Push-Check 'signature_freshness' 'unresolved' 'unsupported_or_denied'
    } else {
        if ($d.antivirus_enabled -and $d.realtime_enabled -and $d.service_enabled) { Push-Check 'malware_protection' 'pass' 'defender_enabled' }
        else { Push-Check 'malware_protection' 'unresolved' 'review_other_provider_or_disabled_protection' }
        if ($null -ne $d.signature_age_days -and [int]$d.signature_age_days -le 2) { Push-Check 'signature_freshness' 'pass' 'defender_signatures_recent' }
        else { Push-Check 'signature_freshness' 'unresolved' 'definition_age_review' }
    }
    $b = $status.bitlocker
    if ($null -eq $b) { Push-Check 'system_disk_encryption' 'unresolved' 'unsupported_or_needs_admin' }
    elseif ([int]$b.protection_status -eq 1 -and [int]$b.conversion_status -eq 1) { Push-Check 'system_disk_encryption' 'pass' 'bitlocker_protection_on' }
    else { Push-Check 'system_disk_encryption' 'fail' 'system_disk_not_fully_protected' }
    $f = $status.firewall
    if ($null -eq $f) { Push-Check 'firewall' 'unresolved' 'unsupported_or_denied' }
    elseif ($f.all_enabled) { Push-Check 'firewall' 'pass' 'all_profiles_enabled' }
    else { Push-Check 'firewall' 'fail' 'a_firewall_profile_is_off' }
    $t = $status.lock_timeout_secs
    if ($null -ne $t -and [int]$t -gt 0 -and [int]$t -le 900) { Push-Check 'machine_lock_policy' 'pass' 'configured_within_fifteen_minutes' }
    else { Push-Check 'machine_lock_policy' 'unresolved' 'manual_effective_lock_check' }
    Push-Check 'effective_screen_lock' 'unresolved' 'manually_test_lock_and_unlock_authentication'
    Push-Check 'supported_updates' 'unresolved' 'manually_verify_supported_os_and_windows_update'
    return , $checks.ToArray()
}

if ($InputJson) {
    $item = Get-Item -LiteralPath $InputJson
    if ($item.Length -gt 102400) { throw 'Test input is larger than 100 KB' }
    $status = Get-Content -LiteralPath $InputJson -Raw | ConvertFrom-Json
    $environment = 'test_fixture'   # never mistaken for evidence about a real device
} else {
    $status = Get-DeviceStatus
    $environment = 'local_device'
}
$checks = Get-DeviceChecks $status
$states = @($checks | ForEach-Object { $_.result })
$result = 'pass'
if ($states -contains 'unresolved') { $result = 'unresolved' }
if ($states -contains 'fail') { $result = 'fail' }
$report = [ordered]@{ schema_version = 1; tool_version = '1.1.0'; tool = 'device'; observed_at = [DateTimeOffset]::UtcNow.ToString('o'); source_version = 'device-status-v1'; environment = $environment; result = $result; checks = $checks }
$report | ConvertTo-Json -Depth 8
if ($result -eq 'fail') { exit 1 } elseif ($result -eq 'unresolved') { exit 3 } else { exit 0 }
