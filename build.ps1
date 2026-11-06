$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path receiver-tii/runtime/AbracaDABra.exe)) {
    throw 'Runtime TII manquant : voir receiver-tii/BUILD.md et README.md'
}
python -m PyInstaller --noconfirm --clean --windowed --onedir --exclude-module numpy --exclude-module charset_normalizer --name Live-Monitor --add-data 'index.html;.' --add-data 'app.js;.' --add-data 'style.css;.' --add-data 'station-sites.json;.' --add-data 'filter;filter' --add-data 'receiver-tii/runtime;receiver-tii/runtime' --add-data 'receiver-tii/runtime-manifest.json;receiver-tii' --add-data 'THIRD-PARTY;THIRD-PARTY' launcher.py
if ($LASTEXITCODE -ne 0) { throw 'Compilation impossible' }
Copy-Item README.md dist/Live-Monitor/LIRE-MOI.md
Copy-Item UPDATES-0.4.1.md dist/Live-Monitor/UPDATES-0.4.1.md
Copy-Item UPDATES-2026-11-04.md dist/Live-Monitor/UPDATES-2026-11-04.md
New-Item -ItemType Directory -Force dist/Live-Monitor/receiver-tii | Out-Null
Copy-Item receiver-tii/README-TII.md dist/Live-Monitor/receiver-tii/README-TII.md
Copy-Item receiver-tii/receiver-tii.patch dist/Live-Monitor/receiver-tii/receiver-tii.patch
Copy-Item -Recurse THIRD-PARTY dist/Live-Monitor/THIRD-PARTY -Force
Compress-Archive -Path dist/Live-Monitor -DestinationPath dist/Live-Monitor-Windows-x64.zip -Force
