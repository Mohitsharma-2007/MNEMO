[CmdletBinding()]
param(
    [string]$BindHost = "127.0.0.1",
    [ValidateRange(1, 65535)]
    [int]$Port = 8000,
    [string]$Graph
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $projectRoot ".venv\Scripts\python.exe"

if (Test-Path -LiteralPath $venvPython -PathType Leaf) {
    $python = $venvPython
    $pythonPrefixArguments = @()
} else {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        $python = $pythonCommand.Source
        $pythonPrefixArguments = @()
    } else {
        $pyCommand = Get-Command py -ErrorAction SilentlyContinue
        if (-not $pyCommand) {
            throw "Python was not found. Install Python 3.11+ or create .venv in the Mnemo directory."
        }
        $python = $pyCommand.Source
        $pythonPrefixArguments = @("-3")
    }
}

$arguments = @($pythonPrefixArguments + @(
    "-m",
    "mnemo",
    "serve",
    "--host",
    $BindHost,
    "--port",
    $Port.ToString()
))

if ($Graph) {
    $graphPath = if ([IO.Path]::IsPathRooted($Graph)) {
        $Graph
    } else {
        Join-Path (Get-Location) $Graph
    }
    $arguments += @("--graph", $graphPath)
}

Push-Location $projectRoot
try {
    & $python @arguments
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}
