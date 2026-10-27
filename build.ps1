$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
python -m PyInstaller --noconfirm --clean --windowed --onedir --exclude-module numpy --exclude-module charset_normalizer --name Live-Monitor --add-data 'index.html;.' --add-data 'app.js;.' --add-data 'style.css;.' --add-data 'station-sites.json;.' --add-data 'filter;filter' --add-data 'THIRD-PARTY;THIRD-PARTY' launcher.py
if ($LASTEXITCODE -ne 0) { throw 'Compilation impossible' }
Copy-Item README.md dist/Live-Monitor/LIRE-MOI.md
Copy-Item -Recurse THIRD-PARTY dist/Live-Monitor/THIRD-PARTY -Force
Compress-Archive -Path dist/Live-Monitor -DestinationPath dist/Live-Monitor-Windows-x64.zip -Force
