@echo off
cd /d "%~dp0"
where python3 >nul 2>nul
if %errorlevel% equ 0 (
    python3 install.py
    exit /b 0
)
where python >nul 2>nul
if %errorlevel% equ 0 (
    python install.py
    exit /b 0
)
echo Python not found. Downloading installer...
powershell -Command "Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe' -OutFile '%TEMP%\python-installer.exe'"
"%TEMP%\python-installer.exe" /quiet InstallAllUsers=0 PrependPath=1
echo Python installed. Please re-run install.bat.
