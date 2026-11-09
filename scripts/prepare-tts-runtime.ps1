param([string]$BuildPython = 'python')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $projectRoot '.runtime\tts-python'
$archivePath = Join-Path $projectRoot '.runtime\python-3.13.17-embed-amd64.zip'
if (Test-Path -LiteralPath $runtimePath) { throw 'Runtime directory already exists; preserve it and move it aside before preparing a replacement.' }
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
try {
    Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.13.17/python-3.13.17-embed-amd64.zip' -OutFile $archivePath
    Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimePath
    # Embeddable Python ignores PYTHONPATH: declare the private dependencies explicitly.
    [System.IO.File]::WriteAllText((Join-Path $runtimePath 'python313._pth'), "python313.zip`n.`nLib/site-packages`n", [System.Text.Encoding]::ASCII)
    & $BuildPython -m pip install --disable-pip-version-check --ignore-installed --no-compile --only-binary=:all: --platform win_amd64 --python-version 3.13 --implementation cp --abi cp313 --target (Join-Path $runtimePath 'Lib\site-packages') -r (Join-Path $projectRoot 'requirements-tts.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Installing the bundled TTS dependencies failed. The partial runtime is retained for diagnosis.' }
} finally {
    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath }
}
Write-Output 'Windows x64 TTS runtime prepared. No application or installer checks were run.'
