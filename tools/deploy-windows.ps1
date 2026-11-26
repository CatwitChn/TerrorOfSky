<#
.SYNOPSIS
Downloads or updates Terror of Sky and serves the lobby and game on Windows.
.EXAMPLE
.\deploy-windows.ps1 -Port 3000
.EXAMPLE
.\deploy-windows.ps1 -PublicUrl https://play.example.com:8443
.EXAMPLE
.\tools\deploy-windows.ps1 -UseCheckout
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3000,
    [string]$BindAddress = '127.0.0.1',
    [string]$PublicUrl,
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'TerrorOfSky'),
    [string]$Repository = 'https://github.com/CatwitChn/TerrorOfSky.git',
    [switch]$UseCheckout
)

$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($UseCheckout) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'tools\local.mjs') -PathType Leaf)) {
        throw 'Use -UseCheckout with the script in the tools directory of a Terror of Sky checkout.'
    }
} else {
    $git = (Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue).Source
    if (-not $git) { throw 'Install Git for Windows and open a new PowerShell window.' }
}

$projectNode = Join-Path $projectRoot '.local\node\node.exe'
$node = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue).Source
if (Test-Path -LiteralPath $projectNode -PathType Leaf) {
    $node = (Resolve-Path -LiteralPath $projectNode).Path
}
if (-not $node) { throw 'Install Node.js 22 or later with npm and open a new PowerShell window.' }
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
    throw 'Node.js 22 or later is required.'
}
$npm = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) { throw "npm is missing from the Node.js installation at $node." }

$address = [System.Net.IPAddress]::Parse($BindAddress)
$listener = [System.Net.Sockets.TcpListener]::new($address, $Port)
try {
    $listener.ExclusiveAddressUse = $true
    $listener.Start()
} catch {
    throw "Cannot listen on ${BindAddress}:$Port. Stop the previous server or choose a free port. $($_.Exception.Message)"
} finally {
    $listener.Stop()
}

$installRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDirectory)
[void][System.IO.Directory]::CreateDirectory($installRoot)
try {
    $lock = [System.IO.File]::Open((Join-Path $installRoot 'run.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
} catch [System.IO.IOException] {
    throw "Cannot lock $installRoot. Check whether this installation is already running."
}

try {
    $source = $projectRoot
    if (-not $UseCheckout) {
        $source = Join-Path $installRoot 'source'
        if (Test-Path -LiteralPath $source) {
            if (-not (Test-Path -LiteralPath (Join-Path $source '.git') -PathType Container)) {
                throw "The source directory at $source is not a Git checkout. Choose a different install directory."
            }
            $origin = & $git -C $source remote get-url origin
            if ($LASTEXITCODE -ne 0 -or $origin -cne $Repository) {
                throw "The checkout at $source uses a different repository. Use its repository URL or choose a different install directory."
            }
            & $git -C $source pull --ff-only
            if ($LASTEXITCODE -ne 0) { throw 'Could not update the Terror of Sky checkout.' }
        } else {
            & $git clone --branch master --single-branch -- $Repository $source
            if ($LASTEXITCODE -ne 0) { throw 'Could not download the Terror of Sky repository.' }
        }
    }

    $server = Join-Path $source 'server'
    $entry = Join-Path $source 'tools\local.mjs'
    & $node $npm ci --prefix $server --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the locked server dependencies.' }

    $serverArgs = @($entry, '--host', $address.ToString(), '--port', $Port.ToString())
    if ($PublicUrl) {
        $serverArgs += @('--origin', $PublicUrl)
        Write-Host "Public lobby via reverse proxy at $($PublicUrl.TrimEnd('/'))/lobby/"
    }
    Write-Host 'Press Ctrl+C to stop the server.'
    & $node @serverArgs
    exit $LASTEXITCODE
} finally {
    $lock.Dispose()
}
