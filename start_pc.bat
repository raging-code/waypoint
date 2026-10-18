@echo off
rem Windows launcher: creates the virtual environment on first run, then starts Waypoint.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    py -3 -m venv .venv
    if errorlevel 1 (
        echo Python 3 was not found. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
        pause
        exit /b 1
    )
)

".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
if not exist ".env" copy ".env.example" ".env" >nul

".venv\Scripts\python.exe" run.py
pause
