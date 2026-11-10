@echo off
rem Builds the full Open Karaoke installer: an NSIS setup .exe that ships the
rem tools (yt-dlp, Deno) and every AI model (~1.1 GB), so it works on another
rem PC without downloading anything first. They are taken from this PC's app
rem data, so open the app once and use every feature (separate a song, Fit
rem lyrics) before building. Double-click it, or run it from any terminal.
rem The first build takes a while (15-30 min).
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "LIBCLANG_PATH=%USERPROFILE%\.local\libclang\clang\native"
set "CPAL_ASIO_DIR=%USERPROFILE%\.local\asiosdk\ASIOSDK"

set "SRC=%APPDATA%\app.openkaraoke.desktop\bin"
set "DST=%~dp0src-tauri\bundled\bin"
for %%F in (yt-dlp.exe deno.exe models\UVR-MDX-NET-Inst_HQ_3.onnx models\ggml-large-v3-turbo-q5_0.bin models\mms-300m-fa-int8.onnx models\swift-f0.onnx) do (
  if not exist "%SRC%\%%F" (
    echo Missing %SRC%\%%F
    echo Open the app and use it once ^(separate a song, press Fit lyrics^) so it downloads everything, then build again.
    pause
    exit /b 1
  )
)
echo Gathering tools and models into src-tauri\bundled ...
robocopy "%SRC%" "%DST%" /E /XF .ytdlp-updated *.download *.part *.adopt /NFL /NDL /NJH /NJS /NP
if errorlevel 8 (
  echo Copying the models failed.
  pause
  exit /b 1
)

call npm run dist -- --config src-tauri/tauri.bundle.conf.json
if errorlevel 1 (
  echo.
  echo Build failed. Scroll up for the error.
  pause
  exit /b 1
)
echo.
echo Done. The installer is in src-tauri\target\release\bundle\nsis
start "" "%~dp0src-tauri\target\release\bundle\nsis"
pause
