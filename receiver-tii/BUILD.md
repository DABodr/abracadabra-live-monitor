# Receiver TII 0.4: sources and build

Full modified AbracaDABra source is based on v4.3.0, commit
5ebc91a832d950a8e378fb123b7b31cd0b013198. The source already includes the TII
patch: do not apply twice. The RTL filter wrapper source is in filter/.
Library source archives retain their copyright and license notices.
libdabsdr is supplied by its author as an MIT-licensed binary SDK; headers
and license are in the receiver source lib/ directory.

## Build

Use Windows x64, Qt 6.7.3 MinGW and MinGW 13.1, CMake and Ninja.
Qt modules: qtbase, qtdeclarative, qtmultimedia, qtsvg, qtpositioning,
qtlocation, qtshadertools, qtimageformats, qttools. Use shared libraries.
Build headers/import libraries for rtl-sdr, libusb, faad2, mpg123 and lame
into a dependency prefix. The MSYS2 source packages include PKGBUILD and
patches; build with makepkg-mingw in the MINGW64 environment.

With compiler bin and CMake/Ninja on PATH:

    cmake -S AbracaDABra-TII-4.3.0 -B build -G Ninja -DCMAKE_PREFIX_PATH=C:/Qt/6.7.3/mingw_64 -DEXTERNAL_LIBS_DIR=C:/deps/mingw64 -DUSE_PORTAUDIO=OFF -DFMLIST=OFF -DCMAKE_BUILD_TYPE=Release
    cmake --build build --parallel 2

The runtime is headless --cli, not a full desktop GUI distribution.
Qt sources are official v6.7.3 tags with bundled third-party sources.
Qt's CMake configuration/build instructions are inside those archives.

rtlsdr_original.dll is unchanged from official AbracaDABra 4.3.0; the API
reports old-dab 0.9.7.0, build February 15 2025. Source tag v0.9.7.0 is included.
Build with CMake and libusb. filter/sha256.json identifies the original DLL.
libusb reports 1.0.27.11882; v1.0.27 source is included.
GCC 13.1 and mingw-w64 v11 sources and MinGW-build-info.txt document the
compiler runtime. GCC Runtime Library Exception applies.
The wrapper is built as described in filter/README.md; it loads the original
RTL driver and only changes CLI tuner bandwidth handling.

Copy the receiver and DLL/plugins listed in runtime-manifest.json into
receiver-tii/runtime in the Live Monitor source tree. Include qt.conf and
all listed plugin directories. The manifest describes distributed binaries;
a fresh build with different tools need not produce identical hashes.
Regenerate the manifest for your rebuilt runtime before packaging.

The web application and launcher source are in the main release's source
archive; build.ps1 uses PyInstaller. sources.json lists library download URLs
and SHA-256 hashes. No personal configuration is included.
