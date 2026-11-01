@echo off
chcp 936 >nul
title JT Browser
cd /d "%~dp0"

echo.
echo   ============================================
echo    JT Browser  -  JT 层级 + 线框预览
echo   ============================================
echo.

set "PY=python"
where python >nul 2>nul || (
    echo  [!] 找不到 python，请先安装 Python 3.9+ 并加入 PATH
    pause & exit /b 1
)

echo   启动服务: http://127.0.0.1:8770
echo   关闭本窗口即停止服务
echo.

start "" "http://127.0.0.1:8770/"
"%PY%" app.py
pause
