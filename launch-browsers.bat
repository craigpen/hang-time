@echo off
echo Starting Hang Time Dual Edge Instances...

REM Kill any old instances if running on ports
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":9222 "') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":9223 "') do taskkill /f /pid %%a >nul 2>&1

REM Clean stale lock files
del /f /q "%USERPROFILE%\.hangtime-edge-profile2\LOCK" >nul 2>&1
del /f /q "%USERPROFILE%\.hangtime-edge-profile3\LOCK" >nul 2>&1
del /f /q "%USERPROFILE%\.hangtime-edge-profile2\Default\LOCK" >nul 2>&1
del /f /q "%USERPROFILE%\.hangtime-edge-profile3\Default\LOCK" >nul 2>&1

echo Launching Instance 1 (Profile 2 - Port 9222)...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="%USERPROFILE%\.hangtime-edge-profile2" --load-extension="%~dp0dist\chrome-mv3" --no-first-run --no-default-browser-check --new-window "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

timeout /t 2 /nobreak >nul

echo Launching Instance 2 (Profile 3 - Port 9223)...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9223 --remote-allow-origins=* --user-data-dir="%USERPROFILE%\.hangtime-edge-profile3" --load-extension="%~dp0dist\chrome-mv3" --no-first-run --no-default-browser-check --new-window "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

echo Done! Both windows are now open on your desktop.
