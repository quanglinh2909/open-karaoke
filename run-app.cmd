@echo off
rem Starts Open Karaoke in development mode (tauri dev) with the build
rem environment this machine needs. Double-click it, or run it from any terminal.
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "LIBCLANG_PATH=%USERPROFILE%\.local\libclang\clang\native"
set "CPAL_ASIO_DIR=%USERPROFILE%\.local\asiosdk\ASIOSDK"
call npm run app
pause
