@echo off
chcp 65001 >nul
title DA5 均衡器
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
python "%~dp0da5_eq.py"
if errorlevel 1 pause
