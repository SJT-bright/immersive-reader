@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
if "%READER_PORT%"=="" set READER_PORT=8940

where node >nul 2>&1
if errorlevel 1 goto trypython
node -e "process.exit(parseInt(process.versions.node,10)>=16?0:1)" >nul 2>&1
if errorlevel 1 goto trypython
set READER_LOCAL=1
set PORT=%READER_PORT%
node cloud\server.js %*
if errorlevel 1 pause
exit /b %ERRORLEVEL%

:trypython
where py >nul 2>&1
if errorlevel 1 goto trypython3
py -3 scripts\serve.py --port %READER_PORT% %*
if errorlevel 1 pause
exit /b %ERRORLEVEL%

:trypython3
where python >nul 2>&1
if errorlevel 1 goto missing
python scripts\serve.py --port %READER_PORT% %*
if errorlevel 1 pause
exit /b %ERRORLEVEL%

:missing
echo 需要 Node.js 16+（推荐 22.5+）或 Python 3，安装其中之一后重试：
echo   Node.js  https://nodejs.org/
echo   Python   https://www.python.org/
pause
exit /b 1
