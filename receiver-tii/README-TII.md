# TII integration

Receiver base: KejPi/AbracaDABra tag v4.3.0, commit 5ebc91a832d950a8e378fb123b7b31cd0b013198.
Apply receiver-tii.patch to expose a `tii` object from `/api/status`.
The existing slideshow experimental patch is deliberately NOT included.

TII detections use the original decoder in default mode. The API provides main/sub IDs, relative level, and age. Detections expire after 10 seconds and are cleared at tuning, ensemble changes and loss of full synchronization. Multiple transmitter database matches are preserved.

The web server reads a locally imported `transmitters.csv`, or the local AbracaDABra cache at `%LOCALAPPDATA%/AbracaDABra/cache/TII/dab-tx-list.csv`. It matches frequency, ECC, EID and both TII IDs. Database contents are not redistributed. The country/ECC mapping follows AbracaDABra's MIT-licensed TxDataLoader.

Build environment: Qt 6.7.3 MinGW, MinGW 13.1, CMake, Ninja; MSYS2 import libraries/headers for rtl-sdr, libusb, faad2, mpg123 and lame. The runtime keeps the existing filtered RTL-SDR wrapper and original DLL. Use a separate runtime and preserve the prior receiver for rollback.

Tests: database matching across channels/countries, multiple sites, invalid import preservation, missing synchronization; desktop/mobile UI with mocked detections. Native build and real RF validation passed: 5B NAM-LUX 1, TII 03-01 (Bouillon) and 03-07 (Leglise/Anlier), MP3 stream available; detections cleared on retune to 7D. Deployed locally on 2026-11-02.

Portable ZIP 0.4 includes the compiled receiver and matching runtime. The binary manifest is runtime-manifest.json. Corresponding sources and build notes are distributed as Receiver-TII-Sources-0.4.zip alongside the Windows ZIP. The runtime is for CLI use; it is not a replacement desktop GUI package.
