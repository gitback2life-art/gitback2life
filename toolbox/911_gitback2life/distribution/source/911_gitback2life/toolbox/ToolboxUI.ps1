# 911_gitback2life desktop navigation for the original thirteen tools plus the explicitly authorized Email Communications tool.
# Windows PowerShell 5.1 / WinForms: no downloads, installs, privilege changes or new tools.
# Each button launches the EXISTING guided action, including its original confirmations.
$ErrorActionPreference = 'Stop'
function Get-GB2LDownloads {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
    $id = '{374DE290-123F-4565-9164-39C4925E467B}'
    $configured = $null
    try {
        $props = Get-ItemProperty -Path $key -ErrorAction Stop
        $entry = $props.PSObject.Properties[$id]
        if ($null -ne $entry) { $configured = [string]$entry.Value }
    } catch { }
    if ([string]::IsNullOrWhiteSpace($configured)) {
        $configured = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'
    }
    $folder = [Environment]::ExpandEnvironmentVariables($configured)
    if (-not [IO.Path]::IsPathRooted($folder)) { throw 'Downloads folder is not an absolute path' }
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) {
        New-Item -Path $folder -ItemType Directory -ErrorAction Stop | Out-Null
    }
    return [IO.Path]::GetFullPath($folder)
}

$script:root = Split-Path -Parent $PSScriptRoot
$script:running = $null
$script:activeGroup = 0
$script:zeroPrefix = $false
$script:groups = @(
    @{ Name='Incident Management'; Actions=@('Start incident','Find incidents','Review incident progress','Incident timeline','Stop incident') },
    @{ Name='Evidence Collection'; Actions=@('Record reported information','Record direct observation','Review evidence and risk','Collect public GitHub evidence (scope required)') },
    @{ Name='Reports & Evidence Packages'; Actions=@('Create evidence and decision reports','Draft unsent notice','Build manually reviewed evidence packet') },
    @{ Name='Domain Health'; Actions=@('Read public domain records (scope required)','Check domain against prior baseline (scope required)') },
    @{ Name='Website Redirect & Authenticity'; Actions=@('Check URL format (offline)','Live redirect chain (verified sandbox only)','Preview possible lookalike domains (offline)','Check lookalike DNS (scope required)') },
    @{ Name='Email Security'; Actions=@('Inspect saved suspicious email headers','Check domain SPF/DMARC/MX records (scope required)') },
    @{ Name='Account Recovery & Access'; Actions=@('Account recovery instructions (no logins)','Departing staff access review') },
    @{ Name='Organization Registers'; Actions=@('Prepare a register review request','Inspect prepared request','Review service/access registers','Prepare empty register','Submit request to owner console','Guided register editing','List prepared requests') },
    @{ Name='Directory Audit'; Actions=@('Review rescue directory records') },
    @{ Name='Website Code Analysis'; Actions=@('Find local source files','Run selected code flow scan','Static disclosure scan','Guided source scan','Review fetch and redirect code (static)') },
    @{ Name='Dependency Analysis'; Actions=@('Review local npm dependencies') },
    @{ Name='File Protection'; Actions=@('Preview backup selection','Make reviewed local backup','Prepare restore review request (does not restore)','Make cleaned screenshot copies') },
    @{ Name='Computer Security Check'; Actions=@('Review a client security report ZIP','Check this computer (optional)') },
    @{ Name='Email Communications'; Actions=@('Prepare, review and authorize an outgoing incident email') }
)
function Color([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
function Log-UIError([string]$summary) {
    try {
        # Diagnostic only: report the interface failure; never collect incident data.
        $logs = Join-Path $script:root 'Temp\Logs'
        if (-not (Test-Path -LiteralPath $logs)) { New-Item -ItemType Directory -Path $logs -Force | Out-Null }
        $id = [Guid]::NewGuid().ToString('N').Substring(0, 12)
        $log = Join-Path $logs ('ui_error_' + $id + '.log')
        [IO.File]::WriteAllText($log, ('[{0}] UI failed: {1}' -f [DateTime]::UtcNow.ToString('o'), $summary))
        $downloads = Get-GB2LDownloads
        $zip = Join-Path $downloads ('GB2L_TOOLBOX_UI_ERROR_' + $id + '.zip')
        Compress-Archive -LiteralPath $log -DestinationPath $zip -CompressionLevel Optimal -ErrorAction Stop
    } catch { }
}
function Notify-Error([string]$summary) {
    Log-UIError $summary
    [System.Windows.Forms.MessageBox]::Show($summary, '911 GitBack2Life',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}
function New-Tile([string]$caption, [int]$number, [int]$height) {
    $button = New-Object System.Windows.Forms.Button
    $button.Tag = $number
    $button.Text = $caption
    $button.Size = [System.Drawing.Size]::new(288, $height)
    $button.Margin = [System.Windows.Forms.Padding]::new(7)
    $button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $button.FlatAppearance.BorderSize = 1
    $button.FlatAppearance.BorderColor = Color '#2D3D58'
    $button.FlatAppearance.MouseOverBackColor = Color '#233954'
    $button.BackColor = Color '#17283F'
    $button.ForeColor = Color '#F4F7FD'
    $button.Font = [System.Drawing.Font]::new('Segoe UI', 11, [System.Drawing.FontStyle]::Regular)
    $button.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
    $button.Padding = [System.Windows.Forms.Padding]::new(14, 0, 8, 0)
    $button.Cursor = [System.Windows.Forms.Cursors]::Hand
    $button.TabStop = $true
    return $button
}
function Adjust-Tiles {
    if ($null -eq $script:tiles) { return }
    $columns = if ($script:activeGroup -eq 0) { 3 } else { 2 }
    $available = [Math]::Max(320, $script:tiles.ClientSize.Width - $script:tiles.Padding.Left - $script:tiles.Padding.Right - 24)
    if ($available -lt ($columns * 230)) { $columns = 2 }
    if ($available -lt 460) { $columns = 1 }
    $width = [Math]::Max(220, [Math]::Floor($available / $columns) - 15)
    foreach ($control in $script:tiles.Controls) { $control.Width = $width }
}
function Show-Home {
    $script:activeGroup = 0
    $script:zeroPrefix = $false
    $script:heading.Text = 'Your 14 tools'
    $script:subtitle.Text = 'Choose a tool to see its existing actions.'
    $script:back.Visible = $false
    $script:footer.Location = [System.Drawing.Point]::new(24, 9)
    $script:footer.Text = 'Mouse: click a tool     Keyboard: 1-9, or 0 then 1-5 for tools 10-14     Esc: exit'
    $script:tiles.SuspendLayout()
    $script:tiles.Controls.Clear()
    for ($i = 0; $i -lt $script:groups.Count; $i++) {
        $n = $i + 1
        $shortcut = if ($n -le 9) { "$n" } else { '0,' + ($n - 9) }
        $b = New-Tile ('{0:00}  {1}' -f $n, $script:groups[$i].Name) $n 82
        $b.AccessibleName = ('Tool {0}. {1}. Shortcut {2}' -f $n, $script:groups[$i].Name, $shortcut)
        $b.Add_Click({ param($sender, $eventArgs) Show-Actions ([int]$sender.Tag) })
        [void]$script:tiles.Controls.Add($b)
    }
    $script:tiles.ResumeLayout()
    Adjust-Tiles
}
function Show-Actions([int]$groupNumber) {
    if ($groupNumber -lt 1 -or $groupNumber -gt 14) { return }
    $script:activeGroup = $groupNumber
    $script:zeroPrefix = $false
    $group = $script:groups[$groupNumber - 1]
    $script:heading.Text = $group.Name
    $script:subtitle.Text = 'Select an action. Existing safety checks and confirmation prompts remain in place.'
    $script:back.Visible = $true
    $script:footer.Location = [System.Drawing.Point]::new(200, 9)
    $script:footer.Text = 'Mouse: click an action     Keyboard: action number 1-' + $group.Actions.Count + '     0 or Esc: back'
    $script:tiles.SuspendLayout()
    $script:tiles.Controls.Clear()
    for ($i = 0; $i -lt $group.Actions.Count; $i++) {
        $n = $i + 1
        $b = New-Tile ('{0:00}  {1}' -f $n, $group.Actions[$i]) $n 88
        $b.AccessibleName = ('Action {0}. {1}' -f $n, $group.Actions[$i])
        $b.Add_Click({ param($sender, $eventArgs) Start-Action ([int]$sender.Tag) })
        [void]$script:tiles.Controls.Add($b)
    }
    $script:tiles.ResumeLayout()
    Adjust-Tiles
}
function Start-Action([int]$actionNumber) {
    $group = $script:activeGroup
    if ($group -lt 1 -or $group -gt 14 -or $actionNumber -lt 1 -or
        $actionNumber -gt $script:groups[$group - 1].Actions.Count) { return }
    try {
        if ($null -ne $script:running -and -not $script:running.HasExited) {
            [System.Windows.Forms.MessageBox]::Show('Finish the open toolbox action before starting another.',
                '911 GitBack2Life', [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
            return
        }
        $launcher = Join-Path $script:root 'TOOLBOX.cmd'
        if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'The toolbox launcher was not found.' }
        $shell = $env:ComSpec
        if (-not $shell -or -not (Test-Path -LiteralPath $shell -PathType Leaf)) { throw 'Windows Command Processor was not found.' }
        $info = New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName = $shell
        # The only inserted values are validated integers 1-14 and 1-7.
        # The file path is fixed to this staged copy and is enclosed in quotes.
        $info.Arguments = ('/d /c ""{0}" --menu-action {1} {2}"' -f $launcher, $group, $actionNumber)
        $info.WorkingDirectory = $script:root
        $info.UseShellExecute = $true
        $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
        $script:running = [System.Diagnostics.Process]::Start($info)
        if ($null -eq $script:running) { throw 'The selected action could not start.' }
        $script:footer.Text = 'Action opened in its own guided window. Complete it before opening another action.'
    } catch { Notify-Error ('Could not launch this existing action: ' + $_.Exception.Message) }
}
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $script:form = New-Object System.Windows.Forms.Form
    $script:form.Text = '911 GitBack2Life Toolbox'
    $script:form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $script:form.Size = [System.Drawing.Size]::new(1020, 730)
    $script:form.MinimumSize = [System.Drawing.Size]::new(620, 525)
    $script:form.BackColor = Color '#0D1829'
    $script:form.ForeColor = Color '#F4F7FD'
    $script:form.Font = [System.Drawing.Font]::new('Segoe UI', 10)
    $script:form.KeyPreview = $true

    $bar = New-Object System.Windows.Forms.Panel
    $bar.Dock = [System.Windows.Forms.DockStyle]::Top
    $bar.Height = 125
    $bar.Padding = [System.Windows.Forms.Padding]::new(22, 15, 22, 0)
    $script:form.Controls.Add($bar)

    $brand = New-Object System.Windows.Forms.Label
    $brand.Text = '911  /  GITBACK2LIFE'
    $brand.Dock = [System.Windows.Forms.DockStyle]::Top
    $brand.Height = 23
    $brand.ForeColor = Color '#65D6BD'
    $brand.Font = [System.Drawing.Font]::new('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
    $bar.Controls.Add($brand)

    $script:heading = New-Object System.Windows.Forms.Label
    $script:heading.Location = [System.Drawing.Point]::new(22, 40)
    $script:heading.AutoSize = $false
    $script:heading.Width = 920
    $script:heading.Height = 42
    $script:heading.Font = [System.Drawing.Font]::new('Segoe UI', 22, [System.Drawing.FontStyle]::Bold)
    $script:heading.ForeColor = Color '#FFFFFF'
    $script:heading.Anchor = [System.Windows.Forms.AnchorStyles]'Top,Left,Right'
    $bar.Controls.Add($script:heading)

    $script:subtitle = New-Object System.Windows.Forms.Label
    $script:subtitle.Location = [System.Drawing.Point]::new(24, 89)
    $script:subtitle.Width = 920
    $script:subtitle.Height = 25
    $script:subtitle.ForeColor = Color '#A7B9CE'
    $script:subtitle.Anchor = [System.Windows.Forms.AnchorStyles]'Top,Left,Right'
    $bar.Controls.Add($script:subtitle)

    $bottom = New-Object System.Windows.Forms.Panel
    $bottom.Dock = [System.Windows.Forms.DockStyle]::Bottom
    $bottom.Height = 70
    $bottom.Padding = [System.Windows.Forms.Padding]::new(22, 8, 22, 10)
    $script:form.Controls.Add($bottom)

    $script:footer = New-Object System.Windows.Forms.Label
    $script:footer.Location = [System.Drawing.Point]::new(24, 9)
    $script:footer.Width = 920
    $script:footer.Height = 44
    $script:footer.AutoEllipsis = $true
    $script:footer.Anchor = [System.Windows.Forms.AnchorStyles]'Top,Left,Right'
    $script:footer.ForeColor = Color '#AFBED0'
    $bottom.Controls.Add($script:footer)

    $script:back = New-Object System.Windows.Forms.Button
    $script:back.Text = '< Back to tools'
    $script:back.Size = [System.Drawing.Size]::new(155, 33)
    $script:back.Location = [System.Drawing.Point]::new(24, 10)
    $script:back.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $script:back.FlatAppearance.BorderSize = 0
    $script:back.BackColor = Color '#17283F'
    $script:back.ForeColor = Color '#E6EFF8'
    $script:back.Cursor = [System.Windows.Forms.Cursors]::Hand
    $script:back.Add_Click({ Show-Home })
    $bottom.Controls.Add($script:back)
    $script:back.BringToFront()

    $script:tiles = New-Object System.Windows.Forms.FlowLayoutPanel
    $script:tiles.Location = [System.Drawing.Point]::new(12, 132)
    $script:tiles.Size = [System.Drawing.Size]::new($script:form.ClientSize.Width - 24, $script:form.ClientSize.Height - 214)
    $script:tiles.Anchor = [System.Windows.Forms.AnchorStyles]'Top,Bottom,Left,Right'
    $script:tiles.Padding = [System.Windows.Forms.Padding]::new(18, 14, 8, 10)
    $script:tiles.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
    $script:tiles.WrapContents = $true
    $script:tiles.AutoScroll = $true
    $script:tiles.BackColor = Color '#0D1829'
    $script:form.Controls.Add($script:tiles)

    $script:form.Add_KeyDown({ param($sender, $e)
        if ($e.Control -or $e.Alt) { return }
        if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
            if ($script:zeroPrefix) { $script:zeroPrefix = $false; Show-Home }
            elseif ($script:activeGroup -ne 0) { Show-Home }
            else { $script:form.Close() }
            $e.SuppressKeyPress = $true
            return
        }
        $keyText = $e.KeyCode.ToString()
        if ($keyText -notmatch '^(?:D|NumPad)([0-9])$') { return }
        $digit = [int]$matches[1]
        $e.SuppressKeyPress = $true
        if ($script:activeGroup -ne 0) {
            if ($digit -eq 0) { Show-Home }
            elseif ($digit -le $script:groups[$script:activeGroup - 1].Actions.Count) { Start-Action $digit }
            return
        }
        if ($script:zeroPrefix) {
            $script:zeroPrefix = $false
            if ($digit -ge 1 -and $digit -le 5) { Show-Actions (9 + $digit) }
            else { Show-Home }
        } elseif ($digit -eq 0) {
            $script:zeroPrefix = $true
            $script:footer.Text = 'Press 1 for tool 10, 2 for tool 11, 3 for tool 12, or 4 for tool 13, 5 for tool 14. Esc cancels.'
        } else { Show-Actions $digit }
    })
    $script:tiles.Add_Resize({ Adjust-Tiles })
    Show-Home
    [System.Windows.Forms.Application]::Run($script:form)
} catch {
    Log-UIError $_.Exception.Message
    try {
        [System.Windows.Forms.MessageBox]::Show(('Toolbox interface could not start: ' + $_.Exception.Message),
            '911 GitBack2Life', [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    } catch { }
    exit 2
}
