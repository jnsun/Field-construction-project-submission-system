@echo off
setlocal
cd /d "%~dp0"
set "BASH="
if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles%\Git\mingw64\bin\bash.exe" set "BASH=%ProgramFiles%\Git\mingw64\bin\bash.exe"
if not defined BASH if exist "%USERPROFILE%\.workbuddy\binaries\PortableGit\versions\1.2.0\bin\bash.exe" set "BASH=%USERPROFILE%\.workbuddy\binaries\PortableGit\versions\1.2.0\bin\bash.exe"
if not defined BASH for /f "delims=" %%P in ('where bash 2^>nul') do if not defined BASH set "BASH=%%P"
if not defined BASH (
  echo [ERROR] Git Bash not found. Install Git for Windows: https://git-scm.com/download/win
  pause
  exit /b 1
)
echo Using bash: %BASH%
"%BASH%" "%~dp0deploy.sh"
echo.
pause
