@echo off
cd /d "%~dp0"
py -3 scripts\serve.py --port 8940
pause
